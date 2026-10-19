import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { HUMANOID_BONES } from '../motion3d/types.ts';
import type { Motion3DFrame } from '../motion3d/types.ts';
import { buildMotion3DJSON, exportMotionBVH } from './index.ts';
import { retargetFrame3D } from '../motion3d/retarget.ts';

function frame(timestampMs = 0): Motion3DFrame {
  return { timestampMs, rotations: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, w: 1 }])) as Motion3DFrame['rotations'],
    positions: Object.fromEntries(HUMANOID_BONES.map(name => [name, { x: 0, y: 0, z: 0, confidence: 1 }])) as Motion3DFrame['positions'],
    confidence: Object.fromEntries(HUMANOID_BONES.map(name => [name, 1])) as Motion3DFrame['confidence'],
    held: Object.fromEntries(HUMANOID_BONES.map(name => [name, false])) as Motion3DFrame['held'],
    root: { x: 0, y: 0, z: 0 }, rootTracked: true, scale: 0.4, valid: true, needsReview: false };
}

test('JSON retains failed observations and confidence even when BVH correctly refuses them', () => {
  const reference = frame(1250), invalid = frame(1350);
  invalid.valid = false; invalid.needsReview = true; invalid.confidence.handL = 0;
  const options = { frames: [reference, invalid], reference, fps: 24, strength: 1, inPlace: true, source: { name: 'test.mp4', analysisComplete: true } };
  assert.throws(() => exportMotionBVH(options), /tracking is missing/);
  const archive = JSON.parse(JSON.stringify(buildMotion3DJSON(options)));
  assert.equal(archive.format, 'motion3d-canonical');
  assert.equal(archive.schemaVersion, 1);
  assert.equal(archive.referenceTimestampMs, 1250);
  assert.deepEqual(archive.frames.map((value: Motion3DFrame) => value.timestampMs), [1250, 1350]);
  assert.equal(archive.frames[1].confidence.handL, 0);
  assert.equal(archive.poses[1].valid, false);
  assert.equal(archive.source.name, 'test.mp4');
  assert.equal(archive.settings.calibration, 'reference');
  assert.match(archive.coordinates.globalDepth, /unobserved/);
});

test('archive and BVH honor anatomical calibration rather than mapping the observed pose to bind', () => {
  const source = frame();
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  source.rotations.upperArmL = { x: q.x, y: q.y, z: q.z, w: q.w };
  const options = { frames: [source], reference: source, fps: 30, strength: 1, inPlace: true };
  const relative = buildMotion3DJSON(options);
  const anatomical = buildMotion3DJSON({ ...options, calibration: 'anatomical' });
  assert.equal(anatomical.settings.calibration, 'anatomical');
  assert.ok(Math.abs(relative.poses[0].rotations.upperArmL.z) < 1e-8);
  assert.ok(Math.abs(anatomical.poses[0].rotations.upperArmL.z) > 0.6);
  const relativeBVH = exportMotionBVH(options);
  const anatomicalBVH = exportMotionBVH({ ...options, calibration: 'anatomical' });
  assert.notEqual(relativeBVH.text, anatomicalBVH.text);
});

test('a trimmed JSON archive retains calibration outside its exported time range', () => {
  const reference = frame(0);
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .35);
  reference.rotations.hips = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
  const later = frame(2500);
  later.root.x = .8;
  const options = { frames: [later], reference, fps: 24, strength: 1, inPlace: false, calibration: 'anatomical' as const };
  const restored = JSON.parse(JSON.stringify(buildMotion3DJSON(options)));
  assert.equal(restored.frames[0].timestampMs, 2500);
  assert.equal(restored.reference.timestampMs, 0);
  const reproduced = retargetFrame3D(restored.frames[0], restored.reference, restored.skeleton, restored.settings);
  for (const name of HUMANOID_BONES) {
    assert.deepEqual(reproduced.positions[name], restored.poses[0].positions[name]);
    assert.deepEqual(reproduced.rotations[name], restored.poses[0].rotations[name]);
  }
});
