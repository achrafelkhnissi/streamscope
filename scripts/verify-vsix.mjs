import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listFiles, PackageManager } from '@vscode/vsce';
import { verifyInCleanProfile } from './clean-profile.mjs';
import { maxVsixBytes, vsixBudgetProblem } from './vsix-budget.mjs';
import { vsixContentsProblem } from './vsix-contents.mjs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);

const vsixBytes = statSync(vsix).size;
console.log(`VSIX is ${String(vsixBytes)} bytes (limit ${String(maxVsixBytes)})`);
const budgetProblem = vsixBudgetProblem(vsixBytes);
if (budgetProblem !== undefined) {
  throw new Error(budgetProblem);
}
const contentsProblem = vsixContentsProblem(
  await listFiles({ cwd: root, packageManager: PackageManager.None }),
);
if (contentsProblem !== undefined) {
  throw new Error(contentsProblem);
}

await verifyInCleanProfile({ root, install: [vsix], extensionId, version: manifest.version });
