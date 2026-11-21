import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildInformation } from '../backend/server.mjs';
import { propertyList, serviceConfiguration } from '../scripts/local-service.mjs';
import { buildRelease, releaseFingerprint, setActiveRelease, validateRelease } from '../scripts/release.mjs';

function testRelease(t) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'market-release-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'data', 'releases', 'fixture-r1');
  const entries = { 'backend/server.mjs': '// fixture', 'frontend/index.html': '<title>Market</title>',
    'package.json': JSON.stringify({ version: '0.2.0' }) };
  const files = Object.entries(entries).map(([path, contents]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
    return { path, sha256: createHash('sha256').update(contents).digest('hex') };
  });
  const manifest = { releaseId: 'fixture-r1', files, calculationVersion: '2-test', fingerprint: releaseFingerprint(files),
    builtAt: '2026-11-21T20:00:00Z' };
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest));
  return { workspace, root, manifest, pointer: join(workspace, 'data', 'active-release.json') };
}

test('managed configuration selects verified artifact code and keeps workspace working directory', (t) => {
  const { workspace, root, manifest, pointer } = testRelease(t);
  assert.equal(serviceConfiguration(workspace).entry, join(workspace, 'backend/server.mjs'));
  const release = setActiveRelease(workspace, 'fixture-r1');
  const cfg = serviceConfiguration(workspace);
  assert.equal(cfg.release.buildHash, manifest.fingerprint);
  assert.equal(release.root, root);
  const plist = propertyList(cfg);
  assert.ok(plist.includes(`<string>${join(root, 'backend/server.mjs')}</string>`));
  assert.ok(plist.includes(`<key>WorkingDirectory</key><string>${workspace}</string>`));
  assert.ok(plist.includes(`<string>${join(workspace, 'data/logs/preview.stdout.log')}</string>`));
  assert.ok(!plist.includes('--watch'));
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  const persisted = readFileSync(pointer, 'utf8');
  assert.throws(() => setActiveRelease(workspace, '../fixture-r1'));
  assert.equal(readFileSync(pointer, 'utf8'), persisted);
  setActiveRelease(workspace, 'workspace');
  assert.equal(serviceConfiguration(workspace).entry, join(workspace, 'backend/server.mjs'));
});

test('pointer and release validation reject unsigned content, conflicting fingerprints and links', (t) => {
  const { workspace, root, manifest, pointer } = testRelease(t);
  assert.throws(() => validateRelease(workspace, '/tmp/fixture-r1'), /direct child/);
  setActiveRelease(workspace, 'fixture-r1');
  writeFileSync(pointer, JSON.stringify({ root, fingerprint: 'a'.repeat(64) }));
  assert.throws(() => serviceConfiguration(workspace), /pointer fingerprint/);
  writeFileSync(pointer, JSON.stringify({ root, fingerprint: manifest.fingerprint }));
  const server = join(root, 'backend/server.mjs');
  writeFileSync(server, '// modified');
  assert.throws(() => serviceConfiguration(workspace), /checksum/);
  rmSync(server);
  symlinkSync(join(root, 'package.json'), server);
  assert.throws(() => serviceConfiguration(workspace), /linked/);
});

test('release build inventories approved runtime directories and excludes workspace data', async (t) => {
  const { workspace } = testRelease(t);
  const source = {
    'package.json': '{"type":"module","version":"0.2.0"}',
    'backend/server.mjs': 'export {};',
    'backend/database.mjs': 'export const CALCULATION_VERSION = "2-test";',
    'frontend/index.html': '<title>Market</title>',
    'frontend/subdir/app.js': 'export {};',
    'scripts/check.mjs': 'export {};',
    'docs/readme.md': 'Release notes',
  };
  for (const [path, contents] of Object.entries({ ...source, '.env': 'FIXTURE_ONLY=1', 'data/runtime.sqlite': 'fixture' })) {
    const filename = join(workspace, path);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  const release = await buildRelease(workspace, 'fixture-r2');
  const manifest = JSON.parse(readFileSync(join(release.root, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(({ path }) => path), Object.keys(source).sort());
  assert.equal(validateRelease(workspace, release.releaseId).buildHash, manifest.fingerprint);
  writeFileSync(join(release.root, 'backend/unsigned.mjs'), 'export {};');
  assert.throws(() => validateRelease(workspace, release.releaseId), /does not cover all runtime files/);
});

test('workspace build metadata identifies app and analytics without publishing local paths', async () => {
  const metadata = await buildInformation();
  assert.equal(metadata.appVersion, '0.2.0');
  assert.equal(metadata.deployment, 'workspace');
  assert.equal(metadata.releaseId, null);
  assert.match(metadata.buildHash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.version, `${metadata.calculationVersion}.${metadata.buildHash}`);
  assert.deepEqual(await buildInformation(), metadata);
  assert.ok(!('root' in metadata));
});
