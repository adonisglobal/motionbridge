import { Matrix4, Quaternion, Vector3 } from 'three';
import { HUMANOID_BONES, HUMANOID_PARENTS } from './types.ts';
import type { Bone3D, Motion3DFrame, Pose3D, Quat, Skeleton3D, Vec3 } from './types.ts';

const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
const q = (value: Quat) => new Quaternion(value.x, value.y, value.z, value.w).normalize();
const v = (value: Vec3) => new Vector3(value.x, value.y, value.z);
const plainQ = (value: Quaternion): Quat => ({ x: value.x, y: value.y, z: value.z, w: value.w });
const plainV = (value: Vector3): Vec3 => ({ x: value.x, y: value.y, z: value.z });

/** A symmetric T-pose humanoid, approximately 1.8 m tall, with forward along +Z. */
export function createDefaultSkeleton3D(): Skeleton3D {
  const offsets: Record<Bone3D, Vec3> = {
    hips: { x: 0, y: 0.98, z: 0 }, spine: { x: 0, y: 0.18, z: 0 },
    chest: { x: 0, y: 0.19, z: 0 }, neck: { x: 0, y: 0.12, z: 0 }, head: { x: 0, y: 0.13, z: 0 },
    upperArmL: { x: 0.22, y: 0.04, z: 0 }, forearmL: { x: 0.30, y: 0, z: 0 }, handL: { x: 0.27, y: 0, z: 0 },
    upperArmR: { x: -0.22, y: 0.04, z: 0 }, forearmR: { x: -0.30, y: 0, z: 0 }, handR: { x: -0.27, y: 0, z: 0 },
    thighL: { x: 0.105, y: -0.04, z: 0 }, shinL: { x: 0, y: -0.44, z: 0 }, footL: { x: 0, y: -0.43, z: 0 },
    thighR: { x: -0.105, y: -0.04, z: 0 }, shinR: { x: 0, y: -0.44, z: 0 }, footR: { x: 0, y: -0.43, z: 0 },
  };
  const ends: Partial<Record<Bone3D, Vec3>> = {
    head: { x: 0, y: 0.15, z: 0 }, handL: { x: 0.12, y: 0, z: 0 }, handR: { x: -0.12, y: 0, z: 0 },
    footL: { x: 0, y: -0.04, z: 0.17 }, footR: { x: 0, y: -0.04, z: 0.17 },
  };
  return { name: 'MotionBridge humanoid', bones: Object.fromEntries(HUMANOID_BONES.map(name => [name, {
    parent: HUMANOID_PARENTS[name], offset: offsets[name], restRotation: identity(),
    ...(ends[name] ? { endOffset: ends[name] } : {}),
  }])) as Skeleton3D['bones'] };
}

/** Reject malformed mappings instead of emitting NaN transforms or evaluating cyclic hierarchies. */
export function validateSkeleton3D(skeleton: Skeleton3D): void {
  const visited = new Set<Bone3D>();
  for (const name of HUMANOID_BONES) {
    const bone = skeleton.bones[name];
    if (!bone || bone.parent !== HUMANOID_PARENTS[name] || (bone.parent && !visited.has(bone.parent))) {
      throw new Error(`Invalid humanoid hierarchy at ${name}.`);
    }
    if (![bone.offset.x, bone.offset.y, bone.offset.z].every(Number.isFinite) ||
        ![bone.restRotation.x, bone.restRotation.y, bone.restRotation.z, bone.restRotation.w].every(Number.isFinite) ||
        Math.hypot(bone.restRotation.x, bone.restRotation.y, bone.restRotation.z, bone.restRotation.w) < 1e-8 ||
        (bone.endOffset && ![bone.endOffset.x, bone.endOffset.y, bone.endOffset.z].every(Number.isFinite))) {
      throw new Error(`Invalid rest transform at ${name}.`);
    }
    // Coincident joints are valid rotation nodes in real armatures. No target
    // offset is normalized or used as a divisor by this solver.
    visited.add(name);
  }
}

