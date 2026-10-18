import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyConfidence, LandmarkSmoother, MAX_FILTER_GAP_MS, OneEuroFilter } from './filters.ts';
import type { LandmarkSet } from '../tracking/types.ts';

function sample(x: number): LandmarkSet {
  return {
    pose: [{ x, y: 0.5, z: 0, visibility: 0.9 }],
    poseWorld: [],
    face: [],
    leftHand: [],
    rightHand: [],
    blendshapes: { smile: x },
  };
}

test('raw preset returns independent values without mutating measurements', () => {
  const input = sample(0.3);
  const result = new LandmarkSmoother('raw').process(input, 0);
  assert.deepEqual(result, input);
  result.pose[0].x = 1;
  result.blendshapes.smile = 1;
  assert.equal(input.pose[0].x, 0.3);
  assert.equal(input.blendshapes.smile, 0.3);
});

test('one euro reduces stationary jitter while preserving a fixed signal', () => {
  const filter = new OneEuroFilter();
  let rawEnergy = 0;
  let cleanedEnergy = 0;
  for (let index = 0; index < 120; index++) {
    const value = 0.5 + (index % 2 ? 0.025 : -0.025);
    const cleaned = filter.filter(value, index * 1000 / 30);
    if (index > 20) {
      rawEnergy += (value - 0.5) ** 2;
      cleanedEnergy += (cleaned - 0.5) ** 2;
    }
  }
  assert.ok(cleanedEnergy < rawEnergy * 0.2);
  assert.equal(new OneEuroFilter().filter(0.5, 0), 0.5);
});

test('timestamp spacing controls smoothing and long gaps reset instead of inventing a trajectory', () => {
  const fast = new OneEuroFilter();
  const slow = new OneEuroFilter();
  fast.filter(0, 0);
  slow.filter(0, 0);
  assert.ok(slow.filter(1, 100) > fast.filter(1, 10));
  assert.equal(fast.filter(0.75, MAX_FILTER_GAP_MS + 20), 0.75);
});

test('smoother does not fill missing detections and reacquires after a long gap', () => {
  const smoother = new LandmarkSmoother('balanced');
  smoother.process(sample(0), 0);
  const missing = sample(0);
  missing.pose = [];
  missing.blendshapes = {};
  assert.deepEqual(smoother.process(missing, 100).pose, []);
  const result = smoother.process(sample(0.9), 600);
  assert.equal(result.pose[0].x, 0.9);
  assert.equal(result.blendshapes.smile, 0.9);
});

test('stronger presets reduce noise further and never change raw input', () => {
  const input = sample(1);
  const light = new LandmarkSmoother('light');
  const smooth = new LandmarkSmoother('smooth');
  light.process(sample(0), 0);
  smooth.process(sample(0), 0);
  assert.ok(smooth.process(input, 33).pose[0].x < light.process(input, 33).pose[0].x);
  assert.equal(input.pose[0].x, 1);
});

test('body confidence includes missing joints and clamps invalid scores', () => {
  assert.equal(bodyConfidence([]), 0);
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.8 }));
  assert.ok(Math.abs(bodyConfidence(pose) - 0.8) < 1e-12);
  pose[11].visibility = NaN;
  assert.ok(Math.abs(bodyConfidence(pose) - 0.8 * 11 / 12) < 1e-12);
});
