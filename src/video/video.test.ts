import test from 'node:test';
import assert from 'node:assert/strict';
import type { MotionFrame, LandmarkSet } from '../tracking/types.ts';
import { createSampleTimes, findMotionFrame } from './video.ts';

function motionFrame(timestampMs: number): MotionFrame {
  const empty: LandmarkSet = {
    pose: [], poseWorld: [], face: [], leftHand: [], rightHand: [], blendshapes: {},
  };
  return { timestampMs, raw: empty, cleaned: empty, confidence: 0, inferenceMs: 0 };
}

test('sampling follows analysis FPS and never includes the duration endpoint', () => {
  for (const fps of [12, 24, 30]) {
    const times = createSampleTimes(2, fps);
    assert.equal(times.length, 2 * fps);
    assert.equal(times[0], 0);
    assert.equal(times[1], 1000 / fps);
    assert.ok(times.every((timestamp, index) => timestamp === index * 1000 / fps));
    assert.ok(times.every((timestamp) => timestamp < 2000));
  }
});

test('short and fractional video lengths sample from zero without a duplicate tail', () => {
  assert.deepEqual(createSampleTimes(0, 24), []);
  assert.deepEqual(createSampleTimes(0.001, 24), [0]);
  assert.equal(createSampleTimes(2.1, 30).length, 63);
  assert.equal(createSampleTimes(1.01, 24).length, 25);
  assert.equal(createSampleTimes(1 / 12, 12).length, 1);
});

test('sampling rejects invalid durations and rates', () => {
  for (const duration of [-1, Number.NaN, Infinity]) {
    assert.throws(() => createSampleTimes(duration, 24), RangeError);
  }
  for (const fps of [0, -1, Number.NaN, Infinity]) {
    assert.throws(() => createSampleTimes(1, fps), RangeError);
  }
});

test('nearest frame lookup uses timestamps with a deterministic earlier tie', () => {
  const frames = [0, 40, 80, 120].map(motionFrame);
  assert.equal(findMotionFrame(frames, 0), frames[0]);
  assert.equal(findMotionFrame(frames, 0.061), frames[2]);
  assert.equal(findMotionFrame(frames, 0.06), frames[1]);
  assert.equal(findMotionFrame(frames, 0.12), frames[3]);
});

test('partial analysis does not leave the last pose over the unanalyzed clip', () => {
  const frames = [0, 1000 / 24, 2000 / 24].map(motionFrame);
  assert.equal(findMotionFrame(frames, 0.1), frames[2]);
  assert.equal(findMotionFrame(frames, 0.105), undefined);
  assert.equal(findMotionFrame(frames, 5), undefined);
  assert.equal(findMotionFrame(frames, -0.001), undefined);
  assert.equal(findMotionFrame(frames, Number.NaN), undefined);
  assert.equal(findMotionFrame([], 0), undefined);
});

test('lookup does not extrapolate before coverage and treats a lone sample conservatively', () => {
  const frames = [100, 100 + 1000 / 30].map(motionFrame);
  assert.equal(findMotionFrame(frames, 0.083), undefined);
  assert.equal(findMotionFrame(frames, 0.084), frames[0]);
  const single = [motionFrame(0)];
  assert.equal(findMotionFrame(single, 0), single[0]);
  assert.equal(findMotionFrame(single, 0.009), undefined);
});