function worldRotations(rotations: Record<Bone3D, Quat>): Record<Bone3D, Quaternion> {
  const world = {} as Record<Bone3D, Quaternion>;
  for (const name of HUMANOID_BONES) {
    const parent = HUMANOID_PARENTS[name];
    world[name] = parent ? world[parent].clone().multiply(q(rotations[name])) : q(rotations[name]);
  }
  return world;
}

export interface RetargetOptions3D {
  strength?: number;
  /** Lock horizontal travel while retaining vertical hips motion for squats and steps. */
  inPlace?: boolean;
  /** Anatomical transfers measured limb directions; reference maps a selected source pose to bind. */
  calibration?: 'reference' | 'anatomical';
}

function restTransforms(skeleton: Skeleton3D) {
  const positions = {} as Record<Bone3D, Vector3>;
  const rotations = {} as Record<Bone3D, Quaternion>;
  for (const name of HUMANOID_BONES) {
    const bone = skeleton.bones[name], parent = bone.parent;
    rotations[name] = parent ? rotations[parent].clone().multiply(q(bone.restRotation)) : q(bone.restRotation);
    positions[name] = parent ? v(bone.offset).applyQuaternion(rotations[parent]).add(positions[parent]) : v(bone.offset);
  }
  return { positions, rotations };
}

function bodyOrientation(side: Vector3, up: Vector3): Quaternion {
  const y = up.lengthSq() > 1e-12 ? up.clone().normalize() : new Vector3(0, 1, 0);
  const x = side.clone().addScaledVector(y, -side.dot(y));
  if (x.lengthSq() < 1e-12) return new Quaternion();
  x.normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, x.clone().cross(y))).normalize();
}

/** Same anatomical axes as the source solver, measured from target rest FK rather than target bone axis names. */
function anatomicalRest(skeleton: Skeleton3D, rest: ReturnType<typeof restTransforms>): Record<Bone3D, Quaternion> {
  const positions = rest.positions;
  const shoulders = positions.upperArmL.clone().add(positions.upperArmR).multiplyScalar(0.5);
  const up = shoulders.clone().sub(positions.hips);
  const hips = bodyOrientation(positions.thighL.clone().sub(positions.thighR), up);
  const chest = bodyOrientation(positions.upperArmL.clone().sub(positions.upperArmR), up);
  const result = {} as Record<Bone3D, Quaternion>;
  const child: Partial<Record<Bone3D, Bone3D>> = {
    upperArmL: 'forearmL', forearmL: 'handL', upperArmR: 'forearmR', forearmR: 'handR',
    thighL: 'shinL', shinL: 'footL', thighR: 'shinR', shinR: 'footR',
  };
  for (const name of HUMANOID_BONES) {
    if (name === 'hips' || name === 'spine') { result[name] = hips.clone(); continue; }
    if (name === 'chest' || name === 'neck') { result[name] = chest.clone(); continue; }
    const arm = name.includes('Arm') || name.includes('forearm') || name.includes('hand');
    const base = arm || name === 'head' ? chest : hips;
    const endChild = child[name];
    const endOffset = skeleton.bones[name].endOffset;
    const direction = endChild ? positions[endChild].clone().sub(positions[name])
      : endOffset ? v(endOffset).applyQuaternion(rest.rotations[name]) : undefined;
    const axis = name === 'head' ? new Vector3(0, 1, 0) : name.startsWith('foot') ? new Vector3(0, 0, 1)
      : arm ? new Vector3(name.endsWith('L') ? 1 : -1, 0, 0) : new Vector3(0, -1, 0);
    result[name] = direction && direction.lengthSq() > 1e-12
      ? base.clone().multiply(new Quaternion().setFromUnitVectors(axis, direction.normalize().applyQuaternion(base.clone().invert()))).normalize()
      : base.clone();
  }
  return result;
}

