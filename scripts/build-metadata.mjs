import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = resolve(new URL('..', import.meta.url).pathname);
function digest(directory) {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== 'build-info.json') hash.update(relative(directory,path)).update(readFileSync(path));
    }
  }
  walk(directory); return hash.digest('hex');
}
let commit = null, dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio:['ignore','pipe','ignore'] }).trim();
  dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd:root, encoding:'utf8', stdio:['ignore','pipe','ignore'] }).trim();
} catch { /* Published package may not include git. */ }
const metadata = { version: JSON.parse(readFileSync(resolve(root,'package.json'))).version, commit, dirty,
  builtAt: new Date().toISOString(), sourceDigest: digest(resolve(root,'src')), distDigest: digest(resolve(root,'dist')) };
metadata.buildId = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
writeFileSync(resolve(root,'dist/build-info.json'), JSON.stringify(metadata));
