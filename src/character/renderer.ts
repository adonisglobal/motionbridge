import { BONE_JOINTS, BONE_NAMES, JOINT_NAMES } from '../motion/canonical.ts';
import type { JointName, Vec2 } from '../motion/canonical.ts';
import type { RetargetedPose } from '../motion/retarget.ts';
import type { CharacterPart, CharacterRig } from './rig.ts';

export interface PartTransform {
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

/** Maps a sprite's actual pivot and tip to the two joints of its FK bone. */
export function getPartTransform(rig: CharacterRig, part: CharacterPart, pose?: RetargetedPose): PartTransform {
  const [startName, endName] = BONE_JOINTS[part.bone];
  const start = pose?.joints[startName] ?? rig.joints[startName];
  const end = pose?.joints[endName] ?? rig.joints[endName];
  const targetAngle = pose?.rotations[part.bone] ?? Math.atan2(end.y - start.y, end.x - start.x);
  const anchorLength = Math.max(1, Math.hypot(part.tip.x - part.pivot.x, part.tip.y - part.pivot.y));
  return {
    x: start.x, y: start.y,
    rotation: targetAngle - part.restAngle,
    scale: Math.hypot(end.x - start.x, end.y - start.y) / anchorLength,
  };
}

export function transformPartPoint(point: Vec2, part: CharacterPart, transform: PartTransform): Vec2 {
  const dx = (point.x - part.pivot.x) * transform.scale;
  const dy = (point.y - part.pivot.y) * transform.scale;
  return {
    x: transform.x + dx * Math.cos(transform.rotation) - dy * Math.sin(transform.rotation),
    y: transform.y + dx * Math.sin(transform.rotation) + dy * Math.cos(transform.rotation),
  };
}

export function characterViewport(rig: CharacterRig, width: number, height: number) {
  // Leave room around the rest rig for translated hips and raised limbs.
  const scale = Math.min((width - 64) / rig.width, (height - 64) / rig.height) * .82;
  return { scale, x: (width - rig.width * scale) / 2, y: (height - rig.height * scale) / 2 };
}

export interface CharacterDrawOptions {
  width: number;
  height: number;
  showRig?: boolean;
  activeJoint?: JointName;
  sourceImage?: CanvasImageSource;
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  rig: CharacterRig,
  pose: RetargetedPose | undefined,
  { width, height, showRig = false, activeJoint, sourceImage }: CharacterDrawOptions,
): void {
  ctx.clearRect(0, 0, width, height);
  const viewport = characterViewport(rig, width, height);
  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.scale, viewport.scale);
  const currentPose = showRig ? undefined : pose;
  if (currentPose && !currentPose.valid) { ctx.restore(); return; }
  if (showRig && sourceImage) {
    ctx.drawImage(sourceImage, 0, 0, rig.width, rig.height);
  } else {
    for (const part of [...rig.parts].sort((a, b) => a.drawOrder - b.drawOrder)) {
      const transform = getPartTransform(rig, part, currentPose);
      if (!Number.isFinite(transform.scale) || transform.scale <= 0) continue;
      const confidence = currentPose?.confidence[part.bone] ?? 1;
      // Long gaps are deliberately left empty instead of inventing a rest pose.
      if (currentPose && confidence < .35) continue;
      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.rotate(transform.rotation);
      ctx.scale(transform.scale, transform.scale);
      ctx.drawImage(part.image, -part.pivot.x, -part.pivot.y, part.width, part.height);
      ctx.restore();
    }
  }
  if (showRig) {
    ctx.lineWidth = 1.7 / viewport.scale;
    ctx.strokeStyle = '#72ffd5';
    ctx.setLineDash([4 / viewport.scale, 4 / viewport.scale]);
    ctx.beginPath();
    for (const bone of BONE_NAMES) {
      const [startName, endName] = BONE_JOINTS[bone];
      const start = rig.joints[startName];
      const end = rig.joints[endName];
      ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    for (const joint of JOINT_NAMES) {
      const point = rig.joints[joint];
      ctx.beginPath(); ctx.arc(point.x, point.y, (joint === activeJoint ? 6 : 4) / viewport.scale, 0, Math.PI * 2);
      ctx.fillStyle = joint === activeJoint ? '#ffffff' : '#55efc4'; ctx.fill();
      ctx.strokeStyle = '#112c3c'; ctx.stroke();
    }
  }
  ctx.restore();
}
