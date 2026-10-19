import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinnedObject } from 'three/addons/utils/SkeletonUtils.js';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Bone3D, Pose3D, Skeleton3D } from '../motion3d/types.ts';
import { createDefaultSkeleton3D } from '../motion3d/retarget.ts';

export type BoneMapping3D = Partial<Record<Bone3D, string>>;
export interface CharacterRig3D {
  name: string;
  root: THREE.Group;
  bones: THREE.Bone[];
  mapping: BoneMapping3D;
  skeleton: Skeleton3D;
  rest: Map<THREE.Bone, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>;
  imported: boolean;
}

export const BONE_LABELS_3D: Record<Bone3D, string> = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', neck: 'Neck', head: 'Head',
  upperArmL: 'Left upper arm', forearmL: 'Left forearm', handL: 'Left hand',
  upperArmR: 'Right upper arm', forearmR: 'Right forearm', handR: 'Right hand',
  thighL: 'Left thigh', shinL: 'Left shin', footL: 'Left foot',
  thighR: 'Right thigh', shinR: 'Right shin', footR: 'Right foot',
};

const ALIASES: Record<Bone3D, string[]> = {
  hips: ['hips', 'hip', 'pelvis', 'roothips', 'bip01pelvis'],
  spine: ['spine', 'spine0', 'spine01', 'lowerback', 'abdomen', 'bip01spine'],
  chest: ['chest', 'upperchest', 'spine2', 'spine02', 'spine1', 'spine01', 'bip01spine2', 'bip01spine1'],
  neck: ['neck', 'neck1', 'neck01', 'bip01neck'], head: ['head', 'head1', 'bip01head'],
  upperArmL: ['leftarm', 'leftupperarm', 'upperarml', 'lupperarm', 'arml', 'bip01lupperarm'],
  forearmL: ['leftforearm', 'leftlowerarm', 'forearml', 'lowerarml', 'lforearm', 'bip01lforearm'],
  handL: ['lefthand', 'handl', 'lhand', 'bip01lhand'],
  upperArmR: ['rightarm', 'rightupperarm', 'upperarmr', 'rupperarm', 'armr', 'bip01rupperarm'],
  forearmR: ['rightforearm', 'rightlowerarm', 'forearmr', 'lowerarmr', 'rforearm', 'bip01rforearm'],
  handR: ['righthand', 'handr', 'rhand', 'bip01rhand'],
  thighL: ['leftupleg', 'leftupperleg', 'leftthigh', 'thighl', 'upperlegl', 'lthigh', 'bip01lthigh'],
  shinL: ['leftleg', 'leftlowerleg', 'leftshin', 'shinl', 'calfl', 'lowerlegl', 'bip01lcalf'],
  footL: ['leftfoot', 'footl', 'lfoot', 'bip01lfoot'],
  thighR: ['rightupleg', 'rightupperleg', 'rightthigh', 'thighr', 'upperlegr', 'rthigh', 'bip01rthigh'],
  shinR: ['rightleg', 'rightlowerleg', 'rightshin', 'shinr', 'calfr', 'lowerlegr', 'bip01rcalf'],
  footR: ['rightfoot', 'footr', 'rfoot', 'bip01rfoot'],
};

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/^.*[:|]/, '').replace(/^mixamorig\d*[_:]?/, '').replace(/^def[-_]/, '').replace(/[^a-z0-9]/g, '');
}

export function autoMapBones3D(bones: readonly THREE.Bone[]): BoneMapping3D {
  const mapping: BoneMapping3D = {};
  const used = new Set<string>();
  for (const name of HUMANOID_BONES) {
    for (const alias of ALIASES[name]) {
      const bone = bones.find(candidate => !used.has(candidate.uuid) && normalizedName(candidate.name) === alias);
      if (bone) { mapping[name] = bone.uuid; used.add(bone.uuid); break; }
    }
  }
  return mapping;
}

