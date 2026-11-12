import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ProcessRole = 'main' | 'renderer' | 'gpu' | 'utility' | 'other';

export interface ProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  cpuSeconds: number;
  command: string;
}

export interface ProcessSample {
  at: number;
  rows: readonly ProcessRow[];
}

export interface RoleSummary {
  meanCpuPercent: number;
  maxCpuPercent: number;
  maxRssBytes: number;
}

export type ProcessSummary = Record<ProcessRole, RoleSummary>;

const roles: readonly ProcessRole[] = ['main', 'renderer', 'gpu', 'utility', 'other'];
const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;
const run = promisify(execFile);

export function parseCpuTime(text: string): number {
  const [first = '', second] = text.split('-');
  const days = second === undefined ? 0 : Number(first);
  const clock = second ?? first;
  const seconds = clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return days * 86_400 + seconds;
}

export function parseProcessTable(text: string): ProcessRow[] {
  return text.split('\n').flatMap((line) => {
    const match = rowPattern.exec(line);
    if (match === null) {
      return [];
    }
    const [, pid = '', ppid = '', rss = '', time = '', command = ''] = match;
    const cpuSeconds = parseCpuTime(time);
    if (!Number.isFinite(cpuSeconds)) {
      return [];
    }
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rss) * 1024,
        cpuSeconds,
        command,
      },
    ];
  });
}

export function processRole(row: ProcessRow, rootPid: number): ProcessRole {
  if (row.pid === rootPid) {
    return 'main';
  }
  if (row.command.includes('--type=renderer')) {
    return 'renderer';
  }
  if (row.command.includes('--type=gpu-process')) {
    return 'gpu';
  }
  if (row.command.includes('--type=utility')) {
    return 'utility';
  }
  return 'other';
}

export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const included = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!included.has(row.pid) && included.has(row.ppid)) {
        included.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => included.has(row.pid));
}

function emptySummary(): ProcessSummary {
  return Object.fromEntries(
    roles.map((role) => [role, { meanCpuPercent: 0, maxCpuPercent: 0, maxRssBytes: 0 }]),
  ) as ProcessSummary;
}

export function summariseProcessSamples(
  samples: readonly ProcessSample[],
  rootPid: number,
): ProcessSummary {
  const summary = emptySummary();
  const cpuTotals = new Map<ProcessRole, number>();
  for (const sample of samples) {
    const rss = new Map<ProcessRole, number>();
    for (const row of sample.rows) {
      const role = processRole(row, rootPid);
      rss.set(role, (rss.get(role) ?? 0) + row.rssBytes);
    }
    for (const [role, bytes] of rss) {
      summary[role].maxRssBytes = Math.max(summary[role].maxRssBytes, bytes);
    }
  }
  for (const [position, sample] of samples.entries()) {
    const previous = samples[position - 1];
    if (previous === undefined || sample.at <= previous.at) {
      continue;
    }
    const seconds = (sample.at - previous.at) / 1000;
    const before = new Map(previous.rows.map((row) => [row.pid, row.cpuSeconds]));
    const interval = new Map<ProcessRole, number>();
    for (const row of sample.rows) {
      const earlier = before.get(row.pid);
      if (earlier !== undefined) {
        const role = processRole(row, rootPid);
        interval.set(role, (interval.get(role) ?? 0) + Math.max(0, row.cpuSeconds - earlier));
      }
    }
    for (const [role, cpu] of interval) {
      summary[role].maxCpuPercent = Math.max(summary[role].maxCpuPercent, (cpu / seconds) * 100);
      cpuTotals.set(role, (cpuTotals.get(role) ?? 0) + cpu);
    }
  }
  const first = samples[0];
  const last = samples.at(-1);
  if (first !== undefined && last !== undefined && last.at > first.at) {
    const seconds = (last.at - first.at) / 1000;
    for (const [role, cpu] of cpuTotals) {
      summary[role].meanCpuPercent = (cpu / seconds) * 100;
    }
  }
  return summary;
}

export async function sampleProcesses(rootPid: number, now: () => number): Promise<ProcessSample> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return { at: now(), rows: descendantsOf(parseProcessTable(stdout), rootPid) };
}
