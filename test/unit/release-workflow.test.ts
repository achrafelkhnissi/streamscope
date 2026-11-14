import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);

function jobs(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  let name: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header !== null) {
      if (name !== undefined) {
        blocks.set(name, body.join('\n'));
      }
      name = header[1];
      body = [];
    } else if (name !== undefined) {
      body.push(line);
    }
  }
  if (name !== undefined) {
    blocks.set(name, body.join('\n'));
  }
  return blocks;
}

function job(name: string): string {
  const block = jobs(workflow).get(name);
  if (block === undefined) {
    throw new Error(`release.yml has no ${name} job`);
  }
  return block;
}

const publishJobs = ['publish-marketplace', 'publish-open-vsx'];

describe('release workflow', () => {
  it('has the check, package, publish and GitHub release jobs', () => {
    expect([...jobs(workflow).keys()]).toEqual([
      'check',
      'package',
      'publish-marketplace',
      'publish-open-vsx',
      'github-release',
    ]);
  });

  it('runs on version tags and on a manual dispatch', () => {
    expect(workflow).toMatch(
      /^on:\n {2}push:\n {4}tags:\n {6}- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n/m,
    );
    expect(workflow).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:\n/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it('publishes only from the release environment with id-token write', () => {
    for (const name of publishJobs) {
      const block = job(name);
      expect(block, name).toMatch(/^ {4}needs: package$/m);
      expect(block, name).toMatch(/^ {4}environment: release$/m);
      expect(block, name).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m);
    }
    expect(job('publish-marketplace')).toContain(
      'npm exec --no -- vsce publish --oidc --packagePath "streamscope-${VERSION}.vsix" ${PRE_RELEASE:+"$PRE_RELEASE"}',
    );
    expect(job('publish-open-vsx')).toContain(
      'npm exec --no -- ovsx publish --trusted-publishing --packagePath "streamscope-${VERSION}.vsix"',
    );
    for (const name of ['check', 'package', 'github-release']) {
      expect(job(name), name).not.toContain('id-token');
      expect(job(name), name).not.toContain('environment:');
    }
  });

  it('never lets npx fetch a tool from the registry', () => {
    expect(workflow).not.toMatch(/\bnpx\b/);
  });

  it('releases only a commit that is on main', () => {
    const block = job('package');
    expect(block).toMatch(/^ {10}fetch-depth: 0$/m);
    expect(block).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it('pins every action to a commit SHA', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
    }
  });

  it('stores no publishing token', () => {
    const secrets = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(secrets.every((name) => name === 'GITHUB_TOKEN')).toBe(true);
    expect(workflow).not.toMatch(/VSCE_PAT|OVSX_PAT|--pat\b|-p \$/);
  });

  it('keeps Open VSX publishing off until OPEN_VSX_TRUSTED is true', () => {
    expect(job('publish-open-vsx')).toMatch(/^ {4}if: vars\.OPEN_VSX_TRUSTED == 'true'$/m);
    expect(job('publish-marketplace')).not.toContain('OPEN_VSX_TRUSTED');
  });

  it('packages once and reuses the VSIX', () => {
    expect(job('package')).toContain('npm run package -- ${PRE_RELEASE:+"$PRE_RELEASE"}');
    expect(job('package')).toContain('node scripts/verify-vsix.mjs');
    for (const name of [...publishJobs, 'github-release']) {
      const block = job(name);
      expect(block, name).toContain('actions/download-artifact@');
      expect(block, name).not.toMatch(/vsce package|npm run package|verify:vsix/);
    }
  });

  it('creates the GitHub release only after the Marketplace publish succeeds', () => {
    const block = job('github-release');
    expect(block).toMatch(/^ {4}needs: \[package, publish-marketplace, publish-open-vsx\]$/m);
    expect(block).toContain("needs.publish-marketplace.result == 'success'");
    expect(block).toMatch(/^ {4}permissions:\n {6}contents: write$/m);
  });
});
