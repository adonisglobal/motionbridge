import assert from 'node:assert/strict';
import test from 'node:test';
import { BONE_JOINTS, BONE_NAMES, BONE_PARENTS, JOINT_NAMES, boneAngle, distance, wrapAngle } from './canonical.ts';
import type { CanonicalFrame, JointName, Vec2 } from './canonical.ts';
import { retargetPose } from './retarget.ts';

function fixture(): { frame: CanonicalFrame; rig: { joints: Record<JointName, Vec2> } } {
  const joints: Record<JointName, Vec2> = {
    pelvis: { x: 400, y: 300 }, spine: { x: 400, y: 250 }, chest: { x: 400, y: 200 },
    neck: { x: 400, y: 180 }, head: { x: 400, y: 140 },
    shoulderL: { x: 350, y: 200 }, elbowL: { x: 310, y: 240 }, wristL: { x: 300, y: 280 }, handL: { x: 295, y: 295 },
    shoulderR: { x: 450, y: 200 }, elbowR: { x: 490, y: 240 }, wristR: { x: 500, y: 280 }, handR: { x: 505, y: 295 },
    hipL: { x: 375, y: 300 }, kneeL: { x: 375, y: 360 }, ankleL: { x: 375, y: 420 }, toeL: { x: 355, y: 430 },
    hipR: { x: 425, y: 300 }, kneeR: { x: 425, y: 360 }, ankleR: { x: 425, y: 420 }, toeR: { x: 445, y: 430 },
  };
  const frame: CanonicalFrame = {
    timestampMs: 0, root: { x: 0.5, y: 0.6 }, scale: 0.3,
    joints: Object.fromEntries(JOINT_NAMES.map(name => [name, {
      x: (joints[name].x - 400) / 100, y: (joints[name].y - 300) / 100, confidence: 1,
    }])) as CanonicalFrame['joints'],
    bones: {} as CanonicalFrame['bones'], valid: true, needsReview: false, contacts: { left: false, right: false },
  };
  for (const name of BONE_NAMES) {
    const [start, end] = BONE_JOINTS[name];
    const angle = boneAngle(joints[start], joints[end]);
    const parent = BONE_PARENTS[name];
    frame.bones[name] = { angle, localAngle: wrapAngle(angle - (parent ? frame.bones[parent].angle : 0)), confidence: 1 };
  }
  return { frame, rig: { joints } };
}

function close(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`); }

test('reference pose maps to the character rest pose without copying source body proportions', () => {
  const { frame, rig } = fixture();
  rig.joints.wristL = { x: 260, y: 300 };
  rig.joints.handL = { x: 250, y: 315 };
  const pose = retargetPose(frame, frame, rig, { strength: 1, inPlace: false });
  for (const name of JOINT_NAMES) {
    close(pose.joints[name].x, rig.joints[name].x);
    close(pose.joints[name].y, rig.joints[name].y);
  }
});

test('torso rotation moves shoulder and hip attachments and FK preserves all target bone lengths', () => {
  const { frame: reference, rig } = fixture();
  const frame = structuredClone(reference);
  frame.bones.torso.localAngle += Math.PI / 3;
  frame.bones.upperArmL.localAngle += 0.35;
  const pose = retargetPose(frame, reference, rig, { strength: 1, inPlace: true });
  for (const name of BONE_NAMES) {
    const [start, end] = BONE_JOINTS[name];
    close(distance(pose.joints[start], pose.joints[end]), distance(rig.joints[start], rig.joints[end]));
  }
  close(distance(pose.joints.shoulderL, pose.joints.shoulderR), distance(rig.joints.shoulderL, rig.joints.shoulderR));
  close(distance(pose.joints.hipL, pose.joints.hipR), distance(rig.joints.hipL, rig.joints.hipR));
  close(wrapAngle(boneAngle(pose.joints.pelvis, pose.joints.chest) - boneAngle(rig.joints.pelvis, rig.joints.chest)), Math.PI / 3);
});

test('angle deltas cross the -pi/pi boundary along the short arc', () => {
  const { frame: reference, rig } = fixture();
  reference.bones.forearmL.localAngle = Math.PI - 0.02;
  const frame = structuredClone(reference);
  frame.bones.forearmL.localAngle = -Math.PI + 0.03;
  const pose = retargetPose(frame, reference, rig, { strength: 1, inPlace: true });
  close(wrapAngle(pose.rotations.forearmL - boneAngle(rig.joints.elbowL, rig.joints.wristL)), 0.05);
});

test('in-place removes global motion; keep movement scales it to target torso units', () => {
  const { frame: reference, rig } = fixture();
  const frame = structuredClone(reference);
  frame.root.x += 0.15;
  frame.root.y += 0.03;
  const moving = retargetPose(frame, reference, rig, { strength: 1, inPlace: false });
  close(moving.rootTranslation.x, 50);
  close(moving.rootTranslation.y, 10);
  const fixed = retargetPose(frame, reference, rig, { strength: 1, inPlace: true });
  close(fixed.joints.pelvis.x, rig.joints.pelvis.x);
  close(fixed.joints.pelvis.y, rig.joints.pelvis.y);
});

test('zero strength returns rest rotations and invalid observations cannot masquerade as tracked motion', () => {
  const { frame: reference, rig } = fixture();
  const frame = structuredClone(reference);
  frame.bones.upperArmL.localAngle += 1;
  frame.root.x += .15;
  frame.root.y += .1;
  const neutral = retargetPose(frame, reference, rig, { strength: 0, inPlace: false });
  close(neutral.rotations.upperArmL, boneAngle(rig.joints.shoulderL, rig.joints.elbowL));
  close(neutral.rootTranslation.x, 0);
  close(neutral.rootTranslation.y, 0);
  for (const name of JOINT_NAMES) {
    close(neutral.joints[name].x, rig.joints[name].x);
    close(neutral.joints[name].y, rig.joints[name].y);
  }
  frame.valid = false;
  const invalid = retargetPose(frame, reference, rig, { strength: 1, inPlace: false });
  assert.equal(invalid.valid, false);
  assert.ok(BONE_NAMES.every(name => invalid.confidence[name] === 0));
  assert.ok(JOINT_NAMES.every(name => Number.isFinite(invalid.joints[name].x) && Number.isFinite(invalid.joints[name].y)));
});