/** Refuse duplicate assignments and reversed anatomical chains before changing a live rig. */
export function validateMapping3D(rig: CharacterRig3D, mapping: BoneMapping3D): string[] {
  const issues: string[] = [];
  const ids = Object.values(mapping).filter(Boolean);
  if (new Set(ids).size !== ids.length) issues.push('Each model bone can be assigned to only one body part.');
  const hierarchy = createDefaultSkeleton3D().bones;
  for (const child of HUMANOID_BONES) {
    let parent = hierarchy[child].parent;
    while (parent && !mapping[parent]) parent = hierarchy[parent].parent;
    if (!parent) continue;
    const childBone = rig.bones.find(bone => bone.uuid === mapping[child]);
    const parentBone = rig.bones.find(bone => bone.uuid === mapping[parent]);
    if (!childBone || !parentBone) continue;
    let ancestor = childBone.parent;
    while (ancestor && ancestor !== parentBone) ancestor = ancestor.parent;
    if (!ancestor) issues.push(`${BONE_LABELS_3D[child]} must be a descendant of ${BONE_LABELS_3D[parent]}.`);
  }
  return issues;
}

export function resetCharacter3D(rig: CharacterRig3D): void {
  rig.root.position.set(0, 0, 0);
  rig.root.quaternion.identity();
  for (const [bone, rest] of rig.rest) {
    bone.position.copy(rest.position); bone.quaternion.copy(rest.quaternion); bone.scale.copy(rest.scale);
  }
  rig.root.updateMatrixWorld(true);
}

export function captureRest3D(rig: CharacterRig3D): void {
  rig.rest.clear();
  for (const bone of rig.bones) rig.rest.set(bone, {
    position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
  });
  rig.skeleton = extractSkeleton3D(rig);
}

/** Independent bone transforms for animation baking; mesh data stays shared and read-only. */
export function cloneCharacter3D(rig: CharacterRig3D): CharacterRig3D {
  const root = cloneSkinnedObject(rig.root) as THREE.Group;
  root.position.set(0, 0, 0); root.quaternion.identity(); root.visible = true;
  const pairs = new Map<THREE.Object3D, THREE.Object3D>();
  function pair(source: THREE.Object3D, target: THREE.Object3D) {
    pairs.set(source, target);
    source.children.forEach((child, index) => pair(child, target.children[index]));
  }
  pair(rig.root, root);
  const mapping: BoneMapping3D = {};
  for (const [bone, rest] of rig.rest) {
    const target = pairs.get(bone) as THREE.Bone;
    target.position.copy(rest.position); target.quaternion.copy(rest.quaternion); target.scale.copy(rest.scale);
    const name = HUMANOID_BONES.find(candidate => rig.mapping[candidate] === bone.uuid);
    if (name) mapping[name] = target.uuid;
  }
  root.traverse(object => { object.visible = true; });
  const result = createRig(rig.name, root, rig.imported, mapping);
  result.skeleton = structuredClone(rig.skeleton);
  return result;
}

