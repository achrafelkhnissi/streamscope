import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.stop_hook_active) {
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR;
const stateFile = path.join(projectDir, '.claude', 'state', 'last-passing-check');

function workingTreeFingerprint() {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: projectDir,
      encoding: 'utf8',
    },
  );
  const hash = createHash('sha256');
  for (const file of listed.stdout.split('\0').filter(Boolean).sort()) {
    const absolute = path.join(projectDir, file);
    if (existsSync(absolute)) {
      const { size, mtimeMs } = statSync(absolute);
      hash.update(`${file}\0${String(size)}\0${String(mtimeMs)}\n`);
    }
  }
  return hash.digest('hex');
}

const fingerprint = workingTreeFingerprint();
if (existsSync(stateFile) && readFileSync(stateFile, 'utf8') === fingerprint) {
  process.exit(0);
}

const check = spawnSync('npm', ['run', '--silent', 'check'], { cwd: projectDir, encoding: 'utf8' });
if (check.status === 0) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, fingerprint);
  process.exit(0);
}

const output = `${check.stdout}\n${check.stderr}`.trim();
process.stderr.write(
  `npm run check failed (typecheck, lint, format, unit tests). Fix it before finishing:\n${output.slice(-4000)}`,
);
process.exit(2);
