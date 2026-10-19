import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = process.env.BLENDER_PATH ? [process.env.BLENDER_PATH] : ['blender'];
if (!process.env.BLENDER_PATH && process.platform === 'win32') {
  const directory = join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
  const names = await readdir(directory).catch(() => []);
  names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  candidates.push(...names.map(name => join(directory, name, 'blender.exe')));
}
let executable;
for (const candidate of candidates) {
  const result = spawnSync(candidate, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status === 0) { executable = candidate; console.log(result.stdout.split(/\r?\n/)[0]); break; }
}
if (!executable) throw new Error('Blender was not found. Install Blender and set BLENDER_PATH to its executable, or add blender to PATH.');

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Verification failed with exit code ${code}.`)));
  });
}
const blenderArgs = script => ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', '.local/blender-qa'];
await run(process.execPath, ['scripts/verify-blender-fixture.mjs']);
await run(executable, blenderArgs('scripts/verify-blender-import.py'));
await run(process.execPath, ['scripts/verify-blender-model-fixture.mjs']);
await run(executable, blenderArgs('scripts/verify-blender-model.py'));
await run(process.execPath, ['scripts/verify-blender-fbx.mjs']);
console.log('Blender BVH, animated GLB, and FBX roundtrips passed. Reports: .local/blender-qa/');