export function extractSkeleton3D(rig: CharacterRig3D): Skeleton3D {
  const fallback = createDefaultSkeleton3D();
  const positions = new Map<Bone3D, THREE.Vector3>();
  const rotations = new Map<Bone3D, THREE.Quaternion>();
  rig.root.updateMatrixWorld(true);
  const inverseRoot = rig.root.matrixWorld.clone().invert();
  const rootQuaternionInverse = rig.root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bones = {} as Skeleton3D['bones'];
  for (const name of HUMANOID_BONES) {
    const definition = fallback.bones[name];
    const parentPosition = definition.parent ? positions.get(definition.parent)! : new THREE.Vector3();
    const parentRotation = definition.parent ? rotations.get(definition.parent)! : new THREE.Quaternion();
    const mapped = rig.bones.find(bone => bone.uuid === rig.mapping[name]);
    let position: THREE.Vector3, rotation: THREE.Quaternion;
    if (mapped) {
      position = mapped.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseRoot);
      rotation = rootQuaternionInverse.clone().multiply(mapped.getWorldQuaternion(new THREE.Quaternion()));
    } else {
      position = new THREE.Vector3().copy(definition.offset).applyQuaternion(parentRotation).add(parentPosition);
      rotation = parentRotation.clone().multiply(new THREE.Quaternion().copy(definition.restRotation));
    }
    const parentInverse = parentRotation.clone().invert();
    const offset = position.clone().sub(parentPosition).applyQuaternion(parentInverse);
    const restRotation = parentInverse.clone().multiply(rotation).normalize();
    let endOffset = definition.endOffset;
    if (mapped && endOffset) {
      const candidates = mapped.children.filter(object => (object as THREE.Bone).isBone) as THREE.Bone[];
      const preferred = name.startsWith('hand') ? /middle|handend|handtip/i : name.startsWith('foot') ? /toe|ball|footend|foottip/i : /headend|headtip|end.?site/i;
      const child = candidates.find(bone => preferred.test(bone.name)) ?? (candidates.length === 1 ? candidates[0] : undefined);
      let extension: THREE.Vector3;
      if (child) extension = child.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverseRoot).sub(position);
      else if (name.startsWith('foot')) extension = new THREE.Vector3(0, -.04, .17);
      else extension = position.clone().sub(parentPosition).normalize().multiplyScalar(name === 'head' ? .15 : .12);
      if (extension.lengthSq() < 1e-8) extension = new THREE.Vector3(0, .1, 0);
      extension.applyQuaternion(rotation.clone().invert());
      endOffset = { x: extension.x, y: extension.y, z: extension.z };
    }
    bones[name] = { parent: definition.parent, offset: { x: offset.x, y: offset.y, z: offset.z },
      restRotation: { x: restRotation.x, y: restRotation.y, z: restRotation.z, w: restRotation.w },
      endOffset };
    positions.set(name, position); rotations.set(name, rotation);
  }
  return { name: rig.name, bones };
}

/** Apply virtual canonical world rotations through any intervening, unmapped model bones. */
export function applyPose3D(rig: CharacterRig3D, pose: Pose3D): void {
  resetCharacter3D(rig);
  if (!pose.valid) return;
  const worldRotations = new Map<Bone3D, THREE.Quaternion>();
  for (const name of HUMANOID_BONES) {
    const parent = rig.skeleton.bones[name].parent;
    const rotation = new THREE.Quaternion().copy(pose.rotations[name]);
    if (parent) rotation.premultiply(worldRotations.get(parent)!);
    worldRotations.set(name, rotation);
  }
  // Actual hierarchy order, not canonical order: imported rigs may contain helper bones.
  const order = rig.bones.map(bone => {
    let depth = 0, parent = bone.parent;
    while (parent) { depth++; parent = parent.parent; }
    return { bone, depth };
  }).sort((a, b) => a.depth - b.depth);
  const rootRest = rig.skeleton.bones.hips.offset;
  rig.root.position.set(pose.root.x - rootRest.x, pose.root.y - rootRest.y, pose.root.z - rootRest.z);
  rig.root.updateMatrixWorld(true);
  const modelWorld = rig.root.getWorldQuaternion(new THREE.Quaternion());
  for (const { bone } of order) {
    const name = HUMANOID_BONES.find(candidate => rig.mapping[candidate] === bone.uuid);
    if (!name || pose.confidence[name] < .25) continue;
    const desired = modelWorld.clone().multiply(worldRotations.get(name)!);
    const parentInverse = bone.parent?.getWorldQuaternion(new THREE.Quaternion()).invert() ?? new THREE.Quaternion();
    bone.quaternion.copy(parentInverse.multiply(desired).normalize());
    bone.updateMatrixWorld(true);
  }
}

