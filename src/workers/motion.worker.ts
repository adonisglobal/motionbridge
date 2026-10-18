import { FilesetResolver, HolisticLandmarker } from '@mediapipe/tasks-vision';
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision';
import { bodyConfidence, LandmarkSmoother } from '../motion/filters.ts';
import { MotionSolver } from '../motion/solver.ts';
import type { Landmark, LandmarkSet, MotionFrame, MotionWorkerRequest, MotionWorkerResponse } from '../tracking/types.ts';

// A small structural worker type avoids mixing DOM and WebWorker library globals.
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MotionWorkerRequest>) => void) | null;
  postMessage: (message: MotionWorkerResponse) => void;
};

let landmarker: HolisticLandmarker | null = null;
let smoother = new LandmarkSmoother('balanced');
let lastTimestampMs = -Infinity;
let initializing = false;
let solver: MotionSolver | null = null;

function copyPoints(points: Landmark[] | undefined): Landmark[] {
  return (points ?? []).map(point => ({ ...point }));
}

function snapshot(result: HolisticLandmarkerResult): LandmarkSet {
  const blendshapes: Record<string, number> = {};
  for (const category of result.faceBlendshapes[0]?.categories ?? []) {
    blendshapes[category.categoryName] = category.score;
  }
  return {
    pose: copyPoints(result.poseLandmarks[0]),
    poseWorld: copyPoints(result.poseWorldLandmarks[0]),
    face: copyPoints(result.faceLandmarks[0]),
    leftHand: copyPoints(result.leftHandLandmarks[0]),
    rightHand: copyPoints(result.rightHandLandmarks[0]),
    blendshapes,
  };
}

async function initialize(message: Extract<MotionWorkerRequest, { type: 'initialize' }>): Promise<void> {
  if (initializing) throw new Error('The motion model is already initializing.');
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('This browser does not support OffscreenCanvas inside a worker.');
  }
  initializing = true;
  try {
    landmarker?.close();
    landmarker = null;
    // Absolute runtime URLs keep Vite's dev import analysis from adding ?import
    // to public assets. BASE_URL also keeps the paths correct on a static subpath.
    const assetRoot = new URL(import.meta.env.BASE_URL, self.location.origin);
    const wasmRoot = new URL('mediapipe/wasm', assetRoot).href;
    const modelUrl = new URL('models/holistic_landmarker.task', assetRoot).href;
    // tasks-vision 1.1.x ships an ES module WASM loader for module workers.
    const fileset = await FilesetResolver.forVisionTasks(wasmRoot, true);
    landmarker = await HolisticLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
        delegate: 'CPU',
      },
      canvas: new OffscreenCanvas(1, 1),
      runningMode: 'VIDEO',
      outputFaceBlendshapes: true,
      outputPoseSegmentationMasks: false,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minHandLandmarksConfidence: 0.5,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
    });
    smoother = new LandmarkSmoother(message.smoothing);
    solver = null;
    lastTimestampMs = -Infinity;
    workerScope.postMessage({ type: 'ready', id: message.id });
  } finally {
    initializing = false;
  }
}

function processFrame(message: Extract<MotionWorkerRequest, { type: 'frame' }>): void {
  try {
    if (!landmarker || initializing) throw new Error('The motion model is not ready.');
    if (!Number.isFinite(message.timestampMs) || message.timestampMs < 0 || message.timestampMs <= lastTimestampMs) {
      throw new Error('Frame timestamps must be strictly increasing.');
    }
    lastTimestampMs = message.timestampMs;
    const startedAt = performance.now();
    const result = landmarker.detectForVideo(message.bitmap, message.timestampMs);
    const inferenceMs = performance.now() - startedAt;
    try {
      const raw = snapshot(result);
      const frame: MotionFrame = {
        timestampMs: message.timestampMs,
        raw,
        cleaned: smoother.process(raw, message.timestampMs),
        confidence: bodyConfidence(raw.pose),
        inferenceMs,
      };
      solver ??= new MotionSolver({ width: message.bitmap.width, height: message.bitmap.height });
      frame.canonical = solver.process(frame);
      workerScope.postMessage({ type: 'frame', id: message.id, frame });
    } finally {
      for (const mask of result.poseSegmentationMasks ?? []) mask.close();
    }
  } finally {
    message.bitmap.close();
  }
}

workerScope.onmessage = (event) => {
  const message = event.data;
  const operation = message.type === 'initialize'
    ? initialize(message)
    : Promise.resolve().then(() => processFrame(message));
  operation.catch((error: unknown) => {
    workerScope.postMessage({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
