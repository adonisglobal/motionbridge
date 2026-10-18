import type { Landmark, MotionFrame } from '../tracking/types.ts';
import {
  BONE_JOINTS, BONE_NAMES, BONE_PARENTS, JOINT_NAMES, boneAngle, distance, wrapAngle,
} from './canonical.ts';
import type { CanonicalBone, CanonicalFrame, CanonicalJoint, JointName, Vec2 } from './canonical.ts';
import { FootContactDetector } from './contacts.ts';

const MIN_CONFIDENCE = 0.35;
const SHORT_HOLD_MS = 150;
const EPSILON = 1e-5;

// This adapter is the only place that knows the detector's pose landmark indices.
const POSE_JOINTS: Partial<Record<JointName, number>> = {
  shoulderL: 11, elbowL: 13, wristL: 15, handL: 19,
  shoulderR: 12, elbowR: 14, wristR: 16, handR: 20,
  hipL: 23, kneeL: 25, ankleL: 27, toeL: 31,
  hipR: 24, kneeR: 26, ankleR: 28, toeR: 32,
};

interface Observation extends CanonicalJoint { timestampMs: number }

function confidence(point: Landmark): number {
  const value = Math.min(point.visibility ?? 1, point.presence ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function midpoint(a: CanonicalJoint | undefined, b: CanonicalJoint | undefined): CanonicalJoint | undefined {
  if (!a || !b) return undefined;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, confidence: Math.min(a.confidence, b.confidence) };
}

function lerpPoint(a: CanonicalJoint, b: CanonicalJoint, amount: number): CanonicalJoint {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount, confidence: Math.min(a.confidence, b.confidence) };
}

export class MotionSolver {
  private readonly aspect: number;
  private referenceScale: number | undefined;
  private readonly observed = new Map<JointName, Observation>();
  private readonly contacts = new FootContactDetector();
  private lastTimestampMs = -Infinity;

  constructor({ width, height }: { width: number; height: number }) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Motion dimensions must be finite positive numbers.');
    }
    this.aspect = width / height;
  }

  reset(): void {
    this.referenceScale = undefined;
    this.observed.clear();
    this.contacts.reset();
    this.lastTimestampMs = -Infinity;
  }

  process(frame: MotionFrame): CanonicalFrame {
    if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs <= this.lastTimestampMs) {
      throw new Error('Canonical motion timestamps must be finite, non-negative, and strictly increasing.');
    }
    this.lastTimestampMs = frame.timestampMs;
    const measurements: Partial<Record<JointName, CanonicalJoint>> = {};
    const measure = (point: Landmark | undefined): CanonicalJoint | undefined => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
      const score = confidence(point);
      return score >= MIN_CONFIDENCE ? { x: point.x * this.aspect, y: point.y, confidence: score } : undefined;
    };
    for (const [name, index] of Object.entries(POSE_JOINTS)) {
      measurements[name as JointName] = measure(frame.cleaned.pose[index!]);
    }
    // Middle-finger MCP is less sensitive to finger articulation than a fingertip.
    measurements.handL = measure(frame.cleaned.leftHand[9]) ?? measurements.handL;
    measurements.handR = measure(frame.cleaned.rightHand[9]) ?? measurements.handR;
    measurements.pelvis = midpoint(measurements.hipL, measurements.hipR);
    measurements.chest = midpoint(measurements.shoulderL, measurements.shoulderR);
    measurements.head = midpoint(measure(frame.cleaned.pose[7]), measure(frame.cleaned.pose[8]))
      ?? measure(frame.cleaned.pose[0]);
    if (measurements.pelvis && measurements.chest) {
      measurements.spine = lerpPoint(measurements.pelvis, measurements.chest, 0.5);
      // The torso axis must not change simply because the face turns or disappears.
      measurements.neck = lerpPoint(measurements.pelvis, measurements.chest, 1.12);
    }

    const pelvis = measurements.pelvis;
    const chest = measurements.chest;
    const measuredScale = pelvis && chest ? distance(pelvis, chest) : 0;
    const measuredTorsoValid = Boolean(pelvis && chest && measuredScale > EPSILON);
    if (measuredTorsoValid && this.referenceScale === undefined) this.referenceScale = measuredScale;
    // scale=1 is a finite sentinel until calibration; valid=false prevents animation.
    const scale = this.referenceScale ?? 1;
    for (const name of JOINT_NAMES) {
      const point = measurements[name];
      if (point && point.confidence >= MIN_CONFIDENCE) {
        this.observed.set(name, { ...point, timestampMs: frame.timestampMs });
      }
    }
    const resolved = {} as Record<JointName, CanonicalJoint>;
    let needsReview = !measuredTorsoValid;
    for (const name of JOINT_NAMES) {
      const measured = measurements[name];
      const previous = this.observed.get(name);
      const tracked = measured && measured.confidence >= MIN_CONFIDENCE;
      if (!tracked) needsReview = true;
      resolved[name] = tracked ? measured
        : previous && frame.timestampMs - previous.timestampMs <= SHORT_HOLD_MS
          ? { x: previous.x, y: previous.y, confidence: previous.confidence * 0.75, held: true }
          : { x: 0, y: 0, confidence: 0 };
    }
    const valid = this.referenceScale !== undefined
      && resolved.pelvis.confidence > 0 && resolved.chest.confidence > 0
      && distance(resolved.pelvis, resolved.chest) > EPSILON;
    const root: Vec2 = { x: resolved.pelvis.x, y: resolved.pelvis.y };
    const joints = {} as CanonicalFrame['joints'];
    for (const name of JOINT_NAMES) {
      const point = resolved[name];
      joints[name] = point.confidence > 0
        ? { ...point, x: (point.x - root.x) / scale, y: (point.y - root.y) / scale }
        : { x: 0, y: 0, confidence: 0 };
    }
    const bones = {} as CanonicalFrame['bones'];
    for (const name of BONE_NAMES) {
      const [startName, endName] = BONE_JOINTS[name];
      const start = joints[startName];
      const end = joints[endName];
      const parent = BONE_PARENTS[name];
      const boneConfidence = distance(start, end) > EPSILON
        ? Math.min(start.confidence, end.confidence, parent ? bones[parent].confidence : 1) : 0;
      const angle = boneConfidence > 0 ? boneAngle(start, end) : 0;
      const parentAngle = parent ? bones[parent].angle : 0;
      const bone: CanonicalBone = { angle, localAngle: wrapAngle(angle - parentAngle), confidence: boneConfidence };
      bones[name] = bone;
      if (boneConfidence < MIN_CONFIDENCE) needsReview = true;
    }
    const canonical: CanonicalFrame = {
      timestampMs: frame.timestampMs, root: { x: root.x, y: root.y }, scale, joints, bones,
      valid, needsReview, contacts: { left: false, right: false },
    };
    canonical.contacts = this.contacts.process(canonical);
    return canonical;
  }
}
