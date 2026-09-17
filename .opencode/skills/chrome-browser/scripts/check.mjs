import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERSION } from '../extension/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const pkg = json('package.json');
const lock = json('package-lock.json');
const manifest = json('extension/manifest.json');
assert.match(VERSION, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, VERSION, 'package version differs from extension/version.js');
assert.equal(lock.version, VERSION, 'lockfile version differs');
assert.equal(lock.packages[''].version, VERSION, 'lockfile root package version differs');
assert.equal(manifest.version, VERSION, 'Chrome manifest version differs');
assert.equal(pkg.engines.node, '>=22');
assert.deepEqual(lock.packages[''].engines, pkg.engines);
assert.equal(manifest.minimum_chrome_version, '125');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22+ is required');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

const files = ['extension', 'src', 'scripts', 'test'].flatMap(directory => sourceFiles(resolve(root, directory)));
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path}\n${result.stderr}`);
}
console.log(`v${VERSION}: package/lockfile/manifest versions agree; ${files.length} JavaScript files passed syntax checks.`);
