import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Motion3DFrame } from '../motion3d/types.ts';
import { retargetFrame3D } from '../motion3d/retarget.ts';
import { applyPose3D, captureRest3D, createBuiltinCharacter3D, disposeObject3D, loadCharacter3D } from './rig.ts';
import { bakeModelClip3D, exportAnimatedGLB3D } from './export.ts';

function source(timestampMs = 0): Motion3DFrame {
  return {
    timestampMs, rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, w: 1 }])) as Motion3DFrame['rotations'],
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, confidence: 1 }])) as Motion3DFrame['positions'],
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])) as Motion3DFrame['confidence'],
    held: Object.fromEntries(HUMANOID_BONES.map(name => [name, false])) as Motion3DFrame['held'],
    root: { x: timestampMs / 1000, y: 0, z: 0 }, rootTracked: true, scale: .4, valid: true, needsReview: false,
  };
}
function frames() {
  return Array.from({ length: 13 }, (_, index) => {
    const frame = source(index * 1000 / 12);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(index * .025, index * -.03, index * .055));
    frame.rotations.upperArmL = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
    return frame;
  });
}
const options = () => ({ frames: frames(), reference: source(), fps: 24, strength: 1, inPlace: false });

test('baked model animation samples at the selected FPS and matches preview transforms', () => {
  const rig = createBuiltinCharacter3D();
  const motion = options();
  const baked = bakeModelClip3D(rig, motion);
  assert.equal(baked.sampled.poses.length, 25);
  assert.equal(baked.clip.duration, 1);
  assert.equal(baked.clip.tracks.length, 18);
  const mixer = new THREE.AnimationMixer(baked.rig.root);
  mixer.clipAction(baked.clip).setLoop(THREE.LoopOnce, 1).play();
  mixer.setTime(.5);
  applyPose3D(rig, retargetFrame3D(motion.frames[6], motion.reference, rig.skeleton, motion));
  for (const name of HUMANOID_BONES) {
    const live = rig.bones.find(bone => bone.uuid === rig.mapping[name])!;
    const clone = baked.rig.bones.find(bone => bone.uuid === baked.rig.mapping[name])!;
    assert.ok(live.quaternion.angleTo(clone.quaternion) < 1e-6, name);
    assert.ok(live.getWorldPosition(new THREE.Vector3()).distanceTo(clone.getWorldPosition(new THREE.Vector3())) < 1e-6, name);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(baked.rig.root);
  disposeObject3D(rig.root);
});

test('animation baking keeps live transforms intact and supports noncanonical helper bones', () => {
  const rig = createBuiltinCharacter3D();
  const upper = rig.bones.find(bone => bone.uuid === rig.mapping.upperArmL)!;
  const forearm = rig.bones.find(bone => bone.uuid === rig.mapping.forearmL)!;
  const helper = new THREE.Bone(); helper.name = 'ArmHelper'; helper.rotation.y = .3;
  upper.remove(forearm); upper.add(helper); helper.add(forearm); rig.bones.push(helper); captureRest3D(rig);
  const motion = options();
  applyPose3D(rig, retargetFrame3D(motion.frames[7], motion.reference, rig.skeleton));
  const before = rig.bones.map(bone => bone.quaternion.clone());
  const beforeRoot = rig.root.position.clone();
  const baked = bakeModelClip3D(rig, motion);
  assert.equal(baked.clip.tracks.length, 19);
  rig.bones.forEach((bone, index) => assert.ok(bone.quaternion.angleTo(before[index]) < 1e-6));
  assert.ok(rig.root.position.distanceTo(beforeRoot) < 1e-8);
  assert.notEqual(baked.rig.bones[0], rig.bones[0]);
  disposeObject3D(rig.root);
});

test('GLB export shares BVH rejection policy for missing, uncertain, and long-gap samples', () => {
  const rig = createBuiltinCharacter3D();
  const motion = options();
  motion.frames[3].valid = false;
  assert.throws(() => bakeModelClip3D(rig, motion), /tracking is missing/);
  motion.frames[3].valid = true; motion.frames[3].needsReview = true;
  assert.throws(() => bakeModelClip3D(rig, motion), /need review/);
  assert.doesNotThrow(() => bakeModelClip3D(rig, { ...motion, allowUncertain: true }));
  assert.throws(() => bakeModelClip3D(rig, { ...motion, frames: [source(0), source(1000)], allowUncertain: true }), /observation gap/);
  disposeObject3D(rig.root);
});

test('animated GLB roundtrip preserves geometry, skin, timing, and a moving mesh', async () => {
  // Node lacks FileReader. The exporter uses only its standard Blob->ArrayBuffer path here.
  const original = globalThis.FileReader;
  class BlobReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
  }
  Object.assign(globalThis, { FileReader: BlobReader });
  const rig = createBuiltinCharacter3D();
  try {
    const data = await exportAnimatedGLB3D(rig, options());
    assert.ok(data.byteLength > 100_000);
    const imported = await new GLTFLoader().parseAsync(data, '');
    assert.equal(imported.animations.length, 1);
    assert.equal(imported.animations[0].tracks.length, 18);
    assert.equal(imported.animations[0].duration, 1);
    const meshes: THREE.SkinnedMesh[] = [];
    imported.scene.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
    assert.equal(meshes.length, 1); assert.equal(meshes[0].skeleton.bones.length, 17);
    const mixer = new THREE.AnimationMixer(imported.scene);
    mixer.clipAction(imported.animations[0]).setLoop(THREE.LoopOnce, 1).play();
    mixer.setTime(.1); imported.scene.updateMatrixWorld(true); meshes[0].skeleton.update();
    const armVertices = Array.from({ length: meshes[0].geometry.getAttribute('skinIndex').count }, (_, i) => i).filter(i => meshes[0].geometry.getAttribute('skinIndex').getX(i) === 5);
    const starts = armVertices.map(index => meshes[0].getVertexPosition(index, new THREE.Vector3()).clone());
    mixer.setTime(.7); imported.scene.updateMatrixWorld(true); meshes[0].skeleton.update();
    const displacement = Math.max(...armVertices.map((index, i) => starts[i].distanceTo(meshes[0].getVertexPosition(index, new THREE.Vector3()))));
    assert.ok(displacement > .03, `a skinned arm vertex must deform with the animation (${displacement})`);
    assert.ok(meshes[0].getWorldPosition(new THREE.Vector3()).x > .1);
    assert.ok(starts.every(start => Number.isFinite(start.x) && Number.isFinite(start.y)));
    const reimportedRig = await loadCharacter3D(new File([data], 'studio-roundtrip.glb'));
    assert.equal(reimportedRig.bones.length, 17);
    assert.equal(Object.keys(reimportedRig.mapping).length, 17);
    const targetPose = retargetFrame3D(frames()[6], source(), reimportedRig.skeleton);
    applyPose3D(reimportedRig, targetPose);
    for (const name of HUMANOID_BONES) {
      const bone = reimportedRig.bones.find(value => value.uuid === reimportedRig.mapping[name])!;
      assert.ok(bone.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().copy(targetPose.positions[name])) < 1e-6, `imported ${name} must match target FK`);
    }
    disposeObject3D(reimportedRig.root); disposeObject3D(imported.scene);
    assert.ok(rig.root.children.length > 0, 'export must not dispose the live character');
  } finally {
    Object.assign(globalThis, { FileReader: original });
    disposeObject3D(rig.root);
  }
});
