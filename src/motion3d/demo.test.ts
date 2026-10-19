import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { createDemo3D } from './demo.ts';
import { createDefaultSkeleton3D, retargetFrame3D } from './retarget.ts';
import { HUMANOID_BONES } from './types.ts';

test('the procedural example covers six seconds with complete solver-processed body data', () => {
  const demo = createDemo3D();
  assert.equal(demo.source, 'synthetic');
  assert.equal(demo.durationSeconds, 6);
  assert.equal(demo.analysisFps, 24);
  assert.equal(demo.motionFrames.length, 144);
  assert.equal(demo.trackingFrames.length, 144);
  assert.ok(demo.motionFrames.every(frame => frame.valid && !frame.needsReview));
  assert.ok(demo.trackingFrames.every(frame => frame.cleaned.poseWorld.length === 33 && frame.cleaned.pose.length === 33));
  assert.equal(demo.trackingFrames[0].inferenceMs, 0);
  const first = demo.motionFrames[0], last = demo.motionFrames.at(-1)!;
  for (const name of HUMANOID_BONES) {
    const a = new Quaternion().copy(first.rotations[name]), b = new Quaternion().copy(last.rotations[name]);
    assert.ok(Math.abs(a.dot(b)) > 1 - 1e-9, name);
  }
});

test('the example has actual depth changes, squat, arm articulation, and root movement with fixed target lengths', () => {
  const demo = createDemo3D(30);
  const skeleton = createDefaultSkeleton3D();
  const reference = demo.motionFrames[0];
  const poses = demo.motionFrames.map(frame => retargetFrame3D(frame, reference, skeleton, { inPlace: false, calibration: 'anatomical' }));
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);
  assert.ok(range(poses.map(pose => pose.positions.forearmL.z)) > 0.1);
  assert.ok(range(poses.map(pose => pose.positions.handL.y)) > 0.2);
  assert.ok(range(poses.map(pose => pose.root.y)) > 0.1);
  assert.ok(range(poses.map(pose => pose.root.x)) > 0.05);
  for (const pose of poses) for (const name of HUMANOID_BONES) {
    const parent = skeleton.bones[name].parent;
    if (!parent) continue;
    const a = new Vector3().copy(pose.positions[name]), b = new Vector3().copy(pose.positions[parent]);
    const rest = new Vector3().copy(skeleton.bones[name].offset).length();
    assert.ok(Math.abs(a.distanceTo(b) - rest) < 1e-9, name);
  }
  assert.throws(() => createDemo3D(0), /FPS/);
  assert.throws(() => createDemo3D(24.5), /FPS/);
});

test('in-place playback retains the example squat height instead of lifting both feet', () => {
  const demo = createDemo3D();
  const skeleton = createDefaultSkeleton3D();
  const poses = demo.motionFrames.map(frame => retargetFrame3D(frame, demo.motionFrames[0], skeleton, { inPlace: true, calibration: 'anatomical' }));
  assert.ok(Math.min(...poses.map(pose => pose.root.y)) < skeleton.bones.hips.offset.y - 0.15);
  assert.ok(poses.every(pose => pose.root.x === skeleton.bones.hips.offset.x));
  // The original analytic leg motion has a stationary ankle height. This
  // regression checks root semantics, not an IK or contact-lock guarantee.
  for (const name of ['footL', 'footR'] as const) {
    const heights = poses.map(pose => pose.positions[name].y);
    assert.ok(Math.max(...heights) - Math.min(...heights) < 0.002);
  }
});
