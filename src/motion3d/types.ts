/** Right-handed coordinates: X image-right, Y up, Z toward the camera. */
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

/** Parent-first order. Left and right always mean the performer's anatomical sides. */
export const HUMANOID_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'forearmL', 'handL', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
export type Bone3D = typeof HUMANOID_BONES[number];

export const HUMANOID_PARENTS: Record<Bone3D, Bone3D | null> = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  upperArmL: 'chest', forearmL: 'upperArmL', handL: 'forearmL',
  upperArmR: 'chest', forearmR: 'upperArmR', handR: 'forearmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
};

export interface Joint3D extends Vec3 { confidence: number; held?: boolean }
export interface SkeletonBone3D {
  parent: Bone3D | null;
  /** Translation from the parent joint in the parent's rest coordinate frame. */
  offset: Vec3;
  /** Local rest rotation. Offsets of children are rotated by this transform. */
  restRotation: Quat;
  /** Leaf extension in this bone's local frame (for a mesh or BVH End Site). */
  endOffset?: Vec3;
}
export interface Skeleton3D {
  name: string;
  /** All distances use target units; the default skeleton uses meters. */
  bones: Record<Bone3D, SkeletonBone3D>;
}

export interface Motion3DFrame {
  timestampMs: number;
  /** Parent-local source rotations; normalized and sign-continuous over time. */
  rotations: Record<Bone3D, Quat>;
  /** Bone origin positions, relative to the pelvis in fixed source torso units. */
  positions: Record<Bone3D, Joint3D>;
  confidence: Record<Bone3D, number>;
  held: Record<Bone3D, boolean>;
  /** Image-derived XY root in fixed torso units. Z is always zero: global depth is unknown. */
  root: Vec3;
  /** Whether a usable image-space root observation (or an explicit short hold) exists. */
  rootTracked: boolean;
  /** Initial measured hip-center to shoulder-center distance in MediaPipe world units. */
  scale: number;
  valid: boolean;
  needsReview: boolean;
}

export interface Pose3D {
  timestampMs: number;
  /** Target parent-local rotations, including target rest rotations. */
  rotations: Record<Bone3D, Quat>;
  /** Target bone origins from fixed-length forward kinematics, in target units. */
  positions: Record<Bone3D, Vec3>;
  /** Absolute root location, including skeleton.bones.hips.offset. */
  root: Vec3;
  confidence: Record<Bone3D, number>;
  valid: boolean;
  needsReview: boolean;
}
