import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Motion3DFrame } from '../motion3d/types.ts';
import { retargetFrame3D } from '../motion3d/retarget.ts';
import {
  applyPose3D, autoMapBones3D, captureRest3D, createBuiltinCharacter3D,
  disposeObject3D, loadCharacter3D, validateMapping3D,
} from './rig.ts';

function source(): Motion3DFrame {
  return {
    timestampMs: 0, rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, w: 1 }])) as Motion3DFrame['rotations'],
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, confidence: 1 }])) as Motion3DFrame['positions'],
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])) as Motion3DFrame['confidence'],
    held: Object.fromEntries(HUMANOID_BONES.map(name => [name, false])) as Motion3DFrame['held'],
    root: { x: 0, y: 0, z: 0 }, rootTracked: true, scale: .4, valid: true, needsReview: false,
  };
}

test('original studio humanoid is a bound, fully mapped skinned mesh', () => {
  const rig = createBuiltinCharacter3D();
  assert.equal(rig.bones.length, HUMANOID_BONES.length);
  assert.equal(Object.keys(rig.mapping).length, HUMANOID_BONES.length);
  const meshes: THREE.SkinnedMesh[] = [];
  rig.root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
  assert.equal(meshes.length, 1);
  const mesh = meshes[0];
  assert.equal(mesh.skeleton.bones.length, HUMANOID_BONES.length);
  assert.equal(mesh.geometry.getAttribute('skinWeight').count, mesh.geometry.getAttribute('position').count);
  assert.ok(mesh.geometry.getAttribute('position').count > 1000);
  disposeObject3D(rig.root);
});

test('bone mapping recognizes Mixamo, Blender suffixes and rejects twist-name guesses', () => {
  const names = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:LeftArm', 'DEF-forearm.R', 'thigh.L', 'LeftArmTwist'];
  const bones = names.map(name => { const bone = new THREE.Bone(); bone.name = name; return bone; });
  const result = autoMapBones3D(bones);
  assert.equal(result.hips, bones[0].uuid);
  assert.equal(result.spine, bones[1].uuid);
  assert.equal(result.chest, bones[3].uuid);
  assert.equal(result.upperArmL, bones[4].uuid);
  assert.equal(result.forearmR, bones[5].uuid);
  assert.equal(result.thighL, bones[6].uuid);
  assert.equal(new Set(Object.values(result)).size, Object.values(result).length);
});

test('manual mapping refuses duplicate assignments and reversed limb chains', () => {
  const rig = createBuiltinCharacter3D();
  const duplicate = { ...rig.mapping, forearmL: rig.mapping.upperArmL };
  assert.match(validateMapping3D(rig, duplicate).join(' '), /only one body part/);
  const reversed = { ...rig.mapping, upperArmL: rig.mapping.forearmL, forearmL: rig.mapping.upperArmL };
  assert.match(validateMapping3D(rig, reversed).join(' '), /descendant/);
  disposeObject3D(rig.root);
});

test('applied target transforms match fixed-length FK and strength zero restores rest', () => {
  const rig = createBuiltinCharacter3D();
  const reference = source(), frame = source();
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -.7);
  frame.rotations.upperArmL = { x: turn.x, y: turn.y, z: turn.z, w: turn.w };
  frame.root = { x: .7, y: -.5, z: 0 };
  const pose = retargetFrame3D(frame, reference, rig.skeleton, { strength: 1, inPlace: false });
  applyPose3D(rig, pose);
  for (const name of HUMANOID_BONES) {
    const bone = rig.bones.find(value => value.uuid === rig.mapping[name])!;
    const actual = bone.getWorldPosition(new THREE.Vector3());
    const expected = new THREE.Vector3().copy(pose.positions[name]);
    assert.ok(actual.distanceTo(expected) < 1e-6, `${name}: ${actual.toArray()} != ${expected.toArray()}`);
  }
  const zero = retargetFrame3D(frame, reference, rig.skeleton, { strength: 0, inPlace: false });
  applyPose3D(rig, zero);
  for (const [bone, rest] of rig.rest) assert.ok(bone.quaternion.angleTo(rest.quaternion) < 1e-6);
  assert.ok(rig.root.position.length() < 1e-8);
  disposeObject3D(rig.root);
});

test('unmapped helper transforms and arbitrary imported rest axes preserve exact bind pose', () => {
  const rig = createBuiltinCharacter3D();
  const upper = rig.bones.find(bone => bone.uuid === rig.mapping.upperArmL)!;
  const forearm = rig.bones.find(bone => bone.uuid === rig.mapping.forearmL)!;
  const helper = new THREE.Bone(); helper.name = 'UnmappedHelper';
  upper.remove(forearm); upper.add(helper); helper.add(forearm); helper.rotation.y = .35;
  forearm.rotation.x = .4; rig.bones.push(helper);
  captureRest3D(rig);
  const reference = source();
  applyPose3D(rig, retargetFrame3D(reference, reference, rig.skeleton));
  for (const [bone, rest] of rig.rest) assert.ok(bone.quaternion.angleTo(rest.quaternion) < 1e-6, bone.name);
  disposeObject3D(rig.root);
});

test('leaf end directions are derived in the actual model bone axes', () => {
  const rig = createBuiltinCharacter3D();
  const hand = rig.bones.find(bone => bone.uuid === rig.mapping.handL)!;
  hand.rotation.z = Math.PI / 2;
  const finger = new THREE.Bone(); finger.name = 'LeftHandMiddle1'; finger.position.set(0, .11, 0); hand.add(finger); rig.bones.push(finger);
  const foot = rig.bones.find(bone => bone.uuid === rig.mapping.footR)!;
  foot.rotation.y = Math.PI / 2;
  const toe = new THREE.Bone(); toe.name = 'RightToeBase'; toe.position.set(.15, -.02, 0); foot.add(toe); rig.bones.push(toe);
  captureRest3D(rig);
  assert.ok(new THREE.Vector3().copy(rig.skeleton.bones.handL.endOffset!).distanceTo(new THREE.Vector3(0, .11, 0)) < 1e-6);
  assert.ok(new THREE.Vector3().copy(rig.skeleton.bones.footR.endOffset!).distanceTo(new THREE.Vector3(.15, -.02, 0)) < 1e-6);
  disposeObject3D(rig.root);
});

function jsonGlb(data: object): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(data));
  const padded = Math.ceil(text.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + padded), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(32); new Uint8Array(buffer, 20, text.length).set(text);
  return buffer;
}

test('GLB import rejects external resources before invoking any loader', async () => {
  const file = new File([jsonGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/private.bin', byteLength: 1 }] })], 'external.glb');
  await assert.rejects(loadCharacter3D(file), /external files/);
  const compressed = new File([jsonGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] })], 'compressed.glb');
  await assert.rejects(loadCharacter3D(compressed), /without mesh\/texture compression/);
});

test('model import rejects malformed or non-rigged files with actionable errors', async () => {
  await assert.rejects(loadCharacter3D(new File(['invalid'], 'invalid.glb')), /not a valid/);
  await assert.rejects(loadCharacter3D(new File(['{}'], 'character.gltf')), /self-contained GLB or FBX/);
  const empty = new File([jsonGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 })], 'empty.glb');
  await assert.rejects(loadCharacter3D(empty), /no visible geometry/);
});