function createRig(name: string, root: THREE.Group, imported: boolean, mapping?: BoneMapping3D): CharacterRig3D {
  const bones: THREE.Bone[] = [];
  root.traverse(object => {
    if ((object as THREE.Bone).isBone && !bones.includes(object as THREE.Bone)) bones.push(object as THREE.Bone);
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      mesh.castShadow = true; mesh.receiveShadow = true;
      // Recompute animated skin bounds; imported bind-pose boxes can cull moving limbs.
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
    }
  });
  const rig: CharacterRig3D = { name, root, bones, imported, mapping: mapping ?? autoMapBones3D(bones),
    skeleton: createDefaultSkeleton3D(), rest: new Map() };
  // Naming alone cannot prove anatomy. Discard unsafe automatic matches, then expose
  // all bones for explicit manual assignment instead of animating reversed chains.
  if (!mapping) {
    for (const name of HUMANOID_BONES) {
      if (rig.mapping[name] && validateMapping3D(rig, rig.mapping).some(issue => issue.startsWith(`${BONE_LABELS_3D[name]} must`))) delete rig.mapping[name];
    }
  }
  captureRest3D(rig);
  return rig;
}

export function createBuiltinCharacter3D(): CharacterRig3D {
  const definition = createDefaultSkeleton3D();
  const group = new THREE.Group();
  const bones = new Map<Bone3D, THREE.Bone>();
  for (const name of HUMANOID_BONES) {
    const bone = new THREE.Bone(); bone.name = name;
    bone.position.copy(definition.bones[name].offset);
    bone.quaternion.copy(definition.bones[name].restRotation);
    bones.set(name, bone);
    const parent = definition.bones[name].parent;
    (parent ? bones.get(parent)! : group).add(bone);
  }
  group.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  HUMANOID_BONES.forEach((name, index) => {
    const bone = bones.get(name)!;
    const start = bone.getWorldPosition(new THREE.Vector3());
    const childName = HUMANOID_BONES.find(child => definition.bones[child].parent === name);
    let end = childName ? bones.get(childName)!.getWorldPosition(new THREE.Vector3())
      : new THREE.Vector3().copy(definition.bones[name].endOffset ?? { x: 0, y: .12, z: 0 }).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).add(start);
    const radius = name === 'head' ? .115 : ['hips', 'spine', 'chest'].includes(name) ? .105 : name.startsWith('thigh') ? .066 : name.startsWith('shin') ? .052 : name.startsWith('foot') ? .055 : .043;
    if (name === 'head') end = start.clone().add(new THREE.Vector3(0, .16, 0));
    const direction = end.clone().sub(start);
    const length = Math.max(direction.length(), .06);
    const geometry = name === 'head' ? new THREE.SphereGeometry(radius, 20, 14).translate(0, length * .45, 0)
      : name === 'chest' ? new THREE.SphereGeometry(radius, 20, 14).scale(2.15, 1.4, 1.03).translate(0, length * .25, 0)
      : new THREE.CapsuleGeometry(radius, Math.max(.005, length - radius * 2), 4, 12).translate(0, length / 2, 0);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geometry.translate(start.x, start.y, start.z);
    const count = geometry.getAttribute('position').count;
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4), colors = new Float32Array(count * 3);
    const color = new THREE.Color(name.endsWith('L') ? '#b9f1ca' : name.endsWith('R') ? '#a7b6f5' : '#b4dcd1');
    for (let i = 0; i < count; i++) { indices[i * 4] = index; weights[i * 4] = 1; colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometries.push(geometry);
  });
  const merged = mergeGeometries(geometries);
  geometries.forEach(geometry => geometry.dispose());
  if (!merged) throw new Error('Could not create the 3D character geometry.');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .53, metalness: .06 });
  const mesh = new THREE.SkinnedMesh(merged, material);
  group.add(mesh);
  const skeleton = new THREE.Skeleton(HUMANOID_BONES.map(name => bones.get(name)!));
  mesh.bind(skeleton);
  // Original facial markers make the forward direction readable while orbiting.
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#173437', roughness: .4 });
  for (const x of [-.041, .041]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(.018, 12, 8), eyeMaterial);
    eye.scale.z = .45; eye.position.set(x, .091, .105); bones.get('head')!.add(eye);
  }
  const mapping = Object.fromEntries(HUMANOID_BONES.map(name => [name, bones.get(name)!.uuid])) as BoneMapping3D;
  return createRig('Studio humanoid', group, false, mapping);
}

