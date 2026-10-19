import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Motion3DFrame } from '../motion3d/types.ts';
import { retargetFrame3D } from '../motion3d/retarget.ts';
import { resamplePoses } from '../export3d/bvh.ts';
import { applyPose3D, cloneCharacter3D, resetCharacter3D } from './rig.ts';
import type { CharacterRig3D } from './rig.ts';

export interface AnimatedModelOptions3D {
  frames: readonly Motion3DFrame[];
  reference: Motion3DFrame;
  fps: number;
  strength: number;
  inPlace: boolean;
  allowUncertain?: boolean;
  calibration?: 'anatomical' | 'reference';
  name?: string;
}

/** Bake actual model-local bone transforms, including unmapped intermediary bones. */
export function bakeModelClip3D(rig: CharacterRig3D, options: AnimatedModelOptions3D) {
  const poses = options.frames.map(frame => retargetFrame3D(frame, options.reference, rig.skeleton, options));
  const sampled = resamplePoses({ skeleton: rig.skeleton, poses, fps: options.fps, allowUncertain: options.allowUncertain });
  if (!Object.keys(rig.mapping).length) throw new Error('Map the model’s body bones before exporting an animated character.');
  const clone = cloneCharacter3D(rig);
  const times = sampled.poses.map(pose => (pose.timestampMs - sampled.sourceStartMs) / 1000);
  const rotations = new Map(clone.bones.map(bone => [bone, [] as number[]]));
  const translations: number[] = [];
  for (const pose of sampled.poses) {
    applyPose3D(clone, pose);
    translations.push(clone.root.position.x, clone.root.position.y, clone.root.position.z);
    for (const bone of clone.bones) rotations.get(bone)!.push(bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w);
  }
  resetCharacter3D(clone);
  const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack(`${clone.root.uuid}.position`, times, translations)];
  for (const [bone, values] of rotations) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, values));
  const clip = new THREE.AnimationClip(options.name || 'Captured motion', times[times.length - 1] ?? 0, tracks);
  clone.root.name = clone.root.name || 'Motion2D character';
  clone.root.userData.motionCapture = {
    format: 'motion2d-character-animation', version: 1, fps: options.fps,
    sourceStartMs: sampled.sourceStartMs, sourceEndMs: sampled.sourceEndMs,
    coordinates: 'right-handed, Y-up, +Z-forward',
    scale: 'model normalized to 1.85 height units; studio humanoid uses meters',
    includesUncertainFrames: !!options.allowUncertain,
    warnings: sampled.warnings.map(warning => warning.replace(/BVH/g, 'GLB')),
  };
  return { rig: clone, clip, sampled };
}

export async function exportAnimatedGLB3D(rig: CharacterRig3D, options: AnimatedModelOptions3D): Promise<ArrayBuffer> {
  const baked = bakeModelClip3D(rig, options);
  try {
    const data = await new GLTFExporter().parseAsync(baked.rig.root, { binary: true, trs: true, onlyVisible: false, animations: [baked.clip] });
    if (!(data instanceof ArrayBuffer)) throw new Error('The exporter did not produce a binary GLB model.');
    return data;
  } finally {
    // SkeletonUtils.clone shares geometries/materials/textures with the live model.
    // Dispose only the cloned skeletons; disposing mesh resources would break the preview.
    baked.rig.root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.dispose(); });
  }
}
