import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import semver from 'semver';
import { buildClientSource } from './build-client.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(file);
  }
  return files;
}

const files = [resolve(root, 'index.js'), resolve(root, 'remote.js'), resolve(root, 'client.js')];
for (const dir of ['lib', 'src', 'scripts', 'test']) {
  files.push(...(await filesIn(resolve(root, dir))));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${file}\n${result.stderr || result.error || 'Syntax check failed'}`);
  }
}

assert.equal(
  await readFile(resolve(root, 'client.js'), 'utf8'),
  await buildClientSource(),
  'Generated client.js is stale; run npm run build',
);

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const baseline = manifest.devDependencies['@deepseek-ai/dsh-session'];
assert.equal(semver.valid(baseline), baseline, 'The DSH test baseline must be an exact version');
for (const [name, version] of Object.entries(manifest.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, baseline, `${name} must use the test baseline`);
}
// Match DSH app-boot's prerelease policy; these are admission checks, not claims
// that the runtime tests have run against hypothetical future releases.
const admittedVersions = [baseline, ...['patch', 'minor', 'major'].flatMap(type => {
  const version = semver.inc(baseline.split('-')[0], type);
  return [version, version + '-rc.1'];
})];
const ranges = [
  ['engines.dsh', manifest.engines.dsh],
  ...Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')),
];
for (const [name, range] of ranges) {
  for (const version of admittedVersions) {
    assert.ok(semver.satisfies(version, range, { includePrerelease: true }), `${name} excludes ${version}`);
  }
}
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');

console.log(`Checked ${files.length} JavaScript files, client bundle, locale keys, and package metadata.`);
