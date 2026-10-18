import { mkdir, copyFile, readdir, stat, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Pin the bytes as well as the versioned upstream URL. Do not accept a
// truncated or unexpectedly changed model merely because it is large enough.
const MODEL_SHA256 = 'e2dab61191e2dcd0a15f943d8e3ed1dce13c82dfa597b9dd39f562975a50c3f8';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const wasmSource = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmTarget = resolve(root, 'public/mediapipe/wasm');
const models = resolve(root, 'public/models');
await mkdir(wasmTarget, { recursive: true });
await mkdir(models, { recursive: true });
for (const name of await readdir(wasmSource)) {
  if (/\.(js|wasm)$/.test(name)) await copyFile(join(wasmSource, name), join(wasmTarget, name));
}
console.log('Copied the installed MediaPipe WASM runtime to public/mediapipe/wasm.');

const target = join(models, 'holistic_landmarker.task');
const exists = await stat(target).then(s => s.isFile()).catch(() => false);
const validCache = exists && await sha256(target) === MODEL_SHA256;
if (!validCache) {
  const url = 'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task';
  console.log(exists
    ? 'The cached Holistic model failed its SHA-256 check. Downloading a verified replacement…'
    : 'Downloading the official Holistic model (first setup only)…');
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
  const temp = `${target}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    if (await sha256(temp) !== MODEL_SHA256) {
      throw new Error('The downloaded Holistic model failed its SHA-256 check. The cached file was not replaced.');
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
console.log('Holistic model ready. Video processing stays on this device.');
