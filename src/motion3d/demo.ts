import { Vector3 } from 'three';
import type { Landmark, MotionFrame } from '../tracking/types.ts';
import { MotionSolver3D } from './solver.ts';
import type { Motion3DFrame } from './types.ts';

export interface DemoMotion3D {
  source: 'synthetic';
  trackingFrames: MotionFrame[];
  motionFrames: Motion3DFrame[];
  durationSeconds: number;
  analysisFps: number;
  width: number;
  height: number;
}

/**
 * Original procedural example, not a recording or an inference result. Produces
 * complete body landmarks and passes them through the actual 3D solver so the
 * example exercises the same calibration, depth, FK, and export path as a video.
 * First and last poses are standing T-poses for unambiguous bind calibration.
 */
export function createDemo3D(fps = 24): DemoMotion3D {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('Demo FPS must be an integer between 1 and 120.');
  const durationSeconds = 6;
  const width = 960, height = 720, aspect = width / height;
  const count = durationSeconds * fps;
  const trackingFrames: MotionFrame[] = [];
  const motionFrames: Motion3DFrame[] = [];
  const solver = new MotionSolver3D({ aspectRatio: aspect });
  const axisX = new Vector3(1, 0, 0), axisY = new Vector3(0, 1, 0), axisZ = new Vector3(0, 0, 1);
  for (let index = 0; index < count; index++) {
    const phase = count > 1 ? index / (count - 1) : 0;
    const envelope = Math.sin(Math.PI * phase) ** 2;
    const squat = Math.sin(2 * Math.PI * phase) ** 2 * envelope;
    const hipHeight = 0.98 - 0.30 * squat;
    const weave = 0.12 * Math.sin(2 * Math.PI * phase) * envelope;
    const root = new Vector3(weave, hipHeight, 0);
    const lean = 0.20 * squat;
    const yaw = 0.23 * Math.sin(2 * Math.PI * phase) * envelope;
    const points = new Map<number, Vector3>();
    const body = (point: Vector3) => point.applyAxisAngle(axisX, lean);
    points.set(0, body(new Vector3(0, 0.72, 0.09)));
    points.set(7, body(new Vector3(0.08, 0.72, 0)));
    points.set(8, body(new Vector3(-0.08, 0.72, 0)));
    for (const side of [1, -1]) {
      const left = side === 1;
      const shoulderIndex = left ? 11 : 12, elbowIndex = left ? 13 : 14, wristIndex = left ? 15 : 16;
      const raise = (left ? 0.95 : 0.65) * envelope;
      const depth = (left ? -0.80 : 0.60) * Math.sin(2 * Math.PI * phase) * envelope;
      const upper = new Vector3(side * 0.30, 0, 0).applyAxisAngle(axisZ, side * raise).applyAxisAngle(axisY, -side * depth);
      const lower = new Vector3(side * 0.27, 0, 0).applyAxisAngle(axisZ, side * (raise + 0.28 * envelope)).applyAxisAngle(axisY, -side * (depth + 0.75 * envelope));
      const shoulder = new Vector3(side * 0.22, 0.41, 0);
      const elbow = shoulder.clone().add(upper);
      const wrist = elbow.clone().add(lower);
      const hand = wrist.clone().add(lower.clone().normalize().multiplyScalar(0.11));
      points.set(shoulderIndex, body(shoulder)); points.set(elbowIndex, body(elbow)); points.set(wristIndex, body(wrist));
      points.set(left ? 17 : 18, body(hand.clone().add(new Vector3(0, -0.01, 0))));
      points.set(left ? 19 : 20, body(hand.clone().add(new Vector3(0, 0.01, 0))));
      points.set(left ? 21 : 22, body(hand.clone().add(new Vector3(0, 0, 0.015))));
      const ankleY = 0.11;
      const distance = hipHeight - ankleY;
      const thighLength = 0.44, shinLength = 0.43;
      const kneeDrop = (thighLength ** 2 - shinLength ** 2 + distance ** 2) / (2 * distance);
      const kneeForward = Math.sqrt(Math.max(0, thighLength ** 2 - kneeDrop ** 2));
      points.set(left ? 23 : 24, new Vector3(side * 0.105, 0, 0));
      points.set(left ? 25 : 26, new Vector3(side * 0.105, -kneeDrop, kneeForward));
      points.set(left ? 27 : 28, new Vector3(side * 0.105, ankleY - hipHeight, 0));
      points.set(left ? 29 : 30, new Vector3(side * 0.105, ankleY - hipHeight - 0.015, -0.045));
      points.set(left ? 31 : 32, new Vector3(side * 0.105, ankleY - hipHeight - 0.04, 0.17));
    }
    // Fill eye points for the source overlay as well as all required body joints.
    for (const [pointIndex, x] of [[1, 0.035], [2, 0.05], [3, 0.065], [4, -0.035], [5, -0.05], [6, -0.065], [9, 0.025], [10, -0.025]]) {
      points.set(pointIndex, body(new Vector3(x, pointIndex >= 9 ? 0.685 : 0.745, 0.075)));
    }
    const poseWorld: Landmark[] = [], pose: Landmark[] = [];
    for (let pointIndex = 0; pointIndex < 33; pointIndex++) {
      const relative = (points.get(pointIndex) ?? new Vector3()).clone().applyAxisAngle(axisY, yaw);
      const absolute = relative.clone().add(root);
      poseWorld.push({ x: relative.x, y: -relative.y, z: -relative.z, visibility: 1, presence: 1 });
      pose.push({ x: 0.5 + absolute.x * 0.42 / aspect, y: 0.85 - absolute.y * 0.42, z: -relative.z, visibility: 1, presence: 1 });
    }
    const cleaned = { pose, poseWorld, face: [], leftHand: [], rightHand: [], blendshapes: {} };
    const tracking: MotionFrame = { timestampMs: index * 1000 / fps, cleaned, raw: structuredClone(cleaned), confidence: 1, inferenceMs: 0 };
    trackingFrames.push(tracking);
    motionFrames.push(solver.solve(tracking));
  }
  return { source: 'synthetic', trackingFrames, motionFrames, durationSeconds, analysisFps: fps, width, height };
}
