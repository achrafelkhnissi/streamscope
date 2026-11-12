import { describe, expect, it } from 'vitest';
import {
  descendantsOf,
  parseCpuTime,
  parseProcessTable,
  processRole,
  summariseProcessSamples,
  type ProcessRow,
} from '../../benchmark/view/processes';

const megabyte = 1024 * 1024;

function row(
  pid: number,
  ppid: number,
  cpuSeconds: number,
  rssBytes = 0,
  command = '',
): ProcessRow {
  return { pid, ppid, rssBytes, cpuSeconds, command };
}

describe('parseCpuTime', () => {
  it.each([
    ['0:01.23', 1.23],
    ['12:34.56', 754.56],
    ['125:00.00', 7500],
    ['01:02:03', 3723],
    ['2-01:02:03', 176523],
    ['1:02:03.50', 3723.5],
  ])('reads %s as %d seconds', (text, seconds) => {
    expect(parseCpuTime(text)).toBeCloseTo(seconds, 6);
  });
});

describe('parseProcessTable', () => {
  it('reads rows whose commands contain spaces and skips other lines', () => {
    const text = [
      '  101     1  204800   0:12.50 /Apps/Code.app/Contents/MacOS/Electron --user-data-dir=/tmp/x',
      '  102   101   51200   0:03.00 /Apps/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer) --type=renderer',
      '',
      'garbage line',
    ].join('\n');

    const rows = parseProcessTable(text);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      pid: 102,
      ppid: 101,
      rssBytes: 51200 * 1024,
      cpuSeconds: 3,
      command:
        '/Apps/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer) --type=renderer',
    });
  });
});

describe('processRole', () => {
  it.each([
    [row(101, 1, 0, 0, '/Apps/Electron'), 'main'],
    [row(102, 101, 0, 0, 'helper --type=renderer --lang=en'), 'renderer'],
    [row(103, 101, 0, 0, 'helper --type=gpu-process'), 'gpu'],
    [
      row(104, 101, 0, 0, 'helper --type=utility --utility-sub-type=node.mojom.NodeService'),
      'utility',
    ],
    [row(105, 101, 0, 0, 'helper --type=zygote'), 'other'],
  ])('classifies %j', (process, role) => {
    expect(processRole(process, 101)).toBe(role);
  });
});

describe('descendantsOf', () => {
  it('keeps the root and every process below it', () => {
    const rows = [row(1, 0, 0), row(101, 1, 0), row(102, 101, 0), row(103, 102, 0), row(200, 1, 0)];

    expect(descendantsOf(rows, 101).map((process) => process.pid)).toEqual([101, 102, 103]);
  });
});

describe('summariseProcessSamples', () => {
  it('counts processes from their first appearance and sums each role', () => {
    const renderer = 'helper --type=renderer';
    const samples = [
      { at: 0, rows: [row(101, 1, 10), row(102, 101, 1.0, 100 * megabyte, renderer)] },
      {
        at: 2000,
        rows: [
          row(101, 1, 10.5),
          row(102, 101, 2.0, 100 * megabyte, renderer),
          row(104, 101, 5, 50 * megabyte, renderer),
        ],
      },
      { at: 4000, rows: [row(101, 1, 11), row(102, 101, 4.0, 120 * megabyte, renderer)] },
    ];

    const summary = summariseProcessSamples(samples, 101);

    expect(summary.renderer.meanCpuPercent).toBeCloseTo(75, 6);
    expect(summary.renderer.maxCpuPercent).toBeCloseTo(100, 6);
    expect(summary.renderer.maxRssBytes).toBe(150 * megabyte);
    expect(summary.main.meanCpuPercent).toBeCloseTo(25, 6);
    expect(summary.main.maxCpuPercent).toBeCloseTo(25, 6);
    expect(summary.gpu).toEqual({ meanCpuPercent: 0, maxCpuPercent: 0, maxRssBytes: 0 });
  });
});
