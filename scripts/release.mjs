import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestName = 'release-manifest.json';
const releaseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const sourceFolders = ['backend', 'frontend', 'scripts', 'docs'];
const sourceFiles = ['package.json', 'package-lock.json', 'README.md'];
const mandatory = ['package.json', 'backend/server.mjs', 'frontend/index.html'];
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

function jsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function permittedSource(path) {
  const parts = path.split('/');
  return parts.every((part) => /^[\w-][\w.-]*$/.test(part)) && (parts.length === 1
    ? sourceFiles.includes(path) : sourceFolders.includes(parts[0]));
}

function filesIn(root, relative) {
  const filename = resolve(root, relative);
  const permitted = permittedSource(relative);
  if (!permitted && !sourceFolders.includes(relative)) return [];
  const info = lstatSync(filename);
  if (info.isSymbolicLink()) throw new Error(`Release source contains a symbolic link at ${relative}`);
  if (info.isFile()) return permitted ? [relative] : [];
  if (!info.isDirectory()) throw new Error(`Release source is not a regular file or directory at ${relative}`);
  return readdirSync(filename).flatMap((name) => filesIn(root, `${relative}/${name}`));
}

function sources(root) {
  return [...sourceFiles, ...sourceFolders].filter((path) => existsSync(resolve(root, path)))
    .flatMap((path) => filesIn(root, path)).sort();
}

export function releaseFingerprint(files) {
  return fingerprint(JSON.stringify(files));
}

function identify(manifest, root) {
  const appVersion = jsonFile(resolve(root, 'package.json')).version;
  if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(appVersion)) throw new Error('Release package version is invalid');
  return { root, releaseId: manifest.releaseId || basename(root), appVersion, buildHash: manifest.fingerprint,
    calculationVersion: manifest.calculationVersion, builtAt: manifest.builtAt || manifest.at || null, deployment: 'release' };
}

function manifestAt(root) {
  const file = resolve(root, manifestName);
  if (!lstatSync(file).isFile()) throw new Error('Release manifest must be a regular file');
  const manifest = jsonFile(file);
  const valid = manifest && shaPattern.test(manifest.fingerprint ?? '') &&
    (manifest.releaseId == null || (releaseIdPattern.test(manifest.releaseId) && manifest.releaseId === basename(root))) &&
    Array.isArray(manifest.files) && /^[a-zA-Z0-9.-]{1,80}$/.test(manifest.calculationVersion ?? '');
  if (!valid) throw new Error('Release manifest is invalid');
  return manifest;
}

export function validateRelease(workspace, release) {
  const home = realpathSync(workspace);
  const base = resolve(home, 'data', 'releases');
  const id = isAbsolute(release) ? basename(release) : release;
  if (!releaseIdPattern.test(id ?? '')) throw new Error('Release IDs must use letters, numbers, periods, dashes, or underscores');
  const root = resolve(base, id);
  if (isAbsolute(release) && release !== root) throw new Error('Active release must be a direct child of the workspace releases directory');
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Release directory cannot use symbolic links');
  const manifest = manifestAt(root);
  const paths = new Set();
  for (const file of manifest.files) {
    const path = file?.path;
    if (typeof path !== 'string' || paths.has(path) || !permittedSource(path) || !shaPattern.test(file.sha256 ?? '')) {
      throw new Error('Release manifest has an invalid file entry');
    }
    const checked = resolve(root, path);
    if (!checked.startsWith(root + sep) || realpathSync(checked) !== checked || !lstatSync(checked).isFile()) {
      throw new Error(`Release file is missing or linked at ${path}`);
    }
    if (fingerprint(readFileSync(checked)) !== file.sha256) throw new Error(`Release checksum mismatch for ${path}`);
    paths.add(path);
  }
  if (mandatory.some((name) => !paths.has(name)) || sources(root).some((name) => !paths.has(name))) {
    throw new Error('Release manifest does not cover all runtime files');
  }
  if (releaseFingerprint(manifest.files) !== manifest.fingerprint) throw new Error('Release manifest fingerprint mismatch');
  return identify(manifest, root);
}

