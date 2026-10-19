# 3D motion and Blender workflow

The default **3D / Blender** tab captures estimated body motion and applies it to a skinned humanoid. Its source video, analysis, reference, and character are separate from the **2D / PNG** tab. Both sessions survive tab changes and are discarded on page reload; there is no project save/load yet.

## Start with the generated example

Select **Try built-in motion**, then play or scrub the timeline. The six-second example contains 144 synthetic landmark samples at 24 samples per second, passed through the application's actual 3D solver. It exercises depth, body rotations, calibration, and export without running video inference. It is not a recording or a measured capture result.

The included **Studio humanoid** is an original procedural skinned model. Drag to orbit, scroll to zoom, or right-drag to pan. **Bind pose** displays the model at rest; **Motion** applies the current performance. **Mesh** and **Skeleton** can be toggled independently.

## Capture a video

1. Choose or drop a local MP4, WebM, MOV, or M4V video, up to 60 seconds and 250 MB. Decoder support depends on the browser. GIF is not supported.
2. Choose 12, 24, or 30 analysis samples per second and a smoothing preset. This rate does not change the source frame rate.
3. Read and acknowledge the MediaPipe metrics disclosure, then select **Analyze 3D motion**. Video processing happens on the device; see the [privacy information](../README.md#privacy-and-network-behavior) for dependency network behavior.
4. Review the source overlay, tracking quality, and character at the same timeline position. Cancelling retains partial analysis; restarting analyzes the video again.

Use a stable camera, good lighting, one person, and a clear view of the entire body. Single-camera depth is ambiguous. MediaPipe world landmarks estimate pelvis-relative body shape and depth; they do not measure the performer's absolute position, global depth travel, or camera movement.

The solver produces parent-local quaternions for 17 humanoid body bones with confidence and review flags. A missing observation can be held for at most 150 ms and is flagged. Longer loss becomes unavailable. This is body retargeting: finger articulation, facial animation, reliable axial limb twist, inverse kinematics, and foot locking are not implemented.

## Import a character

Use **Import GLB / FBX** with a skinned humanoid model smaller than 250 MB. A mesh without an armature or skin binding cannot be animated by this workflow. The importer normalizes visible height to 1.85 preview units, retaining the model's proportions and bind transforms.

The file must be self-contained. Embed textures and buffers; external resource URLs are blocked. Prefer standard PNG/JPEG textures and an uncompressed GLB. Draco, Meshopt, and Basis-required compressed GLBs are rejected because their decoders are not included. FBX files that depend on separate texture files must be re-exported with embedded resources or converted to a suitable GLB.

After import, inspect **Bone mapping and calibration**:

- Set **Original model forward** to the model's original +Z, −Z, +X, or −X direction.
- Inspect automatic assignments for hips, spine, chest, neck, head, arms, hands, thighs, shins, and feet. Left and right mean the character's anatomical sides.
- Assign missing or incorrect bones manually. One model bone cannot serve two body assignments, and mapped chains must follow the model's hierarchy.
- Unmapped parts retain their bind pose. Naming matches alone do not establish a correct mapping; review the deformation.

Helper bones and original bind rotations are preserved. The application transfers body motion to the mapped bones; it does not create weights or repair a malformed armature. **Studio humanoid** restores the included model.

## Calibrate motion

A valid reference is selected automatically. Seek to a clear frame and use **Set current 3D reference** when needed.

**Follow captured body pose**, the default, follows measured limb directions and uses the reference to align body facing and starting position. A neutral source stance does not become a T-pose merely because the character has a T-pose bind.

**Map reference to model bind pose** treats the selected source pose as the model's rest stance and transfers changes from it. Choose a reference that matches the model's T-pose or A-pose for this mode.

**Motion strength** scales rotation and translation changes from 0 to 2. At zero, the character retains its bind pose. **In-place motion** removes horizontal root travel and keeps vertical movement, including a squat. Uncheck it to retain image-derived horizontal and vertical travel. No global Z trajectory is estimated in either mode. Target bone lengths remain fixed.

## Export and open in Blender

Set **Start**, **End**, and **Output FPS** before exporting. Output rates are 24, 30, or 60 FPS, resampled from source timestamps with quaternion interpolation. A higher output rate does not recover unobserved motion. Only selected analyzed sample times are exported; partial analysis does not extend across the remainder of a video.

Animation exports reject invalid tracking, non-increasing timestamps, and observation gaps longer than 250 ms. **Include frames marked for review** explicitly permits uncertain but valid samples; it does not fill invalid samples or long gaps. Select a continuously tracked range instead. Keep JSON alongside animation exports because GLB/BVH do not retain per-sample confidence channels.

### Animated GLB: model and motion

Select **Download animated GLB** below the 3D preview. It includes the current model's geometry, materials, skin, skeleton, and baked motion. The selected export range, FPS, calibration, strength, and in-place setting apply to this download too.

In Blender, use **File > Import > glTF 2.0 (.glb/.gltf)**. Set the scene to the chosen output FPS and inspect the imported animation's frame range. The GLB importer handles axis conversion. No separate mesh binding step is needed for this exported character.

### BVH: animated skeleton

Select **Download Blender BVH** for skeleton motion without the character mesh or textures. In Blender, use **File > Import > Motion Capture (.bvh)** with scale **1**, **Y Up**, **−Z Forward**, and scene FPS updated to the file's rate. Set the scene range to the imported animation.

The [import helper](../blender/import_motion.py) applies the project's intended axes, units, FPS, and frame range:

```sh
blender --background --python-exit-code 1 --python blender/import_motion.py -- capture.motion3d.bvh capture.blend
```

Omit the final path to import without saving a `.blend`. The helper imports an animated source armature. To drive another character from this BVH, retarget its bones and reference pose in Blender; importing BVH does not bind an arbitrary mesh automatically.

### 3D JSON: review archive

**Save 3D motion JSON** downloads `motion3d-canonical`, schema version 1. It records source metadata, original sample times, source rotations, confidence/held/review flags, target skeleton, retargeted poses, and calibration settings. The complete reference frame is retained even when it falls outside a trimmed export range. Coordinates are right-handed with +Y up, +X image-right, and +Z toward the camera; quaternions use `[x, y, z, w]`.

This archive can preserve failed tracking for inspection, unlike an animation export. It is not a Blender scene or an application project file, and it does not embed the imported character. Review source/model names, motion, and asset redistribution rights before sharing any export.

## Reproduce the Blender checks

After `npm ci`, run this from the repository root:

```sh
npm run test:blender
```

The runner finds Blender on PATH or in the standard Windows installation directory.
Set `BLENDER_PATH` to its executable if it is installed elsewhere. It runs the
following individual checks, which can also be used when investigating a failure:

```sh
node scripts/verify-blender-fixture.mjs
blender --background --factory-startup --python-exit-code 1 --python scripts/verify-blender-import.py -- .local/blender-qa
node scripts/verify-blender-model-fixture.mjs
blender --background --factory-startup --python-exit-code 1 --python scripts/verify-blender-model.py -- .local/blender-qa
node scripts/verify-blender-fbx.mjs
```

The first pair generates deterministic BVH and checks imported Blender joint transforms, end sites, timing, and units. The next pair generates an animated GLB when no cached fixture exists, compares Blender's joints and deformed vertices against independent Three.js evaluations, and exports a local FBX fixture. The final command imports that FBX through the application's loader and verifies mapping, deformation, and retargeted transforms. Reports, rendered previews, fixtures, and `.blend` files are written under the ignored `.local/blender-qa/` directory; the GLB fixture is stored under `.local/`.

These generated-fixture checks have passed with Blender 5.1.1; observed position/deformation errors were below 0.000001 meters. They establish interoperability for the tested fixtures, not compatibility with every model or proof of real-video tracking quality. Real-video browser import, inference, calibration, and export should also be checked on the intended browser and character. The generated example and headless fixture checks do not replace that validation.

The original 2D workflow remains documented in the [README](../README.md#try-a-2d-performance). Its OpenToonz export is still planned.
