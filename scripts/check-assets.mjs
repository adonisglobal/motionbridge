import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Must match the model version pinned by setup-assets.mjs.
const MODEL_SHA256 = 'e2dab61191e2dcd0a15f943d8e3ed1dce13c82dfa597b9dd39f562975a50c3f8';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = [
  'public/models/holistic_landmarker.task',
  'public/mediapipe/wasm/vision_wasm_module_internal.js',
  'public/mediapipe/wasm/vision_wasm_module_internal.wasm',
];
for (const file of required) {
  const valid = await stat(join(root, file)).then(s => s.isFile() && s.size > 0).catch(() => false);
  if (!valid) {
    console.error(`Missing local analysis asset: ${file}\nRun: npm run setup:assets`);
    process.exit(1);
  }
}

const hash = createHash('sha256');
for await (const chunk of createReadStream(join(root, required[0]))) hash.update(chunk);
if (hash.digest('hex') !== MODEL_SHA256) {
  console.error('The local Holistic model failed its SHA-256 check.\nRun: npm run setup:assets');
  process.exit(1);
}
