import type { Landmark, MotionFrame } from '../tracking/types.ts';

type Connection = readonly [number, number];

const BODY_LINKS: readonly Connection[] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [29, 31], [27, 31],
  [28, 30], [30, 32], [28, 32],
];

const HAND_LINKS: readonly Connection[] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

function chain(indices: number[], closed = false): Connection[] {
  const links: Connection[] = indices.slice(1).map((index, position) => [indices[position], index]);
  if (closed && indices.length > 1) links.push([indices[indices.length - 1], indices[0]]);
  return links;
}

// Sparse contours keep the expression readable without drawing a dense face mesh.
const FACE_LINKS: readonly Connection[] = [
  ...chain([10, 338, 454, 397, 152, 172, 234, 109], true),
  ...chain([33, 160, 158, 133, 153, 144], true),
  ...chain([362, 385, 387, 263, 373, 380], true),
  ...chain([61, 40, 0, 270, 291, 321, 17, 91], true),
  ...chain([70, 63, 105, 66, 107]),
  ...chain([336, 296, 334, 293, 300]),
  ...chain([168, 6, 1, 2]),
];

const CONFIDENCE_THRESHOLD = 0.45;
const BODY_COLOR = '#b6f5c8';
const DETAIL_COLOR = '#b9a0ff';
const FACE_COLOR = '#e6c28d';

function visible(point: Landmark | undefined): point is Landmark {
  return Boolean(
    point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    (point.visibility ?? 1) >= CONFIDENCE_THRESHOLD &&
    (point.presence ?? 1) >= CONFIDENCE_THRESHOLD,
  );
}

export interface SkeletonOptions {
  width: number;
  height: number;
  raw: boolean;
  showFace: boolean;
  showHands: boolean;
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  frame: MotionFrame | undefined,
  { width, height, raw, showFace, showHands }: SkeletonOptions,
): void {
  ctx.clearRect(0, 0, width, height);
  if (!frame || width <= 0 || height <= 0) return;
  const landmarks = raw ? frame.raw : frame.cleaned;
  const lineWidth = Math.max(1.5, Math.min(width, height) / 220);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#081a23';
  ctx.shadowBlur = 3;

  const drawLinks = (points: Landmark[], links: readonly Connection[], color: string, thickness = 1) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * thickness;
    ctx.beginPath();
    for (const [a, b] of links) {
      const start = points[a];
      const end = points[b];
      if (!visible(start) || !visible(end)) continue;
      ctx.moveTo(start.x * width, start.y * height);
      ctx.lineTo(end.x * width, end.y * height);
    }
    ctx.stroke();
  };

  const drawJoints = (points: Landmark[], indices: Iterable<number>, color: string, radius: number) => {
    ctx.fillStyle = color;
    for (const index of indices) {
      const point = points[index];
      if (!visible(point)) continue;
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  drawLinks(landmarks.pose, BODY_LINKS, BODY_COLOR);
  drawJoints(landmarks.pose, new Set(BODY_LINKS.flat()), BODY_COLOR, lineWidth * 1.25);

  // A neck/head guide remains available when face tracking is disabled or lost.
  const leftShoulder = landmarks.pose[11];
  const rightShoulder = landmarks.pose[12];
  const nose = landmarks.pose[0];
  if (visible(leftShoulder) && visible(rightShoulder) && visible(nose)) {
    ctx.strokeStyle = BODY_COLOR;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo((leftShoulder.x + rightShoulder.x) * width / 2, (leftShoulder.y + rightShoulder.y) * height / 2);
    ctx.lineTo(nose.x * width, nose.y * height);
    ctx.stroke();
    drawJoints(landmarks.pose, [0], BODY_COLOR, lineWidth * 1.5);
  }

  if (showHands) {
    for (const hand of [landmarks.leftHand, landmarks.rightHand]) {
      drawLinks(hand, HAND_LINKS, DETAIL_COLOR, 0.65);
      drawJoints(hand, hand.keys(), DETAIL_COLOR, lineWidth * 0.7);
    }
  }
  if (showFace) drawLinks(landmarks.face, FACE_LINKS, FACE_COLOR, 0.55);
  ctx.restore();
}