function checkGlbResources(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('This is not a valid glTF 2.0 binary (.glb) file.');
  const jsonLength = view.getUint32(12, true);
  if (20 + jsonLength > buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('The GLB JSON chunk is missing or truncated.');
  const data = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    buffers?: { uri?: string }[]; images?: { uri?: string }[]; extensionsRequired?: string[];
  };
  for (const item of [...(data.buffers ?? []), ...(data.images ?? [])]) {
    if (item.uri && !item.uri.startsWith('data:')) throw new Error('The model references external files. Export a self-contained GLB with embedded textures and buffers.');
  }
  const compressed = data.extensionsRequired?.filter(extension => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension));
  if (compressed?.length) throw new Error(`This model needs ${compressed.join(', ')} decoders. Re-export it without mesh/texture compression.`);
}

export async function loadCharacter3D(file: File): Promise<CharacterRig3D> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'glb' && extension !== 'fbx') throw new Error('Choose a self-contained GLB or FBX model with a humanoid armature.');
  if (!file.size || file.size > 250 * 1024 * 1024) throw new Error('Choose a non-empty model smaller than 250 MB.');
  const buffer = await file.arrayBuffer();
  const manager = new THREE.LoadingManager();
  let resourcesStarted = false;
  let resourceError = '';
  let finishResources: (() => void) | undefined;
  const resourcesReady = new Promise<void>(resolve => { finishResources = resolve; });
  manager.onStart = () => { resourcesStarted = true; };
  manager.onError = () => { resourceError = 'An embedded model texture could not be decoded. Re-export the model with standard PNG or JPEG textures.'; };
  manager.onLoad = () => finishResources?.();
  manager.setURLModifier(url => {
    if (/^(data:|blob:)/i.test(url)) return url;
    throw new Error('External model resources are blocked. Embed textures and buffers in the model file.');
  });
  let model: THREE.Group;
  if (extension === 'glb') {
    checkGlbResources(buffer);
    model = (await new GLTFLoader(manager).parseAsync(buffer, '')).scene;
  } else model = new FBXLoader(manager).parse(buffer, '');
  if (resourcesStarted) await resourcesReady;
  if (resourceError) { disposeObject3D(model); throw new Error(resourceError); }
  const root = new THREE.Group(); root.add(model);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  if (box.isEmpty() || !Number.isFinite(size.y) || size.y < 1e-8) { disposeObject3D(root); throw new Error('The model has no visible geometry with a usable height.'); }
  const scale = 1.85 / size.y;
  const center = box.getCenter(new THREE.Vector3());
  const container = new THREE.Group();
  container.scale.setScalar(scale); container.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  root.remove(model); container.add(model); root.add(container);
  const rig = createRig(file.name, root, true);
  let skinCount = 0; root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinCount++; });
  if (!rig.bones.length || !skinCount) { disposeObject3D(root); throw new Error('This model has no skinned armature. Bind the mesh to a humanoid skeleton in Blender before importing it.'); }
  return rig;
}

export function disposeObject3D(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(), skeletons = new Set<THREE.Skeleton>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if ((mesh as THREE.SkinnedMesh).skeleton) skeletons.add((mesh as THREE.SkinnedMesh).skeleton);
  });
  textures.forEach(texture => {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
    texture.dispose();
  });
  materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose()); skeletons.forEach(skeleton => skeleton.dispose());
  root.removeFromParent();
}
