import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const formattable = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
]);

const input = JSON.parse(readFileSync(0, 'utf8'));
const projectDir = process.env.CLAUDE_PROJECT_DIR;
const filePath = input.tool_input?.file_path;

if (
  typeof filePath === 'string' &&
  filePath.startsWith(projectDir + path.sep) &&
  formattable.has(path.extname(filePath)) &&
  existsSync(filePath)
) {
  const prettier = path.join(projectDir, 'node_modules', '.bin', 'prettier');
  const result = spawnSync(prettier, ['--write', '--log-level', 'warn', filePath], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const reason = result.error ? `${result.error.message} (run npm ci)` : result.stderr;
    process.stderr.write(
      `Prettier could not format ${path.relative(projectDir, filePath)}:\n${reason}`,
    );
    process.exit(2);
  }
}
