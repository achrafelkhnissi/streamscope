import { afterEach, describe, expect, it } from 'vitest';
import { RunRegistry } from '../../../src/runs/registry';
import type { RunStatus } from '../../../src/runs/run';
import { startHttpServer, type LocalServer } from '../../support/servers';
import { waitFor } from '../transport/harness';
import { dependencies, runInput, useSpillArea } from './support';

const servers: LocalServer[] = [];
const registries: RunRegistry[] = [];
useSpillArea();

function registry(): RunRegistry {
  const created = new RunRegistry(dependencies);
  registries.push(created);
  return created;
}

async function holdingServer(): Promise<LocalServer> {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200);
    if (request.url === '/hold') {
      response.write('partial');
      return;
    }
    response.end('done');
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  registries.splice(0).forEach((created) => {
    created.dispose();
  });
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('RunRegistry', () => {
  it('re-sending a running request cancels the earlier run and closes its socket', async () => {
    const server = await holdingServer();
    const runs = registry();
    const input = runInput([`GET ${server.url}/hold`], { key: 'same' });

    const first = runs.start(input);
    await waitFor(() => first.snapshot().status === 'receiving', 2000);
    const second = runs.start(input);

    expect((await first.done).status).toBe('cancelled');
    expect(runs.latest('same')).toBe(second);
    await waitFor(() => server.sockets.closed >= 1);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('keeps runs of different requests independent', async () => {
    const server = await holdingServer();
    const runs = registry();

    const held = runs.start(runInput([`GET ${server.url}/hold`], { key: 'held' }));
    const quick = runs.start(runInput([`GET ${server.url}/quick`], { key: 'quick' }));

    expect((await quick.done).status).toBe('completed');
    expect(held.snapshot().status).not.toBe('cancelled');
    expect(runs.isRunning()).toBe(true);
    expect(runs.cancel('held')).toBe(true);
    expect((await held.done).status).toBe('cancelled');
    expect(runs.isRunning()).toBe(false);
    expect(runs.cancel('held')).toBe(false);
  });

  it('notifies listeners on every status change', async () => {
    const server = await holdingServer();
    const runs = registry();
    const statuses: RunStatus[] = [];
    const unsubscribe = runs.onDidChange((snapshot) => statuses.push(snapshot.status));

    await runs.start(runInput([`GET ${server.url}/quick`])).done;
    unsubscribe();
    await runs.start(runInput([`GET ${server.url}/quick`])).done;

    expect(statuses).toEqual(['sending', 'receiving', 'completed']);
  });

  it('dispose cancels running runs', async () => {
    const server = await holdingServer();
    const runs = registry();
    const held = runs.start(runInput([`GET ${server.url}/hold`]));
    await waitFor(() => held.snapshot().status === 'receiving', 2000);

    runs.dispose();

    expect((await held.done).status).toBe('cancelled');
  });
});
