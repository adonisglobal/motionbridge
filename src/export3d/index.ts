import { createDefaultSkeleton3D, retargetFrame3D } from '../motion3d/retarget.ts';
import type { Motion3DFrame, Skeleton3D } from '../motion3d/types.ts';
import { exportPosesBVH } from './bvh.ts';
import type { BVHExportResult } from './bvh.ts';

export interface MotionExportOptions {
  frames: readonly Motion3DFrame[];
  reference: Motion3DFrame;
  fps: number;
  strength: number;
  inPlace: boolean;
  calibration?: 'reference' | 'anatomical';
  skeleton?: Skeleton3D;
  allowUncertain?: boolean;
  maxGapMs?: number;
  source?: Record<string, unknown>;
}

export function exportMotionBVH(options: MotionExportOptions): BVHExportResult {
  const skeleton = options.skeleton ?? createDefaultSkeleton3D();
  const poses = options.frames.map(frame => retargetFrame3D(frame, options.reference, skeleton, options));
  return exportPosesBVH({ skeleton, poses, fps: options.fps, allowUncertain: options.allowUncertain, maxGapMs: options.maxGapMs });
}

/**
 * The review archive retains original sample timing, flags, confidence and measured
 * source transforms. Unlike BVH it can represent failed tracking without pretending
 * a missing observation is animation. It is intentionally not a Blender scene file.
 */
export function buildMotion3DJSON(options: MotionExportOptions) {
  const skeleton = options.skeleton ?? createDefaultSkeleton3D();
  const poses = options.frames.map(frame => retargetFrame3D(frame, options.reference, skeleton, options));
  return {
    format: 'motion3d-canonical',
    schemaVersion: 1,
    source: options.source ?? {},
    coordinates: {
      handedness: 'right', up: '+Y', imageRight: '+X', towardCamera: '+Z',
      sourcePositionUnits: 'initial source torso length',
      targetPositionUnits: options.skeleton ? 'target skeleton units' : 'meters',
      quaternionOrder: ['x', 'y', 'z', 'w'],
      rotations: 'parent-local, including target rest rotation for poses',
      globalDepth: 'unobserved; no global Z trajectory is estimated',
      rootMotion: 'image-derived XY translation, calibrated at the reference sample',
      timing: 'original source timestamps in milliseconds; frames are not resampled',
    },
    settings: { strength: options.strength, inPlace: options.inPlace, calibration: options.calibration ?? 'reference', preferredBVHFrameRate: options.fps },
    referenceTimestampMs: options.reference.timestampMs,
    reference: options.reference,
    skeleton,
    frames: options.frames,
    poses,
  };
}

export { exportPosesBVH, resamplePoses } from './bvh.ts';
export type { BVHExportResult, PoseExportOptions, ResampledMotion } from './bvh.ts';
