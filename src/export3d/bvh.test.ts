import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';
import { createDefaultSkeleton3D } from '../motion3d/retarget.ts';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Bone3D, Pose3D, Quat } from '../motion3d/types.ts';
import { exportPosesBVH, resamplePoses, skeletonTraversal } from './bvh.ts';

const skeleton = createDefaultSkeleton3D();
const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
function pose(timestampMs: number): Pose3D {
  return { timestampMs, root: { ...skeleton.bones.hips.offset },
    rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, identity()])) as Pose3D['rotations'],
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0 }])) as Pose3D['positions'],
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])) as Pose3D['confidence'], valid: true, needsReview: false };
}
function motionRows(text: string): number[][] {
  return text.split(/Frame Time: [^\n]+\n/)[1].trim().split('\n').map(line => line.split(' ').map(Number));
}

test('BVH channels follow depth-first hierarchy, with root translation in meters', () => {
  const first = pose(1000);
  first.root.x = 0.4;
  const result = exportPosesBVH({ skeleton, poses: [first], fps: 30 });
  const names = [...result.text.matchAll(/(?:ROOT|JOINT) (\w+)/g)].map(match => match[1]);
  assert.deepEqual(names, skeletonTraversal(skeleton));
  assert.equal(result.frameCount, 1);
  assert.deepEqual(motionRows(result.text)[0].slice(0, 3), [0.4, 0.98, 0]);
  assert.equal(motionRows(result.text)[0].length, HUMANOID_BONES.length * 3 + 3);
  assert.match(result.text, /ROOT hips\n\{\n  OFFSET 0 0 0/);
});

test('resampling uses timestamps, preserves nonzero start time, and does not extrapolate', () => {
  const a = pose(1250), b = pose(1375), c = pose(1500);
  c.root.x = 1;
  b.root.x = 0.5;
  const result = resamplePoses({ skeleton, poses: [a, b, c], fps: 30 });
  assert.equal(result.poses.length, 8);
  assert.equal(result.sourceStartMs, 1250);
  assert.ok(Math.abs(result.sourceEndMs - 1483.3333333333333) < 1e-8);
  assert.ok(Math.abs(result.poses[3].root.x - 0.4) < 1e-8);
});

test('slerp handles quaternion sign changes and recomputes fixed-length FK', () => {
  const a = pose(0), b = pose(200);
  b.rotations.hips = { x: 0, y: 0, z: 0, w: -1 };
  const angle = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  b.rotations.chest = { x: angle.x, y: angle.y, z: angle.z, w: angle.w };
  const result = resamplePoses({ skeleton, poses: [a, b], fps: 10 });
  for (const item of result.poses) {
    assert.ok(Math.abs(item.rotations.hips.w - 1) < 1e-8);
    for (const name of HUMANOID_BONES) {
      const parent = skeleton.bones[name].parent;
      if (!parent) continue;
      const p = item.positions[parent], q = item.positions[name], offset = skeleton.bones[name].offset;
      assert.ok(Math.abs(Math.hypot(q.x-p.x, q.y-p.y, q.z-p.z) - Math.hypot(offset.x, offset.y, offset.z)) < 1e-8);
    }
  }
});

test('review flags require explicit opt-in, and remain visible in export warnings', () => {
  const sample = pose(0);
  sample.needsReview = true;
  sample.confidence.footL = 0.2;
  assert.throws(() => exportPosesBVH({ skeleton, poses: [sample], fps: 30 }), /Include frames marked for review/);
  const result = exportPosesBVH({ skeleton, poses: [sample], fps: 30, allowUncertain: true });
  assert.equal(result.warnings.length, 1);
});

test('missing tracking and long gaps cannot be bypassed by allowing review frames', () => {
  const a = pose(0), b = pose(300);
  assert.throws(() => exportPosesBVH({ skeleton, poses: [a, b], fps: 30, allowUncertain: true }), /observation gap/);
  b.timestampMs = 100;
  b.valid = false;
  assert.throws(() => exportPosesBVH({ skeleton, poses: [a, b], fps: 30, allowUncertain: true }), /tracking is missing/);
});

test('invalid transforms, confidence and timestamp order fail before producing a file', () => {
  const a = pose(0), b = pose(0);
  assert.throws(() => exportPosesBVH({ skeleton, poses: [a, b], fps: 24 }), /increasing timestamps/);
  a.rotations.handL.w = NaN;
  assert.throws(() => exportPosesBVH({ skeleton, poses: [a], fps: 24 }), /invalid joint rotation/);
  a.rotations.handL = identity();
  a.confidence.head = NaN;
  assert.throws(() => exportPosesBVH({ skeleton, poses: [a], fps: 24 }), /invalid confidence/);
});

test('compound XYZ rotations and Euler continuity survive independent quaternion reconstruction', () => {
  const samples = [pose(0), pose(100), pose(200)];
  const rotations = [[0.3, 0.4, 3.1], [0.34, 0.5, 3.2], [-0.7, Math.PI / 2, 0.8]];
  for (let i = 0; i < samples.length; i++) {
    const q = new Quaternion().setFromEuler(new Euler(...rotations[i] as [number, number, number], 'XYZ'));
    samples[i].rotations.hips = { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  const result = exportPosesBVH({ skeleton, poses: samples, fps: 10 });
  const rows = motionRows(result.text);
  for (let i = 0; i < rows.length; i++) {
    const channels = rows[i].slice(3, 6).map(deg => deg * Math.PI / 180);
    const actual = new Quaternion().setFromEuler(new Euler(channels[0], channels[1], channels[2], 'XYZ'));
    const q = samples[i].rotations.hips;
    assert.ok(actual.angleTo(new Quaternion(q.x, q.y, q.z, q.w)) < 1e-7);
  }
  assert.ok(Math.abs(rows[1][5] - rows[0][5]) < 10, 'Crossing 180 degrees must not introduce a 360 degree jump.');
});
