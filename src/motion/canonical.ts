export interface Vec2 { x: number; y: number }

export const JOINT_NAMES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL', 'handL',
  'shoulderR', 'elbowR', 'wristR', 'handR',
  'hipL', 'kneeL', 'ankleL', 'toeL',
  'hipR', 'kneeR', 'ankleR', 'toeR',
] as const;
export type JointName = typeof JOINT_NAMES[number];

export const BONE_NAMES = [
  'torso', 'head', 'upperArmL', 'forearmL', 'handL',
  'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
export type BoneName = typeof BONE_NAMES[number];

export const BONE_JOINTS: Record<BoneName, readonly [JointName, JointName]> = {
  torso: ['pelvis', 'neck'], head: ['neck', 'head'],
  upperArmL: ['shoulderL', 'elbowL'], forearmL: ['elbowL', 'wristL'], handL: ['wristL', 'handL'],
  upperArmR: ['shoulderR', 'elbowR'], forearmR: ['elbowR', 'wristR'], handR: ['wristR', 'handR'],
  thighL: ['hipL', 'kneeL'], shinL: ['kneeL', 'ankleL'], footL: ['ankleL', 'toeL'],
  thighR: ['hipR', 'kneeR'], shinR: ['kneeR', 'ankleR'], footR: ['ankleR', 'toeR'],
};

// Topological order is BONE_NAMES: each parent is evaluated before its children.
export const BONE_PARENTS: Record<BoneName, BoneName | null> = {
  torso: null, head: 'torso',
  upperArmL: 'torso', forearmL: 'upperArmL', handL: 'forearmL',
  upperArmR: 'torso', forearmR: 'upperArmR', handR: 'forearmR',
  thighL: 'torso', shinL: 'thighL', footL: 'shinL',
  thighR: 'torso', shinR: 'thighR', footR: 'shinR',
};

export interface CanonicalJoint extends Vec2 {
  confidence: number;
  /** A short, explicitly flagged hold of the last observation; never longer than 150 ms. */
  held?: boolean;
}
export interface CanonicalBone { angle: number; localAngle: number; confidence: number }
export interface FootContacts { left: boolean; right: boolean }

export interface CanonicalFrame {
  timestampMs: number;
  /** Absolute source coordinates in image-height units: { x: normalizedX * aspect, y: normalizedY }. */
  root: Vec2;
  /** Shoulder-center to hip-center distance, fixed at the first reliable torso observation. */
  scale: number;
  /** Root-relative, divided by scale. Missing joints have confidence zero. */
  joints: Record<JointName, CanonicalJoint>;
  bones: Record<BoneName, CanonicalBone>;
  /** Reliable torso/root; individual limbs can still need review. */
  valid: boolean;
  needsReview: boolean;
  /** Low-velocity contact candidates, not an IK foot lock. */
  contacts: FootContacts;
}

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function boneAngle(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
