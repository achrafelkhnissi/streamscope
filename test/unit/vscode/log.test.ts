import { describe, expect, it } from 'vitest';
import { recordingLog } from '../../../src/vscode/log';

describe('the recording run log', () => {
  it('passes every line on and keeps only the newest 1,000', () => {
    const written: string[] = [];
    const write = (line: string): void => {
      written.push(line);
    };
    const lines: string[] = [];
    const log = recordingLog({ info: write, warn: write, debug: write }, lines);

    for (let index = 1; index <= 1_002; index += 1) {
      log.info(`line ${String(index)}`);
    }
    log.warn('warned');
    log.debug('debugged');

    expect(written).toHaveLength(1_004);
    expect(lines).toHaveLength(1_000);
    expect(lines[0]).toBe('line 5');
    expect(lines.slice(-2)).toEqual(['warned', 'debugged']);
  });
});
