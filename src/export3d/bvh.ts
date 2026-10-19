import type { Bone3D, Pose3D, Quat, Skeleton3D, Vec3 } from '../motion3d/types.ts';

export interface PoseExportOptions {
  skeleton: Skeleton3D;
  poses: readonly Pose3D[];
  /** Uniform output frame rate. The source timestamps, rather than source frame indices, determine sampling. */
  fps: number;
  /** BVH has no confidence channels. Explicitly opt in to including poses marked for review. */
  allowUncertain?: boolean;
  /** No interpolation is permitted over a longer observation gap, even with allowUncertain. */
  maxGapMs?: number;
}

export interface BVHExportResult {
  text: string;
  frameCount: number;
  fps: number;
  sourceStartMs: number;
  sourceEndMs: number;
  warnings: string[];
}

export interface ResampledMotion {
  poses: Pose3D[];
  sourceStartMs: number;
  sourceEndMs: number;
  warnings: string[];
}

function finiteVector(value: Vec3 | undefined): boolean {
  return !!value && [value.x, value.y, value.z].every(Number.isFinite);
}

function normalizedQuaternion(value: Quat): Quat {
  if (!value || ![value.x, value.y, value.z, value.w].every(Number.isFinite)) {
    throw new Error('A 3D pose contains an invalid joint rotation.');
  }
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (length < 1e-8) throw new Error('A 3D pose contains an empty joint rotation.');
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

/** Shortest-path quaternion interpolation, including antipodal representations of the same rotation. */
function slerp(a: Quat, b: Quat, amount: number): Quat {
  a = normalizedQuaternion(a);
  b = normalizedQuaternion(b);
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (dot < 0) {
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    dot = -dot;
  }
  let left = 1 - amount;
  let right = amount;
  if (dot < 0.9995) {
    const angle = Math.acos(Math.min(1, dot));
    left = Math.sin((1 - amount) * angle) / Math.sin(angle);
    right = Math.sin(amount * angle) / Math.sin(angle);
  }
  return normalizedQuaternion({
    x: left * a.x + right * b.x,
    y: left * a.y + right * b.y,
    z: left * a.z + right * b.z,
    w: left * a.w + right * b.w,
  });
}

function mixVector(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function multiplyQuaternion(a: Quat, b: Quat): Quat {
  return { x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z };
}

function rotateVector(v: Vec3, q: Quat): Vec3 {
  const p = multiplyQuaternion(multiplyQuaternion(q, { ...v, w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
  return { x: p.x, y: p.y, z: p.z };
}

/** BVH hierarchy channels and motion values must use exactly the same depth-first traversal. */
export function skeletonTraversal(skeleton: Skeleton3D): Bone3D[] {
  const names = Object.keys(skeleton.bones) as Bone3D[];
  const roots = names.filter((name) => skeleton.bones[name].parent === null);
  if (roots.length !== 1 || roots[0] !== 'hips') throw new Error('The 3D skeleton must have one hips root.');
  const order: Bone3D[] = [];
  const seen = new Set<Bone3D>();
  function visit(name: Bone3D): void {
    if (seen.has(name)) throw new Error('The 3D skeleton hierarchy contains a cycle.');
    seen.add(name);
    const bone = skeleton.bones[name];
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !finiteVector(bone.offset)) {
      throw new Error('The 3D skeleton contains an invalid name or offset.');
    }
    if (bone.endOffset && !finiteVector(bone.endOffset)) throw new Error('The skeleton has an invalid end offset.');
    order.push(name);
    for (const child of names.filter((child) => skeleton.bones[child].parent === name)) visit(child);
  }
  visit('hips');
  if (order.length !== names.length) throw new Error('The 3D skeleton contains disconnected joints.');
  return order;
}

export function resamplePoses(options: PoseExportOptions): ResampledMotion {
  const { poses, fps, skeleton, allowUncertain = false, maxGapMs = 250 } = options;
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Choose an output frame rate between 1 and 120 FPS.');
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0) throw new Error('The maximum observation gap must be positive.');
  if (!poses.length) throw new Error('Analyze a video before exporting 3D motion.');
  const order = skeletonTraversal(skeleton);
  let uncertainCount = 0;
  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    if (!Number.isFinite(pose.timestampMs) || !finiteVector(pose.root) || !pose.valid) {
      throw new Error(`3D tracking is missing at sample ${i + 1}. Trim the source to a continuously tracked section and analyze it again.`);
    }
    if (i && pose.timestampMs <= poses[i - 1].timestampMs) throw new Error('3D samples must have increasing timestamps.');
    if (i && pose.timestampMs - poses[i - 1].timestampMs > maxGapMs + 1e-6) {
      throw new Error(`There is an observation gap longer than ${maxGapMs} ms. Export cannot fill unobserved movement.`);
    }
    let uncertain = pose.needsReview;
    for (const name of order) {
      normalizedQuaternion(pose.rotations[name]);
      const confidence = pose.confidence[name];
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('A 3D pose contains invalid confidence data.');
      if (confidence < 0.35) uncertain = true;
    }
    if (uncertain) uncertainCount++;
  }
  if (uncertainCount && !allowUncertain) {
    throw new Error(`${uncertainCount} source samples need review. Review the preview, then enable "Include frames marked for review" to export them explicitly.`);
  }
  const first = poses[0].timestampMs;
  const last = poses[poses.length - 1].timestampMs;
  const count = Math.floor((last - first) * fps / 1000 + 1e-7) + 1;
  const result: Pose3D[] = [];
  let left = 0;
  for (let frame = 0; frame < count; frame++) {
    const timestampMs = first + frame * 1000 / fps;
    while (left + 1 < poses.length && poses[left + 1].timestampMs < timestampMs - 1e-7) left++;
    const a = poses[left];
    const b = poses[Math.min(left + 1, poses.length - 1)];
    const amount = b.timestampMs === a.timestampMs ? 0 : Math.max(0, Math.min(1, (timestampMs - a.timestampMs) / (b.timestampMs - a.timestampMs)));
    const rotations = {} as Pose3D['rotations'];
    const positions = {} as Pose3D['positions'];
    const confidence = {} as Pose3D['confidence'];
    const worldRotations = {} as Pose3D['rotations'];
    const root = mixVector(a.root, b.root, amount);
    for (const name of order) {
      rotations[name] = slerp(a.rotations[name], b.rotations[name], amount);
      const parent = skeleton.bones[name].parent;
      if (parent === null) {
        positions[name] = { ...root };
        worldRotations[name] = rotations[name];
      } else {
        const offset = rotateVector(skeleton.bones[name].offset, worldRotations[parent]);
        const origin = positions[parent];
        positions[name] = { x: origin.x + offset.x, y: origin.y + offset.y, z: origin.z + offset.z };
        worldRotations[name] = multiplyQuaternion(worldRotations[parent], rotations[name]);
      }
      confidence[name] = Math.min(a.confidence[name], b.confidence[name]);
    }
    result.push({ ...a, timestampMs, rotations, positions, confidence, root, needsReview: a.needsReview || b.needsReview });
  }
  return {
    poses: result,
    sourceStartMs: first,
    sourceEndMs: first + (count - 1) * 1000 / fps,
    warnings: uncertainCount ? [`${uncertainCount} source samples were marked for review. BVH does not preserve confidence; retain the 3D JSON alongside it.`] : [],
  };
}

type EulerTriple = readonly [number, number, number];

/** Intrinsic XYZ: the BVH channel sequence multiplies Rx * Ry * Rz. */
function quaternionToXYZ(q: Quat): EulerTriple {
  const { x, y, z, w } = normalizedQuaternion(q);
  const m13 = 2 * (x * z + y * w);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(2 * (x * w - y * z), 1 - 2 * (x * x + y * y)), ry, Math.atan2(2 * (z * w - x * y), 1 - 2 * (y * y + z * z))];
  }
  return [Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + z * z)), ry, 0];
}

