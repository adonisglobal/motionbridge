import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landmark, MotionFrame } from '../tracking/types.ts';
import { BONE_NAMES, JOINT_NAMES, wrapAngle } from './canonical.ts';
import { MotionSolver } from './solver.ts';

function input(timestampMs = 0, transform = (point: Landmark) => point): MotionFrame {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  const points: Record<number, [number, number]> = {
    0: [0.5, 0.12], 7: [0.46, 0.12], 8: [0.54, 0.12],
    11: [0.35, 0.3], 12: [0.65, 0.3], 13: [0.25, 0.45], 14: [0.75, 0.45],
    15: [0.2, 0.6], 16: [0.8, 0.6], 19: [0.18, 0.64], 20: [0.82, 0.64],
    23: [0.42, 0.6], 24: [0.58, 0.6], 25: [0.42, 0.78], 26: [0.58, 0.78],
    27: [0.42, 0.94], 28: [0.58, 0.94], 31: [0.38, 0.98], 32: [0.62, 0.98],
  };
  for (const [index, [x, y]] of Object.entries(points)) pose[Number(index)] = { x, y, z: 0, visibility: 0.95 };
  const raw = { pose: pose.map(transform), poseWorld: [], face: [], leftHand: [], rightHand: [], blendshapes: {} };
  return { timestampMs, raw, cleaned: raw, confidence: 0.95, inferenceMs: 2 };
}

test('source aspect is applied before measuring directions', () => {
  const square = new MotionSolver({ width: 1000, height: 1000 }).process(input());
  const wide = new MotionSolver({ width: 2000, height: 1000 }).process(input(0, point => ({ ...point, x: point.x / 2 })));
  for (const name of BONE_NAMES) {
    assert.ok(Math.abs(square.bones[name].angle - wide.bones[name].angle) < 1e-12);
  }
  const stretched = new MotionSolver({ width: 2000, height: 1000 }).process(input());
  assert.ok(Math.abs(stretched.bones.upperArmL.angle - Math.atan2(0.15, -0.2)) < 1e-12);
});

test('normalization removes actor size and translation while scale stays fixed through a clip', () => {
  const normal = new MotionSolver({ width: 1280, height: 720 });
  const small = new MotionSolver({ width: 1280, height: 720 });
  const a = normal.process(input());
  const b = small.process(input(0, point => ({ ...point, x: 0.2 + point.x * 0.6, y: 0.1 + point.y * 0.6 })));
  for (const name of JOINT_NAMES) {
    assert.ok(Math.abs(a.joints[name].x - b.joints[name].x) < 1e-12);
    assert.ok(Math.abs(a.joints[name].y - b.joints[name].y) < 1e-12);
  }
  const moved = normal.process(input(40, point => ({ ...point, y: point.y * 0.8 })));
  assert.equal(moved.scale, a.scale);
});

test('short tracking gaps hold the pose with review flags, long gaps become unavailable', () => {
  const solver = new MotionSolver({ width: 1000, height: 1000 });
  const first = solver.process(input());
  const missing = input(50);
  missing.cleaned.pose[15].visibility = 0;
  const held = solver.process(missing);
  assert.equal(held.joints.wristL.held, true);
  assert.ok(held.bones.forearmL.confidence > 0.35);
  assert.equal(held.bones.forearmL.angle, first.bones.forearmL.angle);
  assert.equal(held.needsReview, true);
  const longMissing = input(250);
  longMissing.cleaned.pose[15].visibility = 0;
  const lost = solver.process(longMissing);
  assert.equal(lost.joints.wristL.confidence, 0);
  assert.equal(lost.bones.forearmL.confidence, 0);
  assert.equal(lost.bones.handL.confidence, 0);
});

test('missing face cannot rotate the torso or change arm local angles', () => {
  const solver = new MotionSolver({ width: 1000, height: 1000 });
  const a = solver.process(input());
  const noHead = input(50);
  for (const index of [0, 7, 8]) noHead.cleaned.pose[index].visibility = 0;
  const b = solver.process(noHead);
  assert.equal(b.bones.torso.angle, a.bones.torso.angle);
  assert.equal(b.bones.upperArmL.localAngle, a.bones.upperArmL.localAngle);
});

test('rotating the whole source body changes only the root bone local angle', () => {
  const solver = new MotionSolver({ width: 1000, height: 1000 });
  const reference = solver.process(input());
  const rotation = 0.6;
  const turned = solver.process(input(50, point => ({
    ...point,
    x: 0.5 + (point.x - 0.5) * Math.cos(rotation) - (point.y - 0.6) * Math.sin(rotation),
    y: 0.6 + (point.x - 0.5) * Math.sin(rotation) + (point.y - 0.6) * Math.cos(rotation),
  })));
  assert.ok(Math.abs(wrapAngle(turned.bones.torso.localAngle - reference.bones.torso.localAngle) - rotation) < 1e-12);
  for (const name of BONE_NAMES.filter(name => name !== 'torso')) {
    assert.ok(Math.abs(wrapAngle(turned.bones[name].localAngle - reference.bones[name].localAngle)) < 1e-12, name);
  }
});

test('long torso loss is invalid and finite; measurements are not mutated', () => {
  const solver = new MotionSolver({ width: 1280, height: 720 });
  const observed = input();
  const original = structuredClone(observed);
  solver.process(observed);
  assert.deepEqual(observed, original);
  const lost = input(500);
  lost.cleaned.pose = [];
  const result = solver.process(lost);
  assert.equal(result.valid, false);
  assert.equal(result.needsReview, true);
  assert.ok(JOINT_NAMES.every(name => Number.isFinite(result.joints[name].x) && Number.isFinite(result.joints[name].y)));
  assert.ok(BONE_NAMES.every(name => Number.isFinite(result.bones[name].angle) && result.bones[name].confidence === 0));
  assert.throws(() => solver.process(input(500)), /strictly increasing/);
});

test('untracked first frames do not calibrate an invented body', () => {
  const solver = new MotionSolver({ width: 1280, height: 720 });
  const missing = input();
  missing.cleaned.pose = [];
  assert.equal(solver.process(missing).valid, false);
  const observed = solver.process(input(100));
  assert.equal(observed.valid, true);
  assert.ok(Math.abs(observed.scale - 0.3) < 1e-12);
});
