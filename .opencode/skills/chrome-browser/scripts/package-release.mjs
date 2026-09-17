import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = fileURLToPath(new URL('../', import.meta.url));
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: skill, encoding: 'utf8' }).trim();
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const args = process.argv.slice(2);
let ref = 'HEAD';
let output;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--ref') ref = args[++index];
  else if (args[index] === '--output') output = args[++index];
  else throw new Error('Usage: package-release.mjs [--ref <commit-or-tag>] --output <archive.zip>');
}
assert.ok(output?.endsWith('.zip'), '--output must be a .zip path');
assert.match(ref || '', /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/, 'Invalid Git ref');
const tree = git(['rev-parse', '--verify', `${ref}^{tree}`]);
const prefix = '.opencode/skills/chrome-browser/';
const atRef = path => git(['show', `${tree}:${path}`]);
const pkg = JSON.parse(atRef(`${prefix}package.json`));
const manifest = JSON.parse(atRef(`${prefix}extension/manifest.json`));
const lock = JSON.parse(atRef(`${prefix}package-lock.json`));
assert.equal(manifest.version, pkg.version);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[''].version, pkg.version);
assert.ok(atRef(`${prefix}extension/version.js`).includes(`export const VERSION = '${pkg.version}';`));

const paths = git(['ls-tree', '-r', '--name-only', tree]).split('\n');
const forbidden = /(^|\/)(node_modules|\.slim|\.env(?:\.[^/]*)?|server\.json|pairing\.json)(\/|$)|\.(log|pem|key|png|zip)$/i;
for (const path of paths) assert.ok(!forbidden.test(path), `Release contains a runtime/development artifact: ${path}`);
for (const path of ['README.md', 'LICENSE', 'CHANGELOG.md', 'opencode.json', `${prefix}SKILL.md`, `${prefix}scripts/browser.mjs`, `${prefix}extension/manifest.json`]) assert.ok(paths.includes(path), `Release is missing ${path}`);

const archive = resolve(output);
assert.ok(!existsSync(archive) && !existsSync(`${archive}.sha256`), 'Release output already exists; choose a fresh path');
mkdirSync(dirname(archive), { recursive: true });
execFileSync('git', ['archive', '--format=zip', '--prefix=chrome-browser-skill-package/', `--output=${archive}`, tree], { cwd: repository, stdio: 'inherit' });
const bytes = readFileSync(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
console.log(JSON.stringify({ version: pkg.version, tree, archive, bytes: bytes.length, sha256 }, null, 2));
