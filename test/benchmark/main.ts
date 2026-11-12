import { parseArgs } from 'node:util';
import { runSoak } from './soak';
import { measureThroughput } from './throughput';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: 'string', default: 'ndjson' },
      events: { type: 'string', default: '100000' },
      size: { type: 'string', default: '1024' },
      rate: { type: 'string', default: '1000' },
      minutes: { type: 'string', default: '1' },
      sample: { type: 'string', default: '5000' },
    },
  });
  const format = values.format === 'sse' ? 'sse' : 'ndjson';
  const eventBytes = Number(values.size);
  const command = positionals[0];
  if (command === 'throughput') {
    const result = measureThroughput({
      format,
      events: Number(values.events),
      eventBytes,
      chunkBytes: 16 * 1024,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'soak') {
    const result = await runSoak({
      format,
      rate: Number(values.rate),
      seconds: Number(values.minutes) * 60,
      eventBytes,
      sampleMs: Number(values.sample),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: npm run bench -- throughput|soak [--format ndjson|sse] [options]');
}

void main();
