// Verify the application's FBX path with a locally generated Blender fixture.
// No browser uploads, third-party models, image loaders, or remote resources.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Euler, Quaternion, Vector3 } from 'three';
import { HUMANOID_BONES } from '../src/motion3d/types.ts';
import { retargetFrame3D } from '../src/motion3d/retarget.ts';
import { applyPose3D, disposeObject3D, loadCharacter3D, validateMapping3D } from '../src/character3d/rig.ts';

const input = resolve(process.argv[2] ?? '.local/blender-qa/animated-model.fbx');
const buffer = await readFile(input);
const rig = await loadCharacter3D(new File([buffer], 'blender-generated.fbx'));
function source() {
  return { timestampMs: 0,
    rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, w: 1 }])),
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, confidence: 1 }])),
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])),
    held: Object.fromEntries(HUMANOID_BONES.map(name => [name, false])),
    root: { x: 0, y: 0, z: 0 }, rootTracked: true, scale: 0.4, valid: true, needsReview: false };
}
try {
  assert.equal(rig.bones.length, 17);
  assert.equal(Object.keys(rig.mapping).length, 17);
  assert.deepEqual(validateMapping3D(rig, rig.mapping), []);
  const meshes = [];
  const animations = [];
  rig.root.traverse(object => { if (object.isSkinnedMesh) meshes.push(object); if (object.animations.length) animations.push(...object.animations); });
  assert.equal(meshes.length, 1);
  assert.ok(animations.length >= 1, 'FBX contains the animation exported from Blender.');
  const expected = JSON.parse(await readFile(resolve(input, '..', 'animated-model.expected.json'), 'utf8'));
  assert.ok(Math.abs(animations[0].duration - expected.durationSeconds) < 1e-6);
  const mesh = meshes[0];
  const upperArm = rig.bones.find(bone => bone.uuid === rig.mapping.upperArmL);
  const boneIndex = mesh.skeleton.bones.indexOf(upperArm);
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const vertexIndex = Array.from({ length: skinIndex.count }, (_, i) => i).find(i => skinIndex.getX(i) === boneIndex);
  assert.notEqual(vertexIndex, undefined);
  rig.root.updateMatrixWorld(true); mesh.skeleton.update();
  const before = mesh.getVertexPosition(vertexIndex, new Vector3()).applyMatrix4(mesh.matrixWorld);
  const reference = source();
  const frame = source();
  frame.timestampMs = 100;
  const q = new Quaternion().setFromEuler(new Euler(0.2, -0.15, -0.9));
  frame.rotations.upperArmL = { x: q.x, y: q.y, z: q.z, w: q.w };
  frame.root.x = 0.3;
  const pose = retargetFrame3D(frame, reference, rig.skeleton, { inPlace: false });
  applyPose3D(rig, pose);
  rig.root.updateMatrixWorld(true); mesh.skeleton.update();
  const after = mesh.getVertexPosition(vertexIndex, new Vector3()).applyMatrix4(mesh.matrixWorld);
  const displacement = before.distanceTo(after);
  assert.ok(displacement > 0.03, 'The imported FBX mesh deforms under new captured motion.');
  let positionError = 0;
  for (const name of HUMANOID_BONES) {
    const actual = rig.bones.find(bone => bone.uuid === rig.mapping[name]).getWorldPosition(new Vector3());
    const expected = new Vector3().copy(pose.positions[name]);
    positionError = Math.max(positionError, actual.distanceTo(expected));
  }
  assert.ok(positionError < 1e-5, `Imported FBX target transforms must match FK; error ${positionError}.`);
  const report = { input, boneCount: rig.bones.length, automaticMappingCount: Object.keys(rig.mapping).length,
    skinnedMeshes: meshes.length, importedAnimationDurationSeconds: animations[0].duration,
    skinnedVertexDisplacement: displacement, retargetJointError: positionError, passed: true };
  await writeFile(resolve(input, '..', 'fbx-loader.report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`MOTION3D_FBX_VERIFIED ${JSON.stringify(report)}\n`);
} finally { disposeObject3D(rig.root); }
