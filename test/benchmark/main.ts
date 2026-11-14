import { parseArgs } from 'node:util';
import { startStreamServer } from '../support/stream-server';
import { runSoak } from './soak';
import { measureThroughput } from './throughput';
import { runViewBenchmark } from './view/runner';

async function serve(): Promise<void> {
  const server = await startStreamServer();
  console.log(`Streaming at ${server.url}/stream?format=ndjson&rate=20&seconds=600`);
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await server.close();
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: 'string', default: 'ndjson' },
      events: { type: 'string', default: '100000' },
      size: { type: 'string', default: '1024' },
      captures: { type: 'string', default: '0' },
      rate: { type: 'string' },
      minutes: { type: 'string', default: '1' },
      sample: { type: 'string', default: '5000' },
      surface: { type: 'string', default: 'webview' },
      walkthrough: { type: 'boolean', default: false },
      theme: { type: 'string' },
      extension: { type: 'string', multiple: true, default: [] },
    },
  });
  const format = values.format === 'sse' ? 'sse' : 'ndjson';
  const eventBytes = Number(values.size);
  const command = positionals[0];
  if (command === 'throughput') {
    const result = await measureThroughput({
      format,
      events: Number(values.events),
      eventBytes,
      chunkBytes: 16 * 1024,
      captures: Number(values.captures),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'soak') {
    const result = await runSoak({
      format,
      rate: Number(values.rate ?? '1000'),
      seconds: Number(values.minutes) * 60,
      eventBytes,
      sampleMs: Number(values.sample),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'view') {
    const result = await runViewBenchmark({
      surface: values.surface,
      rate: Number(values.rate ?? '500'),
      seconds: Number(values.minutes) * 60,
      eventBytes,
      walkthrough: values.walkthrough,
      theme: values.theme,
      extensions: values.extension,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.error !== undefined) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'serve') {
    await serve();
    return;
  }
  throw new Error(
    'Usage: npm run bench -- throughput|soak|view|serve [--format ndjson|sse] [options]',
  );
}

void main();
