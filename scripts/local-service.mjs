import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activeRelease, setActiveRelease } from './release.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const id = createHash('sha256').update(root).digest('hex').slice(0, 10);
const label = `com.market-intelligence.workspace-${id}`;
const launchAgents = resolve(homedir(), 'Library', 'LaunchAgents');
const plist = resolve(launchAgents, `${label}.plist`);
const logs = resolve(root, 'data', 'logs');
const stdout = resolve(logs, 'preview.stdout.log');
const stderr = resolve(logs, 'preview.stderr.log');
const domain = process.getuid ? `gui/${process.getuid()}` : '';
const service = `${domain}/${label}`;

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const arg = (value) => `<string>${xml(value)}</string>`;

export function serviceConfiguration(workspace = root) {
  const release = activeRelease(workspace);
  return { workspace, entry: resolve(release?.root || workspace, 'backend/server.mjs'), release };
}

export function propertyList({ workspace, entry } = serviceConfiguration()) {
  const argumentsList = [process.execPath, entry];
  const workspaceLogs = resolve(workspace, 'data', 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>${arg(label)}
<key>ProgramArguments</key><array>${argumentsList.map(arg).join('')}</array>
<key>WorkingDirectory</key>${arg(workspace)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${arg(resolve(workspaceLogs, 'preview.stdout.log'))}
<key>StandardErrorPath</key>${arg(resolve(workspaceLogs, 'preview.stderr.log'))}
</dict>
</plist>
`;
}

function launchctl(...args) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
}

function required(...args) {
  const result = launchctl(...args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `launchctl ${args[0]} failed`);
}

async function bootstrap() {
  const backoff = [150, 300, 600, 1000];
  for (let attempt = 0; ; attempt++) {
    const result = launchctl('bootstrap', domain, plist);
    if (result.status === 0) return;
    const message = result.stderr.trim() || 'launchctl bootstrap failed';
    const teardownRace = /^Bootstrap failed: 5: Input\/output error\s*$/mi.test(message);
    if (!teardownRace || attempt === backoff.length) throw new Error(message);
    await delay(backoff[attempt]);
  }
}

function inspect() {
  const result = launchctl('print', service);
  const output = result.status === 0 ? result.stdout : '';
  const pid = /\bpid = (\d+)/.exec(output)?.[1];
  const state = /\bstate = (.+)/.exec(output)?.[1]?.trim();
  return { installed: existsSync(plist), loaded: result.status === 0, running: state === 'running',
    pid: pid ? Number(pid) : null, state: state || 'unloaded', plist, logs, workspace: root };
}

function setup(configuration) {
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  chmodSync(logs, 0o700);
  for (const file of [stdout, stderr]) {
    writeFileSync(file, '', { flag: 'a', mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const content = propertyList(configuration);
  if (existsSync(plist) && readFileSync(plist, 'utf8') === content) return false;
  const temporary = `${plist}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, plist);
  return true;
}

async function main(command = 'status', selector) {
  if (command === 'help' || command === '--help') {
    console.log('Usage: npm run service -- start|stop|restart|status|activate <release-id|workspace>');
  } else {
    if (process.platform !== 'darwin') throw new Error('The launchd local service is available on macOS');
    if (!['start', 'stop', 'restart', 'status', 'activate'].includes(command)) throw new Error('Choose start, stop, restart, status, or activate');
    if (command === 'activate') {
      if (!selector) throw new Error('Choose a validated release ID or workspace');
      setActiveRelease(root, selector);
    }
    if (['start', 'restart', 'activate'].includes(command)) {
      const configuration = serviceConfiguration();
      const changed = setup(configuration);
      const current = inspect();
      const reload = changed || command !== 'start';
      if (current.loaded && reload) required('bootout', service);
      if (!current.loaded || reload) {
        required('enable', service);
        await bootstrap();
      }
    } else if (command === 'stop' && inspect().loaded) {
      required('bootout', service);
      required('disable', service);
    }
    const status = inspect();
    const configuration = command === 'stop' ? null : serviceConfiguration();
    console.log(JSON.stringify({ ...status, ...(configuration && { entry: configuration.entry, release: configuration.release }) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
