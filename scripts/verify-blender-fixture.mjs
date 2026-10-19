// Generate a deterministic, redistribution-safe fixture using Three.js as an
// independent quaternion/FK implementation. Blender verifies the exported file.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Euler, Quaternion, Vector3 } from 'three';
import { createDefaultSkeleton3D } from '../src/motion3d/retarget.ts';
import { HUMANOID_BONES } from '../src/motion3d/types.ts';
import { exportPosesBVH } from '../src/export3d/bvh.ts';

const directory = resolve(process.argv[2] ?? '.local/blender-qa');
await mkdir(directory, { recursive: true });
const skeleton = createDefaultSkeleton3D();
const plainVector = v => ({ x: v.x, y: v.y, z: v.z });
const plainQuaternion = q => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const quaternion = q => new Quaternion(q.x, q.y, q.z, q.w);
function forwardKinematics(rotations, root) {
  const positions = {}, worldRotations = {}, ends = {};
  for (const name of HUMANOID_BONES) {
    const bone = skeleton.bones[name];
    const local = quaternion(rotations[name]);
    worldRotations[name] = bone.parent ? worldRotations[bone.parent].clone().multiply(local) : local;
    positions[name] = bone.parent
      ? new Vector3(bone.offset.x, bone.offset.y, bone.offset.z).applyQuaternion(worldRotations[bone.parent]).add(positions[bone.parent])
      : new Vector3(root.x, root.y, root.z);
    if (bone.endOffset) ends[name] = plainVector(new Vector3(bone.endOffset.x, bone.endOffset.y, bone.endOffset.z).applyQuaternion(worldRotations[name]).add(positions[name]));
  }
  return { positions: Object.fromEntries(Object.entries(positions).map(([k, v]) => [k, plainVector(v)])),
    worldRotations: Object.fromEntries(Object.entries(worldRotations).map(([k, q]) => [k, plainQuaternion(q)])), ends };
}
const poses = [];
for (let index = 0; index <= 4; index++) {
  const phase = index / 4;
  const root = { x: 0.4 * phase, y: 0.98 - 0.12 * Math.sin(phase * Math.PI), z: -0.1 * phase };
  const rotations = {};
  for (let boneIndex = 0; boneIndex < HUMANOID_BONES.length; boneIndex++) {
    const name = HUMANOID_BONES[boneIndex];
    const sign = name.endsWith('R') ? -1 : 1;
    let xyz = [0.22 * Math.sin(phase * 2.4 + boneIndex * 0.2), 0.17 * Math.cos(phase * 3 + boneIndex * 0.1), sign * 0.3 * Math.sin(phase * 2.7)];
    if (name === 'hips') xyz = [0.2 + phase * 0.3, phase * 0.8, -0.12 + phase * 0.4];
    if (name === 'forearmL') xyz = [0.35, phase * Math.PI / 2, -0.7]; // exact gimbal lock at the final sample
    if (name === 'handR') xyz = [-0.2, 0.3, (175 + 20 * phase) * Math.PI / 180]; // crosses the Euler wrap boundary
    const q = new Quaternion().setFromEuler(new Euler(...xyz, 'XYZ'));
    if (index === 2 && name === 'chest') q.set(-q.x, -q.y, -q.z, -q.w); // equivalent antipodal representation
    rotations[name] = plainQuaternion(q);
  }
  const calculated = forwardKinematics(rotations, root);
  poses.push({ timestampMs: 1250 + index * 250, root, rotations, positions: calculated.positions,
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])), valid: true, needsReview: false });
}
const fps = 24;
const exported = exportPosesBVH({ skeleton, poses, fps });
const expectedFrames = [];
for (let i = 0; i < exported.frameCount; i++) {
  const timestampMs = poses[0].timestampMs + i * 1000 / fps;
  const sourceIndex = Math.min(poses.length - 2, Math.floor((timestampMs - poses[0].timestampMs) / 250));
  const a = poses[sourceIndex], b = poses[sourceIndex + 1];
  const amount = (timestampMs - a.timestampMs) / (b.timestampMs - a.timestampMs);
  const root = plainVector(new Vector3(a.root.x, a.root.y, a.root.z).lerp(new Vector3(b.root.x, b.root.y, b.root.z), amount));
  const rotations = Object.fromEntries(HUMANOID_BONES.map(name => [name, plainQuaternion(quaternion(a.rotations[name]).slerp(quaternion(b.rotations[name]), amount))]));
  expectedFrames.push({ frame: i + 1, timestampMs, root, ...forwardKinematics(rotations, root) });
}
const fixture = { schemaVersion: 1, fps, frameCount: exported.frameCount, skeleton, frames: expectedFrames,
  note: 'Expected transforms independently calculated with Three.js quaternion interpolation and FK.' };
await writeFile(resolve(directory, 'verification.motion3d.bvh'), exported.text);
await writeFile(resolve(directory, 'verification.expected.json'), JSON.stringify(fixture, null, 2));
process.stdout.write(`Generated ${exported.frameCount} BVH frames at ${fps} FPS in ${directory}\n`);