export function activeRelease(workspace) {
  const path = resolve(workspace, 'data', 'active-release.json');
  let pointer;
  try {
    if (!lstatSync(path).isFile()) throw new Error('Active release pointer must be a regular file');
    pointer = jsonFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (pointer?.deployment === 'workspace' && pointer.root == null && pointer.fingerprint == null) return null;
  if (typeof pointer?.root !== 'string' || !isAbsolute(pointer.root) || !shaPattern.test(pointer?.fingerprint ?? '')) {
    throw new Error('Active release pointer is invalid');
  }
  const release = validateRelease(workspace, pointer.root);
  if (release.buildHash !== pointer.fingerprint) throw new Error('Active release pointer fingerprint mismatch');
  return release;
}

export function setActiveRelease(workspace, selector) {
  const selected = selector === 'workspace' ? null : validateRelease(workspace, selector);
  const directory = resolve(workspace, 'data');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'active-release.json');
  const temporary = mkdtempSync(resolve(directory, '.active-release-'));
  try {
    const file = resolve(temporary, 'pointer.json');
    const pointer = selected ? { root: selected.root, version: selected.releaseId, fingerprint: selected.buildHash,
      activatedAt: new Date().toISOString() } : { deployment: 'workspace', activatedAt: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(pointer, null, 2) + '\n', { mode: 0o600 });
    renameSync(file, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return selected;
}

export function runningRelease(root) {
  if (!existsSync(resolve(root, manifestName))) return null;
  return identify(manifestAt(root), root);
}

function checkRelease(root, executable) {
  const env = { ...process.env };
  // An inherited Node test context makes a nested test process skip its files.
  delete env.NODE_TEST_CONTEXT;
  for (const args of [[resolve(root, 'scripts/check.mjs')], ['--test', 'tests']]) {
    const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Release validation failed');
  }
}

export async function buildRelease(workspace, id) {
  if (!releaseIdPattern.test(id ?? '') || id === 'workspace') throw new Error('Choose a valid release ID');
  const source = realpathSync(workspace);
  const base = resolve(source, 'data', 'releases');
  const root = resolve(base, id);
  if (existsSync(root)) throw new Error('That release already exists. Choose a new ID');
  const paths = sources(source);
  if (mandatory.some((path) => !paths.includes(path))) throw new Error('Workspace runtime files are missing');
  const before = paths.map((path) => ({ path, sha256: fingerprint(readFileSync(resolve(source, path))) }));
  checkRelease(source, process.execPath);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(base, '.building-'));
  try {
    const current = sources(source);
    if (JSON.stringify(current) !== JSON.stringify(paths)) throw new Error('Workspace source files changed during release validation');
    for (const file of before) {
      const target = resolve(stage, file.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(source, file.path), target);
      if (fingerprint(readFileSync(target)) !== file.sha256) throw new Error(`Workspace file changed during validation at ${file.path}`);
      chmodSync(target, 0o444);
    }
    const { CALCULATION_VERSION } = await import(pathToFileURL(resolve(stage, 'backend/database.mjs')));
    writeFileSync(resolve(stage, manifestName), JSON.stringify({ releaseId: id, builtAt: new Date().toISOString(),
      calculationVersion: CALCULATION_VERSION, fingerprint: releaseFingerprint(before),
      validation: { checks: 'passed', tests: 'passed' }, files: before }, null, 2) + '\n', { mode: 0o444 });
    renameSync(stage, root);
    return validateRelease(workspace, id);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, id] = process.argv.slice(2);
    if (!command || ['help', '--help'].includes(command)) console.log('Usage: npm run release -- build|verify <release-id>');
    else if (command === 'build') console.log(JSON.stringify(await buildRelease(workspaceRoot, id), null, 2));
    else if (command === 'verify') console.log(JSON.stringify(validateRelease(workspaceRoot, id), null, 2));
    else throw new Error('Choose build or verify');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
