import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Landmark, MotionFrame } from '../tracking/types.ts';
import { HUMANOID_BONES, HUMANOID_PARENTS } from './types.ts';
import type { Bone3D, Joint3D, Motion3DFrame, Quat } from './types.ts';

const THRESHOLD = 0.35;
const HOLD_MS = 150;
const EPSILON = 1e-7;
interface Sample { point: Vector3; confidence: number; held: boolean }
interface Observation { sample: Sample; timestampMs: number }
const empty = (): Sample => ({ point: new Vector3(), confidence: 0, held: false });
const combine = (a: Sample, b: Sample, t = 0.5): Sample => ({
  point: a.point.clone().lerp(b.point, t), confidence: Math.min(a.confidence, b.confidence), held: a.held || b.held,
});
const plain = (q: Quaternion): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const confidenceOf = (point?: Landmark): number => point && [point.x, point.y, point.z].every(Number.isFinite)
  ? Math.max(0, Math.min(1, point.visibility ?? 1, point.presence ?? 1)) : 0;

function orientation(rightToLeft: Vector3, up: Vector3): Quaternion | undefined {
  if (rightToLeft.lengthSq() < EPSILON || up.lengthSq() < EPSILON) return;
  const y = up.clone().normalize();
  const x = rightToLeft.clone().addScaledVector(y, -rightToLeft.dot(y));
  if (x.lengthSq() < EPSILON) return;
  x.normalize();
  const z = x.clone().cross(y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

/**
 * Body-only 3D solve from MediaPipe poseWorld, independently of the 2D solver.
 * The conversion (x, -y, -z) is a proper rotation, not a reflection. World
 * coordinates are pelvis-relative estimates; image landmarks provide XY root
 * travel only. Axial limb twist and global depth are not observable from these
 * body landmarks and are not manufactured by this solver.
 */
export class MotionSolver3D {
  private readonly aspect: number;
  private readonly worldHistory = new Map<number, Observation>();
  private readonly imageHistory = new Map<number, Observation>();
  private readonly worldRotationHistory = new Map<Bone3D, Quaternion>();
  private readonly localRotationHistory = new Map<Bone3D, Quaternion>();
  private lastTimestamp = -Infinity;
  private scale = 0;
  private imageScale = 0;

  constructor(options: { aspectRatio?: number } = {}) {
    this.aspect = options.aspectRatio ?? 1;
    if (!Number.isFinite(this.aspect) || this.aspect <= 0) throw new Error('The source aspect ratio must be positive.');
  }

  private sample(points: Landmark[], index: number, timestampMs: number, image = false): Sample {
    const history = image ? this.imageHistory : this.worldHistory;
    const input = points[index];
    const confidence = confidenceOf(input);
    if (confidence >= THRESHOLD) {
      const sample = {
        point: image ? new Vector3(input.x * this.aspect, -input.y, 0) : new Vector3(input.x, -input.y, -input.z),
        confidence, held: false,
      };
      history.set(index, { sample, timestampMs });
      return sample;
    }
    const previous = history.get(index);
    if (previous && timestampMs - previous.timestampMs <= HOLD_MS) {
      return { point: previous.sample.point.clone(), confidence: previous.sample.confidence * 0.75, held: true };
    }
    return empty();
  }

  solve(frame: MotionFrame): Motion3DFrame {
    const timestamp = frame.timestampMs;
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp <= this.lastTimestamp) {
      throw new Error('3D frame timestamps must be finite, nonnegative, and strictly increasing.');
    }
    this.lastTimestamp = timestamp;
    const points = Array.from({ length: 33 }, (_, index) => this.sample(frame.cleaned.poseWorld, index, timestamp));
    const hips = combine(points[23], points[24]);
    const shoulders = combine(points[11], points[12]);
    const up = shoulders.point.clone().sub(hips.point);
    const torsoConfidence = Math.min(hips.confidence, shoulders.confidence);
    if (!this.scale && torsoConfidence >= THRESHOLD && up.length() > 1e-4) this.scale = up.length();
    const unit = this.scale || 1;
    const spine = combine(hips, shoulders, 0.34);
    const chest = combine(hips, shoulders, 0.86);
    const neck = combine(hips, shoulders, 1.12);
    const ears = combine(points[7], points[8]);
    const positionsObserved: Record<Bone3D, Sample> = {
      hips, spine, chest, neck, head: ears,
      upperArmL: points[11], forearmL: points[13], handL: points[15],
      upperArmR: points[12], forearmR: points[14], handR: points[16],
      thighL: points[23], shinL: points[25], footL: points[27],
      thighR: points[24], shinR: points[26], footR: points[28],
    };
    const endpoints: Partial<Record<Bone3D, Sample>> = {
      upperArmL: points[13], forearmL: points[15], handL: combine(points[17], points[19]),
      upperArmR: points[14], forearmR: points[16], handR: combine(points[18], points[20]),
      thighL: points[25], shinL: points[27], footL: points[31],
      thighR: points[26], shinR: points[28], footR: points[32],
    };
    const hipsQ = orientation(points[23].point.clone().sub(points[24].point), up);
    const chestQ = orientation(points[11].point.clone().sub(points[12].point), up);
    const headQ = orientation(points[7].point.clone().sub(points[8].point), ears.point.clone().sub(neck.point));
    const world = {} as Record<Bone3D, Quaternion>;
    const rotations = {} as Motion3DFrame['rotations'];
    const confidence = {} as Motion3DFrame['confidence'];
    const held = {} as Motion3DFrame['held'];
    const positions = {} as Motion3DFrame['positions'];
    for (const name of HUMANOID_BONES) {
      const parent = HUMANOID_PARENTS[name];
      const start = positionsObserved[name];
      const end = endpoints[name];
      let boneConfidence = Math.min(start.confidence, torsoConfidence, parent ? confidence[parent] : 1);
      let boneHeld = start.held || hips.held || shoulders.held || !!(parent && held[parent]);
      let candidate: Quaternion | undefined;
      if (name === 'hips') candidate = hipsQ;
      else if (name === 'spine') candidate = hipsQ;
      else if (name === 'chest' || name === 'neck') candidate = chestQ;
      else if (name === 'head') { candidate = headQ; boneConfidence = Math.min(boneConfidence, ears.confidence); boneHeld ||= ears.held; }
      else if (end) {
        boneConfidence = Math.min(boneConfidence, end.confidence);
        boneHeld ||= end.held;
        const direction = end.point.clone().sub(start.point);
        if (direction.lengthSq() > EPSILON) {
          // Swing about the torso frame only: landmarks do not measure roll
          // around a limb's long axis. This avoids unstable synthetic twists.
          const base = (name.includes('Arm') || name.includes('forearm') || name.includes('hand')) ? chestQ : hipsQ;
          if (base) {
            const restDirection = name.startsWith('foot') ? new Vector3(0, 0, 1)
              : (name.includes('Arm') || name.includes('forearm') || name.includes('hand'))
                ? new Vector3(name.endsWith('L') ? 1 : -1, 0, 0) : new Vector3(0, -1, 0);
            const localDirection = direction.normalize().applyQuaternion(base.clone().invert());
            candidate = base.clone().multiply(new Quaternion().setFromUnitVectors(restDirection, localDirection)).normalize();
          }
        }
      }
      if (!candidate || !this.scale) boneConfidence = 0;
      const oldWorld = this.worldRotationHistory.get(name);
      if (boneHeld && oldWorld && boneConfidence >= THRESHOLD) candidate = oldWorld.clone();
      if (!candidate || boneConfidence < THRESHOLD) candidate = parent ? world[parent].clone() : new Quaternion();
      world[name] = candidate;
      if (!boneHeld && boneConfidence >= THRESHOLD) this.worldRotationHistory.set(name, candidate.clone());
      const local = parent ? world[parent].clone().invert().multiply(candidate).normalize() : candidate.clone();
      const oldLocal = this.localRotationHistory.get(name);
      if (oldLocal && oldLocal.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      this.localRotationHistory.set(name, local.clone());
      rotations[name] = plain(local);
      confidence[name] = boneConfidence;
      held[name] = boneHeld && boneConfidence >= THRESHOLD;
      const point = start.confidence >= THRESHOLD ? start.point.clone().sub(hips.point).divideScalar(unit) : new Vector3();
      positions[name] = { x: point.x, y: point.y, z: point.z, confidence: start.confidence, ...(start.held ? { held: true } : {}) } satisfies Joint3D;
    }
    const imagePoints = [11, 12, 23, 24].map(index => this.sample(frame.cleaned.pose, index, timestamp, true));
    const imageHips = combine(imagePoints[2], imagePoints[3]);
    const imageShoulders = combine(imagePoints[0], imagePoints[1]);
    const imageTorso = imageHips.point.distanceTo(imageShoulders.point);
    if (!this.imageScale && Math.min(imageHips.confidence, imageShoulders.confidence) >= THRESHOLD && imageTorso > 1e-4) this.imageScale = imageTorso;
    const rootTracked = !!this.imageScale && imageHips.confidence >= THRESHOLD;
    const root = rootTracked ? imageHips.point.clone().divideScalar(this.imageScale) : new Vector3();
    const valid = !!this.scale && confidence.hips >= THRESHOLD && confidence.chest >= THRESHOLD;
    return {
      timestampMs: timestamp, rotations, positions, confidence, held,
      root: { x: root.x, y: root.y, z: 0 }, rootTracked, scale: unit, valid,
      needsReview: !valid || !rootTracked || imageHips.held || HUMANOID_BONES.some(name => held[name] || confidence[name] < THRESHOLD),
    };
  }

  /** Alias for callers that share the existing 2D solver's process convention. */
  process(frame: MotionFrame): Motion3DFrame { return this.solve(frame); }
}

/** Prefer the first fully observed pose; otherwise return the best valid pose with its review flags intact. */
export function chooseReference3D(frames: readonly Motion3DFrame[]): Motion3DFrame | undefined {
  const valid = frames.filter(frame => frame.valid);
  const complete = valid.find(frame => !frame.needsReview && HUMANOID_BONES.every(name => frame.confidence[name] >= THRESHOLD && !frame.held[name]));
  if (complete) return complete;
  return valid.reduce<Motion3DFrame | undefined>((best, frame) => {
    const score = (value: Motion3DFrame) => HUMANOID_BONES.reduce((sum, name) => sum + value.confidence[name] * (value.held[name] ? 0.5 : 1), 0);
    return !best || score(frame) > score(best) ? frame : best;
  }, undefined);
}
