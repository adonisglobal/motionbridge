import test from 'node:test';
import assert from 'node:assert/strict';
import { BONE_JOINTS, BONE_NAMES } from '../motion/canonical.ts';
import type { BoneName } from '../motion/canonical.ts';
import type { RetargetedPose } from '../motion/retarget.ts';
import { createRestJoints, guessBone, seedImageJoints, withPartAnchors } from './rig.ts';
import type { CharacterPart, CharacterRig } from './rig.ts';
import { getPartTransform, transformPartPoint } from './renderer.ts';

function fixture() {
  const rig: CharacterRig = { width: 360, height: 480, joints: createRestJoints(360, 480), parts: [], name: 'test' };
  const part: CharacterPart = {
    id: 'forearmL', name: 'forearm', bone: 'forearmL', image: {} as CanvasImageSource,
    width: 40, height: 100, pivot: { x: 20, y: 10 }, tip: { x: 20, y: 90 },
    restAngle: Math.PI / 2, drawOrder: 0, source: 'imported',
  };
  const rotations = Object.fromEntries(BONE_NAMES.map(name => {
    const [a, b] = BONE_JOINTS[name];
    return [name, Math.atan2(rig.joints[b].y - rig.joints[a].y, rig.joints[b].x - rig.joints[a].x)];
  })) as Record<BoneName, number>;
  const pose: RetargetedPose = {
    joints: structuredClone(rig.joints), rotations,
    confidence: Object.fromEntries(BONE_NAMES.map(name => [name, 1])) as Record<BoneName, number>,
    rootTranslation: { x: 0, y: 0 }, valid: true, needsReview: false,
  };
  return { rig, part, pose };
}

function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('a noncentral PNG pivot lands exactly on its parent joint', () => {
  const { rig, part, pose } = fixture();
  pose.joints.elbowL = { x: 173, y: 144 };
  pose.joints.wristL = { x: 223, y: 144 };
  pose.rotations.forearmL = 0;
  const transform = getPartTransform(rig, part, pose);
  const pivot = transformPartPoint(part.pivot, part, transform);
  close(pivot.x, 173); close(pivot.y, 144);
  const tip = transformPartPoint(part.tip, part, transform);
  close(tip.x, 223); close(tip.y, 144);
});

test('rest rendering preserves both anchors for every arbitrary rig angle', () => {
  const { rig, part } = fixture();
  const transform = getPartTransform(rig, part);
  const pivot = transformPartPoint(part.pivot, part, transform);
  const tip = transformPartPoint(part.tip, part, transform);
  close(pivot.x, rig.joints.elbowL.x); close(pivot.y, rig.joints.elbowL.y);
  close(tip.x, rig.joints.wristL.x); close(tip.y, rig.joints.wristL.y);
});

test('editing imported PNG anchors recomputes orientation and rejects zero-length bones', () => {
  const { part } = fixture();
  const edited = withPartAnchors(part, { x: 4, y: 5 }, { x: 34, y: 5 });
  close(edited.restAngle, 0);
  assert.deepEqual(edited.pivot, { x: 4, y: 5 });
  assert.equal(withPartAnchors(part, { x: 4, y: 5 }, { x: 4, y: 5 }), part);
});

test('part names accept planned PNG conventions without silently identifying unknown names', () => {
  assert.equal(guessBone('upper_arm_L.png'), 'upperArmL');
  assert.equal(guessBone('forearm_R.PNG'), 'forearmR');
  assert.equal(guessBone('torso.png'), 'torso');
  assert.equal(guessBone('arbitrary.png'), undefined);
});

test('manual image rig seeds stay inside visible alpha bounds rather than transparent margins', () => {
  const bounds = { x: 108, y: 14, width: 131, height: 343 };
  const joints = seedImageJoints(bounds);
  close(joints.neck.x, 177.43);
  close(joints.neck.y, 82.6);
  assert.ok(joints.shoulderL.x > 200 && joints.shoulderR.x < 150);
  for (const point of Object.values(joints)) {
    assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width);
    assert.ok(point.y >= bounds.y && point.y <= bounds.y + bounds.height);
  }
});
