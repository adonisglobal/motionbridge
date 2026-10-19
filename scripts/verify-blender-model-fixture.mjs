// Read the application-generated animated GLB without a browser or external assets,
// then record independent Three.js bone/skin poses for Blender comparison.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AnimationMixer, LoopOnce, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const input = resolve(process.argv[2] ?? '.local/3d-builtin-animated.glb');
const directory = resolve(process.argv[3] ?? '.local/blender-qa');
await mkdir(directory, { recursive: true });
let binary;
try { binary = await readFile(input); }
catch (error) {
  if (error.code !== 'ENOENT' || process.argv[2]) throw error;
  const { createBuiltinCharacter3D, disposeObject3D } = await import('../src/character3d/rig.ts');
  const { exportAnimatedGLB3D } = await import('../src/character3d/export.ts');
  const { HUMANOID_BONES } = await import('../src/motion3d/types.ts');
  const { Euler, Quaternion } = await import('three');
  const source = timestampMs => ({ timestampMs,
    rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, w: 1 }])),
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, confidence: 1 }])),
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])),
    held: Object.fromEntries(HUMANOID_BONES.map(name => [name, false])),
    root: { x: timestampMs / 1000, y: 0, z: 0 }, rootTracked: true, scale: 0.4, valid: true, needsReview: false });
  const frames = Array.from({ length: 13 }, (_, index) => {
    const frame = source(index * 1000 / 12);
    const q = new Quaternion().setFromEuler(new Euler(index * 0.025, index * -0.03, index * 0.055));
    frame.rotations.upperArmL = { x: q.x, y: q.y, z: q.z, w: q.w };
    return frame;
  });
  const originalReader = globalThis.FileReader;
  class BlobReader {
    result = null;
    onloadend = null;
    readAsArrayBuffer(blob) { void blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
  }
  globalThis.FileReader = BlobReader;
  const rig = createBuiltinCharacter3D();
  try {
    binary = Buffer.from(await exportAnimatedGLB3D(rig, { frames, reference: source(0), fps: 24, strength: 1, inPlace: false }));
    await mkdir(resolve(input, '..'), { recursive: true });
    await writeFile(input, binary);
  } finally { globalThis.FileReader = originalReader; disposeObject3D(rig.root); }
}
const gltf = await new GLTFLoader().parseAsync(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), '');
if (gltf.animations.length !== 1) throw new Error('Expected one exported motion clip.');
let mesh;
const bones = [];
gltf.scene.traverse(object => { if (object.isBone) bones.push(object); if (object instanceof SkinnedMesh) mesh = object; });
if (!mesh || bones.length !== 17) throw new Error('Expected the generated skinned mannequin with 17 bones.');
gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
const plain = v => ({ x: v.x, y: v.y, z: v.z });
const selectedVertices = [];
for (const index of [0, 5, 6, 12, 15]) {
  const skin = mesh.geometry.getAttribute('skinIndex');
  const vertexIndex = Array.from({ length: skin.count }, (_, i) => i).find(i => skin.getX(i) === index);
  if (vertexIndex === undefined) throw new Error(`Missing fixture vertices for joint ${index}.`);
  selectedVertices.push({ index: vertexIndex, rest: plain(mesh.getVertexPosition(vertexIndex, new Vector3()).applyMatrix4(mesh.matrixWorld)) });
}
const clip = gltf.animations[0];
let metadata;
gltf.scene.traverse(object => { if (object.userData.motionCapture) metadata = object.userData.motionCapture; });
const fps = metadata?.fps ?? 24;
const mixer = new AnimationMixer(gltf.scene);
const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
action.clampWhenFinished = true;
action.play();
const frames = [];
for (const amount of [0, 0.125, 0.5, 0.875, 1]) {
  const seconds = amount * clip.duration;
  mixer.setTime(seconds);
  gltf.scene.updateMatrixWorld(true); mesh.skeleton.update();
  frames.push({ seconds, positions: Object.fromEntries(bones.map(bone => [bone.name, plain(bone.getWorldPosition(new Vector3()))])),
    vertices: selectedVertices.map(vertex => plain(mesh.getVertexPosition(vertex.index, new Vector3()).applyMatrix4(mesh.matrixWorld))) });
}
const expected = { input, fps, durationSeconds: clip.duration, boneCount: bones.length,
  vertexCount: mesh.geometry.getAttribute('position').count, meshName: mesh.name,
  triangleCount: (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3,
  selectedVertices, frames, metadata, independentImplementation: 'Three.js GLTFLoader, AnimationMixer and skinning' };
await writeFile(resolve(directory, 'animated-model.expected.json'), JSON.stringify(expected, null, 2));
process.stdout.write(`Recorded ${frames.length} independent GLB poses (${bones.length} joints) for Blender.\n`);
