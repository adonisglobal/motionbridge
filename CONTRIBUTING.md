# Contributing to MotionBridge

MotionBridge is an experimental browser tool with a 3D/Blender workspace and an independent 2D/PNG workspace. Contributions that improve reproducibility, tracking review, rig editing, and clearly tested motion behavior are welcome.

## Set up a development environment

Use Node.js 24 with npm. From a checkout of the repository:

```sh
npm ci
npm run setup:assets
npm run dev
```

The setup script downloads the model and copies the installed MediaPipe runtime. Generated assets, `node_modules/`, `dist/`, and local test media should stay outside Git. See the [README](README.md) for supported inputs, privacy information, and current limitations.

## Propose a change

For a bug, describe the expected and actual behavior, browser and operating system, steps to reproduce, and any relevant error message. Include a minimal sample only when you have permission to redistribute it. Avoid sharing personal video, credentials, or private motion data in public issues.

For larger features or changes to the motion-data schema, open an issue first to discuss the intended behavior and compatibility. Keep pull requests focused on one problem and explain how someone can observe the improvement.

All user-facing text, comments, documentation, issues, and pull requests should use English so the project can be maintained by an international community. Use clear labels and describe implemented behavior separately from planned functionality.

## Implementation conventions

- Use TypeScript and preserve strict type checking.
- Keep raw landmark measurements independent of cleaned and derived values.
- Use timestamps for motion processing; do not assume the analysis rate is the source video's frame rate.
- Preserve the target rig's proportions when retargeting motion.
- Preserve quaternion continuity, model bind transforms, and intermediate bones in the 3D path. Do not infer a global depth trajectory from pelvis-relative landmarks.
- Keep 2D and 3D sessions independent. In-place 3D motion removes horizontal travel while retaining vertical hips motion; this differs from the 2D root control.
- Make missing observations and incomplete analysis visible rather than presenting them as confident tracking.
- Keep generated demonstrations clearly labeled as synthetic. They do not prove real-video inference quality.
- Release workers, media decoders, transferred image bitmaps, and object URLs when their work ends.
- Keep heavy inference away from the interface thread.
- Resolve model and runtime URLs from Vite's base so static subpath deployments work.
- Add no media-upload or telemetry behavior without an explicit proposal, disclosure, and review.

Do not commit personal test assets, downloaded models, dependency caches, secrets, or generated builds. Original code and procedural artwork use the project license. Third-party dependencies, test fixtures, models, or artwork need their own documented licenses and attribution.

## Validate a pull request

Run:

```sh
npm test
npm run build
```

Add focused tests for changed motion math, sampling behavior, resource lifecycle, or data-format guarantees where they provide meaningful coverage. Documentation and simple copy changes do not need tests that repeat their content.

For changes affecting browser behavior, manually check the relevant parts of this workflow:

1. Import a short, permitted video and run analysis.
2. Cancel analysis, confirm partial coverage, then restart.
3. Compare raw and cleaned tracking and seek using the confidence timeline.
4. Choose a reference pose and verify source/character synchronization.
5. Test the default rig and the character import/editing modes affected by the change.
6. Confirm motion strength and in-place controls behave as labeled.
7. Download JSON and verify its source metadata, reference, timestamps, confidence, and completion state.
8. For 3D changes, check facing, automatic/manual mapping, bind-pose mode, anatomical/reference calibration, and deformation on a permitted skinned model. Test GLB/BVH timing and geometry in Blender where affected; use the [reproducible fixture checks](docs/3D_WORKFLOW.md#reproduce-the-blender-checks) as a baseline.
9. Confirm animation exports reject invalid tracking and long gaps. Including frames marked for review must remain an explicit choice; JSON should preserve uncertainty.
10. Check desktop and narrow layouts, keyboard focus, labels, and readable error messages.

State the commands and manual checks performed in the pull request. Distinguish generated-fixture tests from real-video browser tests and name the Blender version used for interoperability checks. Describe any remaining limitation, especially where browser codecs or model quality affect the result. Do not claim OpenToonz compatibility before the exported artifact has been opened and checked in OpenToonz.

## Review and communication

Be specific, respectful, and willing to discuss tradeoffs. Prefer reproducible examples and small changes over broad rewrites. Maintainer review and response times are best effort during the prototype stage.

By submitting a contribution, you agree that your original contribution may be distributed under the project's MIT License. Identify third-party material clearly; do not submit material you are not authorized to share.
