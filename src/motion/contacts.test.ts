import assert from 'node:assert/strict';
import test from 'node:test';
import { FootContactDetector } from './contacts.ts';
import { JOINT_NAMES } from './canonical.ts';
import type { CanonicalFrame } from './canonical.ts';

function frame(timestampMs: number, rootX = 0): CanonicalFrame {
  return {
    timestampMs, root: { x: rootX, y: 0 }, scale: 0.3,
    joints: Object.fromEntries(JOINT_NAMES.map(name => [name, { x: 0, y: 1, confidence: 1 }])) as CanonicalFrame['joints'],
    bones: {} as CanonicalFrame['bones'], valid: true, needsReview: false, contacts: { left: false, right: false },
  };
}

test('contacts need multiple stable observations and a minimum duration', () => {
  const detector = new FootContactDetector();
  assert.equal(detector.process(frame(0)).left, false);
  assert.equal(detector.process(frame(50)).left, false);
  assert.equal(detector.process(frame(100)).left, true);
});

test('global source motion cannot look stationary merely because local foot coordinates are unchanged', () => {
  const detector = new FootContactDetector();
  detector.process(frame(0));
  detector.process(frame(50, 0.02));
  assert.equal(detector.process(frame(100, 0.04)).left, false);
});

test('missing, held and widely spaced observations clear a contact candidate', () => {
  const detector = new FootContactDetector();
  detector.process(frame(0)); detector.process(frame(50));
  assert.equal(detector.process(frame(100)).left, true);
  const held = frame(150);
  held.joints.ankleL.held = true;
  assert.equal(detector.process(held).left, false);
  assert.equal(detector.process(frame(600)).right, false);
  const lost = frame(650);
  lost.valid = false;
  assert.deepEqual(detector.process(lost), { left: false, right: false });
});
