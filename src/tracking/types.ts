import type { CanonicalFrame } from '../motion/canonical.ts';

export type SmoothingPreset = 'raw' | 'light' | 'balanced' | 'smooth';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export interface LandmarkSet {
  pose: Landmark[];
  poseWorld: Landmark[];
  face: Landmark[];
  leftHand: Landmark[];
  rightHand: Landmark[];
  blendshapes: Record<string, number>;
}

export interface MotionFrame {
  timestampMs: number;
  raw: LandmarkSet;
  cleaned: LandmarkSet;
  confidence: number;
  inferenceMs: number;
  canonical?: CanonicalFrame;
}

export type MotionWorkerRequest =
  | { type: 'initialize'; id: number; smoothing: SmoothingPreset }
  | { type: 'frame'; id: number; bitmap: ImageBitmap; timestampMs: number };

export type MotionWorkerResponse =
  | { type: 'ready'; id: number }
  | { type: 'frame'; id: number; frame: MotionFrame }
  | { type: 'error'; id: number; message: string };