/**
 * Reference mode maps a selected source pose onto target bind; anatomical mode
 * transfers measured body directions and uses the reference torso for orientation
 * alignment only. Both account for arbitrary target rest axes before converting
 * back to target parent-local rotations. Offsets never change, so source
 * proportions cannot stretch a target limb.
 */
export function retargetFrame3D(
  frame: Motion3DFrame, reference: Motion3DFrame, skeleton: Skeleton3D,
  options: RetargetOptions3D = {},
): Pose3D {
  validateSkeleton3D(skeleton);
  const strength = Math.max(0, Math.min(2, Number.isFinite(options.strength) ? options.strength! : 1));
  const sourceWorld = worldRotations(frame.rotations);
  const referenceWorld = worldRotations(reference.rotations);
  const rest = restTransforms(skeleton);
  const anatomical = options.calibration === 'anatomical' ? anatomicalRest(skeleton, rest) : undefined;
  const alignment = anatomical ? anatomical.hips.clone().multiply(referenceWorld.hips.clone().invert()) : undefined;
  const targetRestWorld = {} as Record<Bone3D, Quaternion>;
  const targetWorld = {} as Record<Bone3D, Quaternion>;
  const rotations = {} as Pose3D['rotations'];
  const positions = {} as Pose3D['positions'];
  const confidence = {} as Pose3D['confidence'];
  const valid = frame.valid && reference.valid;
  const root = v(skeleton.bones.hips.offset);
  // Only image-derived translation is available. A single camera cannot recover
  // global performer depth or absolute camera-space position from world landmarks.
  if (valid && frame.rootTracked && reference.rootTracked && strength > 0) {
    const torsoLength = rest.positions.upperArmL.clone().add(rest.positions.upperArmR).multiplyScalar(0.5).distanceTo(rest.positions.hips);
    root.add(new Vector3(options.inPlace ? 0 : frame.root.x - reference.root.x, frame.root.y - reference.root.y, 0).multiplyScalar(torsoLength * strength));
  }
  for (const name of HUMANOID_BONES) {
    const bone = skeleton.bones[name];
    const parent = bone.parent;
    const restLocal = q(bone.restRotation);
    targetRestWorld[name] = parent ? targetRestWorld[parent].clone().multiply(restLocal) : restLocal.clone();
    confidence[name] = valid ? Math.max(0, Math.min(1, frame.confidence[name], anatomical ? reference.confidence.hips : reference.confidence[name], parent ? confidence[parent] : 1)) : 0;
    let local = restLocal.clone();
    if (valid && confidence[name] >= 0.35 && strength > 0) {
      const desired = anatomical && alignment
        ? alignment.clone().multiply(sourceWorld[name]).multiply(anatomical[name].clone().invert()).multiply(targetRestWorld[name]).normalize()
        : sourceWorld[name].clone().multiply(referenceWorld[name].clone().invert()).multiply(targetRestWorld[name]).normalize();
      const delta = desired.multiply(targetRestWorld[name].clone().invert()).normalize();
      // q and -q represent the same orientation. Always interpolate the shorter arc.
      if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      const scaled = new Quaternion().slerp(delta, strength).normalize();
      const desiredWorld = scaled.multiply(targetRestWorld[name]);
      local = parent ? targetWorld[parent].clone().invert().multiply(desiredWorld).normalize() : desiredWorld;
    }
    targetWorld[name] = parent ? targetWorld[parent].clone().multiply(local).normalize() : local.clone();
    rotations[name] = plainQ(local);
    positions[name] = parent
      ? plainV(v(bone.offset).applyQuaternion(targetWorld[parent]).add(v(positions[parent])))
      : plainV(root);
  }
  return {
    timestampMs: frame.timestampMs, rotations, positions, root: plainV(root), confidence, valid,
    needsReview: !valid || frame.needsReview || (anatomical ? reference.held.hips : reference.needsReview) || HUMANOID_BONES.some(name => confidence[name] < 0.35),
  };
}
