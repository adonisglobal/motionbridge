import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import type { Landmark, MotionFrame } from '../tracking/types.ts';
import { MotionSolver3D, chooseReference3D } from './solver.ts';
import { createDefaultSkeleton3D, retargetFrame3D, validateSkeleton3D } from './retarget.ts';
import { HUMANOID_BONES } from './types.ts';
import type { Bone3D, Quat, Vec3 } from './types.ts';

const q = (value: Quat) => new Quaternion(value.x, value.y, value.z, value.w);
const v = (value: Vec3) => new Vector3(value.x, value.y, value.z);
const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} ${a} != ${b}`);
const sameRotation = (a: Quat, b: Quat, message?: string) => close(Math.abs(q(a).dot(q(b))), 1, message);

function input(timestampMs = 0, worldTransform = (point: Vector3) => point): MotionFrame {
  const desired: Record<number, [number, number, number]> = {
    0: [0, 0.72, 0.08], 7: [0.08, 0.72, 0], 8: [-0.08, 0.72, 0],
    11: [0.22, 0.4, 0], 12: [-0.22, 0.4, 0], 13: [0.52, 0.4, 0], 14: [-0.52, 0.4, 0],
    15: [0.79, 0.4, 0], 16: [-0.79, 0.4, 0],
    17: [0.90, 0.39, 0], 19: [0.90, 0.41, 0], 18: [-0.90, 0.39, 0], 20: [-0.90, 0.41, 0],
    23: [0.105, 0, 0], 24: [-0.105, 0, 0], 25: [0.105, -0.44, 0], 26: [-0.105, -0.44, 0],
    27: [0.105, -0.87, 0], 28: [-0.105, -0.87, 0], 31: [0.105, -0.91, 0.17], 32: [-0.105, -0.91, 0.17],
  };
  const poseWorld: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const pose: Landmark[] = poseWorld.map(point => ({ ...point }));
  for (const [index, xyz] of Object.entries(desired)) {
    const point = worldTransform(new Vector3(...xyz));
    poseWorld[Number(index)] = { x: point.x, y: -point.y, z: -point.z, visibility: 0.98, presence: 0.99 };
    pose[Number(index)] = { x: 0.5 + point.x * 0.25, y: 0.5 - point.y * 0.25, z: -point.z, visibility: 0.98 };
  }
  const cleaned = { pose, poseWorld, face: [], leftHand: [], rightHand: [], blendshapes: {} };
  return { timestampMs, cleaned, raw: structuredClone(cleaned), confidence: 0.98, inferenceMs: 1 };
}

test('the 3D conversion is Y-up, retains anatomical left, and uses depth', () => {
  const frame = new MotionSolver3D().solve(input());
  assert.equal(frame.valid, true);
  assert.equal(frame.needsReview, false);
  assert.ok(frame.positions.head.y > frame.positions.hips.y);
  assert.ok(frame.positions.upperArmL.x > 0 && frame.positions.upperArmR.x < 0);
  assert.equal(frame.root.z, 0);
  const solver = new MotionSolver3D();
  const reference = solver.solve(input());
  const depth = input(40);
  depth.cleaned.poseWorld[13].z = -0.25;
  // Identical projected 2D points cannot explain this changed 3D limb rotation.
  assert.deepEqual(depth.cleaned.pose, input().cleaned.pose);
  const changed = solver.solve(depth);
  assert.ok(Math.abs(q(reference.rotations.upperArmL).dot(q(changed.rotations.upperArmL))) < 0.99);
  const pose = retargetFrame3D(changed, reference, createDefaultSkeleton3D());
  assert.ok(Math.abs(pose.positions.forearmL.z) > 0.1);
});

test('reference calibration exactly reproduces target rest, even for a posed reference', () => {
  const source = input();
  source.cleaned.poseWorld[13].y += 0.2;
  const reference = new MotionSolver3D().solve(source);
  const skeleton = createDefaultSkeleton3D();
  const rest = retargetFrame3D(reference, reference, skeleton);
  assert.equal(rest.valid, true);
  for (const name of HUMANOID_BONES) sameRotation(rest.rotations[name], skeleton.bones[name].restRotation, name);
  assert.deepEqual(rest.root, skeleton.bones.hips.offset);
});

test('fixed target offsets preserve every limb length through a depth-changing sequence', () => {
  const solver = new MotionSolver3D();
  const reference = solver.solve(input());
  const skeleton = createDefaultSkeleton3D();
  for (let index = 1; index <= 60; index++) {
    const source = input(index * 40);
    source.cleaned.poseWorld[13].z = Math.sin(index / 10) * 0.3;
    source.cleaned.poseWorld[25].z = Math.sin(index / 8) * 0.2;
    const pose = retargetFrame3D(solver.solve(source), reference, skeleton, { strength: 1.6 });
    for (const name of HUMANOID_BONES) {
      const parent = skeleton.bones[name].parent;
      if (parent) close(v(pose.positions[name]).distanceTo(v(pose.positions[parent])), v(skeleton.bones[name].offset).length(), name);
      close(q(pose.rotations[name]).length(), 1, name);
    }
  }
});

test('target bone rest axes are respected and strength zero returns the full rest pose', () => {
  const solver = new MotionSolver3D();
  const reference = solver.solve(input());
  const rotated = solver.solve(input(40, point => point.applyAxisAngle(new Vector3(0, 1, 0), 0.6)));
  const skeleton = createDefaultSkeleton3D();
  const restQ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.25);
  skeleton.bones.chest.restRotation = { x: restQ.x, y: restQ.y, z: restQ.z, w: restQ.w };
  const rest = retargetFrame3D(rotated, reference, skeleton, { strength: 0, inPlace: false });
  for (const name of HUMANOID_BONES) sameRotation(rest.rotations[name], skeleton.bones[name].restRotation, name);
  assert.deepEqual(rest.root, skeleton.bones.hips.offset);
  const pose = retargetFrame3D(rotated, reference, skeleton);
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);
  sameRotation(pose.rotations.hips, yaw);
  sameRotation(pose.rotations.chest, skeleton.bones.chest.restRotation);
  sameRotation(pose.rotations.forearmL, skeleton.bones.forearmL.restRotation);
});

test('root travel is image-derived XY only; in-place locks horizontal travel while preserving body height', () => {
  const solver = new MotionSolver3D();
  const reference = solver.solve(input());
  const moved = input(40);
  moved.cleaned.pose.forEach(point => { point.x += 0.1; point.y -= 0.05; });
  const frame = solver.solve(moved);
  const skeleton = createDefaultSkeleton3D();
  const normal = retargetFrame3D(frame, reference, skeleton, { strength: 1, inPlace: false });
  const double = retargetFrame3D(frame, reference, skeleton, { strength: 2, inPlace: false });
  close(normal.root.x, 0.41);
  close(normal.root.y - skeleton.bones.hips.offset.y, 0.205);
  close(double.root.x, normal.root.x * 2);
  close(double.root.y - skeleton.bones.hips.offset.y, (normal.root.y - skeleton.bones.hips.offset.y) * 2);
  assert.equal(normal.root.z, 0);
  const inPlace = retargetFrame3D(frame, reference, skeleton, { inPlace: true });
  assert.equal(inPlace.root.x, skeleton.bones.hips.offset.x);
  assert.equal(inPlace.root.y, normal.root.y);
  assert.equal(inPlace.root.z, skeleton.bones.hips.offset.z);
});

test('short gaps are explicitly held, long gaps become unavailable without invented motion', () => {
  const solver = new MotionSolver3D();
  const reference = solver.solve(input());
  const missing = input(50);
  missing.cleaned.poseWorld[15].visibility = 0;
  const held = solver.solve(missing);
  assert.equal(held.held.forearmL, true);
  assert.equal(held.needsReview, true);
  sameRotation(held.rotations.forearmL, reference.rotations.forearmL);
  const lost = input(250);
  lost.cleaned.poseWorld[15].visibility = 0;
  const frame = solver.solve(lost);
  assert.equal(frame.confidence.forearmL, 0);
  assert.equal(frame.confidence.handL, 0);
  assert.equal(frame.held.forearmL, false);
  assert.equal(frame.valid, true);
  const absent = input(500);
  absent.cleaned.poseWorld = [];
  const invalid = solver.solve(absent);
  assert.equal(invalid.valid, false);
  const pose = retargetFrame3D(invalid, reference, createDefaultSkeleton3D());
  assert.equal(pose.valid, false);
  assert.ok(HUMANOID_BONES.every(name => pose.confidence[name] === 0));
});

test('quaternion signs stay continuous across a full body turn', () => {
  const solver = new MotionSolver3D();
  let previous = solver.solve(input());
  for (let index = 1; index <= 80; index++) {
    const next = solver.solve(input(index * 40, point => point.applyAxisAngle(new Vector3(0, 1, 0), index * 0.09)));
    for (const name of HUMANOID_BONES) assert.ok(q(previous.rotations[name]).dot(q(next.rotations[name])) >= 0, name);
    previous = next;
  }
});

test('inputs remain immutable, source scale stays fixed, and invalid chronology is rejected', () => {
  const solver = new MotionSolver3D({ aspectRatio: 16 / 9 });
  const source = input();
  const copy = structuredClone(source);
  const reference = solver.solve(source);
  assert.deepEqual(source, copy);
  const larger = solver.solve(input(40, point => point.multiplyScalar(1.2)));
  assert.equal(larger.scale, reference.scale);
  assert.throws(() => solver.solve(input(40)), /strictly increasing/);
  assert.throws(() => new MotionSolver3D({ aspectRatio: 0 }), /positive/);
  assert.throws(() => new MotionSolver3D().solve(input(Number.NaN)), /finite/);
  const badSkeleton = createDefaultSkeleton3D();
  badSkeleton.bones.handL.offset.x = Number.NaN;
  assert.throws(() => validateSkeleton3D(badSkeleton), /Invalid rest transform/);
});

test('coincident joints remain valid rotation nodes without affecting finite FK', () => {
  const skeleton = createDefaultSkeleton3D();
  skeleton.bones.chest.offset = { x: 0, y: 0, z: 0 };
  validateSkeleton3D(skeleton);
  const reference = new MotionSolver3D().solve(input());
  const pose = retargetFrame3D(reference, reference, skeleton);
  assert.deepEqual(pose.positions.chest, pose.positions.spine);
  assert.ok(HUMANOID_BONES.every(name => Object.values(pose.positions[name]).every(Number.isFinite)));
});

test('reference selection skips invalid data and prefers an observed pose over held data', () => {
  const solver = new MotionSolver3D();
  const first = input();
  first.cleaned.poseWorld = [];
  const invalid = solver.solve(first);
  const good = solver.solve(input(50));
  const absent = input(100); absent.cleaned.poseWorld = [];
  const held = solver.solve(absent);
  assert.equal(chooseReference3D([invalid, held, good]), good);
  assert.equal(chooseReference3D([invalid]), undefined);
});

function armsDown(timestampMs = 0): MotionFrame {
  const frame = input(timestampMs);
  for (const [index, x, y, z] of [
    [13, 0.22, 0.1, 0], [15, 0.22, -0.17, 0], [17, 0.21, -0.28, 0], [19, 0.23, -0.28, 0],
    [14, -0.22, 0.1, 0], [16, -0.22, -0.17, 0], [18, -0.21, -0.28, 0], [20, -0.23, -0.28, 0],
  ]) frame.cleaned.poseWorld[index] = { x, y: -y, z: -z, visibility: 0.98 };
  return frame;
}

test('anatomical calibration maps an arms-down performer onto a T-pose target without requiring a T-pose recording', () => {
  const frame = new MotionSolver3D().solve(armsDown());
  const skeleton = createDefaultSkeleton3D();
  const pose = retargetFrame3D(frame, frame, skeleton, { calibration: 'anatomical' });
  assert.equal(pose.valid, true);
  for (const side of ['L', 'R']) {
    const upper = `upperArm${side}` as Bone3D, lower = `forearm${side}` as Bone3D, hand = `hand${side}` as Bone3D;
    const upperDirection = v(pose.positions[lower]).sub(v(pose.positions[upper])).normalize();
    const lowerDirection = v(pose.positions[hand]).sub(v(pose.positions[lower])).normalize();
    assert.ok(upperDirection.distanceTo(new Vector3(0, -1, 0)) < 1e-9);
    assert.ok(lowerDirection.distanceTo(new Vector3(0, -1, 0)) < 1e-9);
  }
  const strengthZero = retargetFrame3D(frame, frame, skeleton, { calibration: 'anatomical', strength: 0 });
  for (const name of HUMANOID_BONES) sameRotation(strengthZero.rotations[name], skeleton.bones[name].restRotation);
});

test('anatomical transfer respects A-pose rest geometry, arbitrary bone roll, target facing, and 3D depth', () => {
  const solver = new MotionSolver3D();
  const reference = solver.solve(armsDown());
  const source = armsDown(40);
  source.cleaned.poseWorld[15].y = 0.1;
  source.cleaned.poseWorld[15].z = -0.20;
  source.cleaned.poseWorld[17] = { x: 0.21, y: 0.18, z: -0.28, visibility: 0.98 };
  source.cleaned.poseWorld[19] = { x: 0.23, y: 0.18, z: -0.28, visibility: 0.98 };
  const frame = solver.solve(source);
  const skeleton = createDefaultSkeleton3D();
  const facing = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8);
  skeleton.bones.hips.restRotation = facing;
  for (const [name, sign] of [['upperArmL', -1], ['upperArmR', 1]] as const) {
    skeleton.bones[name].restRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), sign * 0.4)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), sign * 0.6));
  }
  skeleton.bones.forearmL.restRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.25);
  const pose = retargetFrame3D(frame, reference, skeleton, { calibration: 'anatomical' });
  const upper = v(pose.positions.forearmL).sub(v(pose.positions.upperArmL)).normalize();
  const lower = v(pose.positions.handL).sub(v(pose.positions.forearmL)).normalize();
  const expectedLower = new Vector3(0, -0.2, 0.2).normalize().applyQuaternion(facing);
  assert.ok(upper.distanceTo(new Vector3(0, -1, 0)) < 1e-9);
  assert.ok(lower.distanceTo(expectedLower) < 1e-9);
});

test('anatomical reference calibrates body orientation and does not freeze a limb absent from the reference', () => {
  const solver = new MotionSolver3D();
  const referenceSource = input(0, point => point.applyAxisAngle(new Vector3(0, 1, 0), 0.6));
  referenceSource.cleaned.poseWorld[15].visibility = 0;
  const reference = solver.solve(referenceSource);
  const frame = solver.solve(input(40, point => point.applyAxisAngle(new Vector3(0, 1, 0), 1.0)));
  const pose = retargetFrame3D(frame, reference, createDefaultSkeleton3D(), { calibration: 'anatomical' });
  sameRotation(pose.rotations.hips, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4));
  assert.ok(reference.confidence.forearmL < 0.35);
  assert.ok(pose.confidence.forearmL >= 0.35);
  assert.equal(pose.needsReview, false);
});