function continuousEuler(value: EulerTriple, previous?: EulerTriple): EulerTriple {
  if (!previous) return value;
  const unwrap = (v: number, p: number) => v + Math.round((p - v) / (Math.PI * 2)) * Math.PI * 2;
  const variants: EulerTriple[] = [value, [value[0] + Math.PI, Math.PI - value[1], value[2] + Math.PI]];
  const candidates = variants.map((v) => v.map((n, i) => unwrap(n, previous[i])) as unknown as EulerTriple);
  const distance = (v: EulerTriple) => v.reduce((sum, n, i) => sum + (n - previous[i]) ** 2, 0);
  return distance(candidates[0]) <= distance(candidates[1]) ? candidates[0] : candidates[1];
}

function format(value: number): string { return Math.abs(value) < 5e-10 ? '0' : value.toFixed(9).replace(/\.?0+$/, ''); }
function vectorText(value: Vec3): string { return `${format(value.x)} ${format(value.y)} ${format(value.z)}`; }

/** Export metre-scale, right-handed Y-up, +Z-forward BVH. Blender import: scale 1, Y up, -Z forward, update scene FPS. */
export function exportPosesBVH(options: PoseExportOptions): BVHExportResult {
  const { skeleton, fps } = options;
  const sampled = resamplePoses(options);
  const order = skeletonTraversal(skeleton);
  const lines = ['HIERARCHY'];
  function joint(name: Bone3D, depth: number): void {
    const indent = '  '.repeat(depth);
    const bone = skeleton.bones[name];
    const children = order.filter((child) => skeleton.bones[child].parent === name);
    // A zero root OFFSET avoids importer disagreement over whether translation
    // channels replace or add to that offset. Absolute root height is in channels.
    const offset = bone.parent === null ? { x: 0, y: 0, z: 0 } : bone.offset;
    lines.push(`${indent}${bone.parent === null ? 'ROOT' : 'JOINT'} ${name}`, `${indent}{`, `${indent}  OFFSET ${vectorText(offset)}`,
      `${indent}  CHANNELS ${bone.parent === null ? '6 Xposition Yposition Zposition' : '3'} Xrotation Yrotation Zrotation`);
    for (const child of children) joint(child, depth + 1);
    if (!children.length) lines.push(`${indent}  End Site`, `${indent}  {`, `${indent}    OFFSET ${vectorText(bone.endOffset ?? { x: 0, y: 0.08, z: 0 })}`, `${indent}  }`);
    lines.push(`${indent}}`);
  }
  joint('hips', 0);
  lines.push('MOTION', `Frames: ${sampled.poses.length}`, `Frame Time: ${(1 / fps).toFixed(12)}`);
  const previous = new Map<Bone3D, EulerTriple>();
  for (const pose of sampled.poses) {
    const values = [pose.root.x, pose.root.y, pose.root.z];
    for (const name of order) {
      const euler = continuousEuler(quaternionToXYZ(pose.rotations[name]), previous.get(name));
      previous.set(name, euler);
      values.push(...euler.map((n) => n * 180 / Math.PI));
    }
    lines.push(values.map(format).join(' '));
  }
  return { text: `${lines.join('\n')}\n`, frameCount: sampled.poses.length, fps, sourceStartMs: sampled.sourceStartMs, sourceEndMs: sampled.sourceEndMs, warnings: sampled.warnings };
}
