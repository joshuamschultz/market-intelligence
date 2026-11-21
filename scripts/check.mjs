import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const roots = ['backend', 'frontend', 'scripts', 'tests'];
function checkFolder(folder) {
  for (const item of readdirSync(folder, { withFileTypes: true })) {
    const filename = join(folder, item.name);
    if (item.isDirectory()) checkFolder(filename);
    if (item.isFile() && /\.(?:mjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status || 1;
    }
  }
}
for (const root of roots) checkFolder(root);
