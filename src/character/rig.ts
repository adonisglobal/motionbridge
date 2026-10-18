import { BONE_JOINTS, BONE_NAMES } from '../motion/canonical.ts';
import type { BoneName, JointName, Vec2 } from '../motion/canonical.ts';

export interface CharacterPart {
  id: string;
  name: string;
  bone: BoneName;
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Anchors are measured in source PNG pixels. */
  pivot: Vec2;
  tip: Vec2;
  restAngle: number;
  drawOrder: number;
  source: 'builtin' | 'single-image' | 'imported';
}

export interface CharacterRig {
  width: number;
  height: number;
  joints: Record<JointName, Vec2>;
  parts: CharacterPart[];
  name: string;
  /** Width of the visible alpha bounds, used only for the manual image masks. */
  bodyWidth?: number;
}

export interface ImageBounds { x: number; y: number; width: number; height: number }

export const BONE_LABELS: Record<BoneName, string> = {
  torso: 'Torso', head: 'Head',
  upperArmL: 'Left upper arm', forearmL: 'Left forearm', handL: 'Left hand',
  upperArmR: 'Right upper arm', forearmR: 'Right forearm', handR: 'Right hand',
  thighL: 'Left thigh', shinL: 'Left shin', footL: 'Left foot',
  thighR: 'Right thigh', shinR: 'Right shin', footR: 'Right foot',
};

export const JOINT_LABELS: Record<JointName, string> = {
  pelvis: 'Pelvis', spine: 'Mid spine', chest: 'Chest', neck: 'Neck', head: 'Head tip',
  shoulderL: 'Left shoulder', elbowL: 'Left elbow', wristL: 'Left wrist', handL: 'Left hand tip',
  shoulderR: 'Right shoulder', elbowR: 'Right elbow', wristR: 'Right wrist', handR: 'Right hand tip',
  hipL: 'Left hip', kneeL: 'Left knee', ankleL: 'Left ankle', toeL: 'Left toe',
  hipR: 'Right hip', kneeR: 'Right knee', ankleR: 'Right ankle', toeR: 'Right toe',
};

const DRAW_ORDER: Record<BoneName, number> = {
  upperArmR: 0, forearmR: 1, handR: 2, thighR: 3, shinR: 4, footR: 5,
  thighL: 6, shinL: 7, footL: 8, torso: 9, head: 10,
  upperArmL: 11, forearmL: 12, handL: 13,
};

export function createRestJoints(width: number, height: number): Record<JointName, Vec2> {
  const positions: Record<JointName, [number, number]> = {
    pelvis: [.5, .56], spine: [.5, .44], chest: [.5, .33], neck: [.5, .25], head: [.5, .135],
    shoulderL: [.61, .28], elbowL: [.67, .43], wristL: [.68, .57], handL: [.68, .62],
    shoulderR: [.39, .28], elbowR: [.33, .43], wristR: [.32, .57], handR: [.32, .62],
    hipL: [.565, .56], kneeL: [.585, .74], ankleL: [.59, .9], toeL: [.655, .94],
    hipR: [.435, .56], kneeR: [.415, .74], ankleR: [.41, .9], toeR: [.345, .94],
  };
  return Object.fromEntries(Object.entries(positions).map(([name, [x, y]]) => [name, { x: x * width, y: y * height }])) as Record<JointName, Vec2>;
}

/** An arms-down starting layout inside the visible image bounds; users calibrate it manually. */
export function seedImageJoints(bounds: ImageBounds): Record<JointName, Vec2> {
  const positions: Record<JointName, [number, number]> = {
    pelvis: [.52, .49], spine: [.52, .39], chest: [.52, .29], neck: [.53, .20], head: [.53, .105],
    shoulderL: [.78, .225], elbowL: [.90, .40], wristL: [.90, .52], handL: [.88, .57],
    shoulderR: [.28, .225], elbowR: [.15, .37], wristR: [.21, .52], handR: [.22, .57],
    hipL: [.65, .49], kneeL: [.62, .69], ankleL: [.64, .90], toeL: [.87, .955],
    hipR: [.40, .49], kneeR: [.33, .69], ankleR: [.30, .90], toeR: [.22, .955],
  };
  return Object.fromEntries(Object.entries(positions).map(([name, [x, y]]) =>
    [name, { x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height }],
  )) as Record<JointName, Vec2>;
}

