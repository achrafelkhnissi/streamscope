import { describe, expect, it } from 'vitest';
import { screenshotUrl } from '../../../src/benchmark/contract';

describe('screenshotUrl', () => {
  it('asks the control server for a named screenshot', () => {
    expect(screenshotUrl('http://127.0.0.1:5000', 'webview-events live')).toBe(
      'http://127.0.0.1:5000/screenshot?name=webview-events%20live',
    );
  });
});
