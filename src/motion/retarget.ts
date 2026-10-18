import {
  BONE_JOINTS, BONE_NAMES, BONE_PARENTS, JOINT_NAMES, boneAngle, distance, wrapAngle,
} from './canonical.ts';
import type { BoneName, CanonicalFrame, JointName, Vec2 } from './canonical.ts';

export interface RetargetedPose {
  joints: Record<JointName, Vec2>;
  rotations: Record<BoneName, number>;
  confidence: Record<BoneName, number>;
  rootTranslation: Vec2;
  valid: boolean;
  needsReview: boolean;
}

export interface RetargetOptions { strength: number; inPlace: boolean }
export interface RetargetRig { joints: Record<JointName, Vec2> }

function rotate(point: Vec2, radians: number): Vec2 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
}

/** Forward kinematics: source supplies local angle deltas; the target supplies every length. */
export function retargetPose(
  frame: CanonicalFrame,
  reference: CanonicalFrame,
  rig: RetargetRig,
  options: RetargetOptions,
): RetargetedPose {
  if (!Number.isFinite(options.strength) || options.strength < 0 || options.strength > 3) {
    throw new Error('Motion strength must be between zero and three.');
  }
  for (const name of JOINT_NAMES) {
    if (!Number.isFinite(rig.joints[name]?.x) || !Number.isFinite(rig.joints[name]?.y)) {
      throw new Error(`The character rig is missing a finite ${name} joint.`);
    }
  }
  const targetScale = distance(rig.joints.pelvis, rig.joints.chest);
  if (targetScale < 1e-5) throw new Error('The character torso must have a positive length.');
  const valid = frame.valid && reference.valid && reference.scale > 1e-5;
  const rootTranslation = options.inPlace || !valid
    ? { x: 0, y: 0 }
    : {
      x: (frame.root.x - reference.root.x) / reference.scale * targetScale * options.strength,
      y: (frame.root.y - reference.root.y) / reference.scale * targetScale * options.strength,
    };
  const restAngles = {} as Record<BoneName, number>;
  const rotations = {} as Record<BoneName, number>;
  const confidence = {} as Record<BoneName, number>;
  for (const name of BONE_NAMES) {
    const [start, end] = BONE_JOINTS[name];
    restAngles[name] = boneAngle(rig.joints[start], rig.joints[end]);
    const parent = BONE_PARENTS[name];
    const restLocalAngle = wrapAngle(restAngles[name] - (parent ? restAngles[parent] : 0));
    const sourceValid = valid && frame.bones[name].confidence >= 0.35 && reference.bones[name].confidence >= 0.35;
    const delta = sourceValid ? wrapAngle(frame.bones[name].localAngle - reference.bones[name].localAngle) * options.strength : 0;
    rotations[name] = wrapAngle((parent ? rotations[parent] : 0) + restLocalAngle + delta);
    confidence[name] = sourceValid ? Math.min(frame.bones[name].confidence, reference.bones[name].confidence) : 0;
  }
  const torsoRotation = wrapAngle(rotations.torso - restAngles.torso);
  const restRoot = rig.joints.pelvis;
  const root = { x: restRoot.x + rootTranslation.x, y: restRoot.y + rootTranslation.y };
  const joints = {} as Record<JointName, Vec2>;
  // Torso attachment points rotate as one body, including both shoulder and hip widths.
  for (const name of JOINT_NAMES) {
    const offset = rotate({ x: rig.joints[name].x - restRoot.x, y: rig.joints[name].y - restRoot.y }, torsoRotation);
    joints[name] = { x: root.x + offset.x, y: root.y + offset.y };
  }
  for (const name of BONE_NAMES) {
    if (name === 'torso') continue; // torso's neck endpoint was already transformed as an attachment.
    const [startName, endName] = BONE_JOINTS[name];
    const start = joints[startName];
    const length = distance(rig.joints[startName], rig.joints[endName]);
    joints[endName] = { x: start.x + Math.cos(rotations[name]) * length, y: start.y + Math.sin(rotations[name]) * length };
  }
  return { joints, rotations, confidence, rootTranslation, valid, needsReview: frame.needsReview || reference.needsReview || !valid };
}