function alphaBounds(image: HTMLImageElement): ImageBounds {
  const probe = canvas(image.naturalWidth, image.naturalHeight);
  const ctx = probe.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let minX = probe.width; let minY = probe.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < probe.height; y += 1) {
    for (let x = 0; x < probe.width; x += 1) {
      if (pixels[(y * probe.width + x) * 4 + 3] < 128) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('This image is fully transparent. Choose an image with a visible character.');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function withPartAnchors(part: CharacterPart, pivot: Vec2, tip: Vec2): CharacterPart {
  if (Math.hypot(tip.x - pivot.x, tip.y - pivot.y) < 1) return part;
  return { ...part, pivot: { ...pivot }, tip: { ...tip }, restAngle: Math.atan2(tip.y - pivot.y, tip.x - pivot.x) };
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

async function pngImage(element: HTMLCanvasElement): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = element.toDataURL('image/png');
  await image.decode();
  return image;
}

function boneRadius(bone: BoneName, width: number): number {
  if (bone === 'head') return width * .115;
  if (bone === 'torso') return width * .17;
  if (bone.startsWith('thigh')) return width * .067;
  if (bone.startsWith('shin')) return width * .055;
  if (bone.startsWith('foot')) return width * .065;
  if (bone.startsWith('upperArm')) return width * .052;
  return width * .042;
}

function capsulePath(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, radius: number): void {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.beginPath();
  ctx.arc(a.x, a.y, radius, angle + Math.PI / 2, angle + Math.PI * 1.5);
  ctx.arc(b.x, b.y, radius, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.closePath();
}

function maskPath(ctx: CanvasRenderingContext2D, rig: CharacterRig, bone: BoneName): void {
  const [start, end] = BONE_JOINTS[bone];
  const a = rig.joints[start];
  const b = rig.joints[end];
  const manualWidth = rig.bodyWidth;
  const radius = manualWidth
    ? manualWidth * (bone === 'head' ? .23 : bone.startsWith('thigh') ? .12 : bone.startsWith('foot') ? .15 : bone.startsWith('shin') ? .10 : .095)
    : boneRadius(bone, rig.width);
  if (bone === 'torso') {
    const left = rig.joints.shoulderL;
    const right = rig.joints.shoulderR;
    const leftHip = rig.joints.hipL;
    const rightHip = rig.joints.hipR;
    const padding = manualWidth ? manualWidth * .06 : rig.width * .04;
    ctx.beginPath();
    ctx.moveTo(right.x - padding, right.y - padding);
    ctx.lineTo(b.x, b.y - padding);
    ctx.lineTo(left.x + padding, left.y - padding);
    ctx.lineTo(leftHip.x + padding, leftHip.y + padding);
    ctx.lineTo(rightHip.x - padding, rightHip.y + padding);
    ctx.closePath();
  } else if (bone === 'head') {
    const center = { x: b.x, y: b.y + (a.y - b.y) * .08 };
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, radius, Math.max(radius * 1.1, Math.hypot(a.x - b.x, a.y - b.y) * .75), 0, 0, Math.PI * 2);
  } else {
    capsulePath(ctx, a, b, radius);
  }
}

async function croppedPart(
  element: HTMLCanvasElement,
  rig: CharacterRig,
  bone: BoneName,
  source: CharacterPart['source'],
): Promise<CharacterPart> {
  const ctx = element.getContext('2d')!;
  const pixels = ctx.getImageData(0, 0, element.width, element.height).data;
  let minX = element.width;
  let minY = element.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < element.height; y += 1) {
    for (let x = 0; x < element.width; x += 1) {
      if (pixels[(y * element.width + x) * 4 + 3] <= 2) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (minX > maxX || minY > maxY) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const crop = canvas(width, height);
  crop.getContext('2d')!.drawImage(element, minX, minY, width, height, 0, 0, width, height);
  const [start, end] = BONE_JOINTS[bone];
  const pivot = { x: rig.joints[start].x - minX, y: rig.joints[start].y - minY };
  const tip = { x: rig.joints[end].x - minX, y: rig.joints[end].y - minY };
  return {
    id: bone, name: BONE_LABELS[bone], bone, image: await pngImage(crop), width, height,
    pivot, tip, restAngle: Math.atan2(tip.y - pivot.y, tip.x - pivot.x), drawOrder: DRAW_ORDER[bone], source,
  };
}

/** Every body segment becomes a real, transparent PNG, generated locally. */
export async function createBuiltinRig(): Promise<CharacterRig> {
  const rig: CharacterRig = { width: 360, height: 480, joints: createRestJoints(360, 480), parts: [], name: 'Lab character' };
  for (const bone of BONE_NAMES) {
    const image = canvas(rig.width, rig.height);
    const ctx = image.getContext('2d')!;
    const [start, end] = BONE_JOINTS[bone];
    const a = rig.joints[start];
    const b = rig.joints[end];
    const radius = boneRadius(bone, rig.width);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#132d3d';
    ctx.lineWidth = 3;
    if (bone === 'torso') {
      maskPath(ctx, rig, bone);
      ctx.fillStyle = '#55d6b3'; ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#91f3d5'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y - 17); ctx.lineTo(b.x, b.y + 14); ctx.stroke();
      ctx.fillStyle = '#183b48';
      ctx.roundRect(a.x - 30, a.y - 12, 60, 18, 6); ctx.fill();
      ctx.fillStyle = '#e1fff4'; ctx.beginPath(); ctx.arc(195, 163, 6, 0, Math.PI * 2); ctx.fill();
    } else if (bone === 'head') {
      ctx.fillStyle = '#d3bbff';
      ctx.roundRect(a.x - 13, a.y - 25, 26, 32, 10); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(b.x, b.y + 6, 39, 42, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#20384d';
      ctx.beginPath(); ctx.ellipse(b.x, b.y + 5, 28, 17, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#82f4d4';
      for (const offset of [-11, 11]) { ctx.beginPath(); ctx.ellipse(b.x + offset, b.y + 3, 3, 5, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = '#8ef3d7'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(b.x, b.y + 10, 5, .2, Math.PI - .2); ctx.stroke();
      ctx.fillStyle = '#c2a2ff'; ctx.beginPath(); ctx.arc(b.x, b.y - 42, 5, 0, Math.PI * 2); ctx.fill();
    } else {
      capsulePath(ctx, a, b, radius);
      ctx.fillStyle = bone.startsWith('hand') ? '#d7c2ff'
        : bone.startsWith('foot') ? '#b5a3ec'
          : bone.startsWith('thigh') || bone.startsWith('shin') ? '#264b5e' : '#68dabc';
      ctx.fill(); ctx.stroke();
      if (!bone.startsWith('hand') && !bone.startsWith('foot')) {
        ctx.beginPath(); ctx.arc(a.x, a.y, radius * .36, 0, Math.PI * 2);
        ctx.fillStyle = '#a5e8db'; ctx.fill();
      }
    }
    rig.parts.push(await croppedPart(image, rig, bone, 'builtin'));
  }
  return rig;
}

/** A geometric manual cutout, deliberately independent of any automatic segmentation. */
export async function createSingleImageRig(image: HTMLImageElement, existing?: CharacterRig): Promise<CharacterRig> {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const bounds = alphaBounds(image);
  const rig: CharacterRig = {
    width, height, name: 'Single-image character', bodyWidth: bounds.width,
    joints: existing?.width === width && existing.height === height ? structuredClone(existing.joints) : seedImageJoints(bounds),
    parts: [],
  };
  for (const bone of BONE_NAMES) {
    const layer = canvas(width, height);
    const ctx = layer.getContext('2d')!;
    ctx.save(); maskPath(ctx, rig, bone); ctx.clip(); ctx.drawImage(image, 0, 0); ctx.restore();
    const part = await croppedPart(layer, rig, bone, 'single-image');
    part.drawOrder = existing?.parts.find(previous => previous.bone === bone)?.drawOrder ?? part.drawOrder;
    rig.parts.push(part);
    // Yield between PNGs so preparing a large character keeps the controls responsive.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  return rig;
}

export async function loadPng(file: File): Promise<HTMLImageElement> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG image smaller than 10 MB.');
  const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte) || bytes.length < 24) {
    throw new Error('The character file must be a valid PNG image.');
  }
  const header = new DataView(bytes.buffer);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 12_000_000) {
    throw new Error('Images must be at most 4096 pixels per side and 12 megapixels. Resize the image and try again.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const maxEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (maxEdge > 1024) {
      const preview = canvas(Math.round(image.naturalWidth * 1024 / maxEdge), Math.round(image.naturalHeight * 1024 / maxEdge));
      preview.getContext('2d')!.drawImage(image, 0, 0, preview.width, preview.height);
      return await pngImage(preview);
    }
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function guessBone(filename: string): BoneName | undefined {
  const normalized = filename.replace(/\.png$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const aliases: Record<string, BoneName> = {
    torso: 'torso', body: 'torso', head: 'head',
    upperarml: 'upperArmL', upperarmr: 'upperArmR',
    forearml: 'forearmL', forearmr: 'forearmR', handl: 'handL', handr: 'handR',
    thighl: 'thighL', thighr: 'thighR', shinl: 'shinL', shinr: 'shinR', footl: 'footL', footr: 'footR',
  };
  return aliases[normalized];
}

export function importedPart(image: HTMLImageElement, bone: BoneName, name: string): CharacterPart {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  let pivot = { x: width * .5, y: height * .1 };
  let tip = { x: width * .5, y: height * .9 };
  if (bone === 'head' || bone === 'torso') {
    pivot = { x: width * .5, y: height * .85 };
    tip = { x: width * .5, y: height * .15 };
  } else if (bone.startsWith('foot')) {
    pivot = { x: width * .2, y: height * .5 };
    tip = { x: width * .8, y: height * .5 };
  }
  return {
    id: bone, bone, name, image, width, height, pivot, tip,
    restAngle: Math.atan2(tip.y - pivot.y, tip.x - pivot.x), drawOrder: DRAW_ORDER[bone], source: 'imported',
  };
}

export function replacePart(rig: CharacterRig, part: CharacterPart): CharacterRig {
  return { ...rig, parts: [...rig.parts.filter(existing => existing.bone !== part.bone), part] };
}
