import { describe, expect, it } from 'vitest';
import { streamFixtures } from '../../support/stream-fixtures';
import type { StreamEvent } from '../../../src/events/model';
import { ReplyAssembler } from '../../../src/events/reply';
import type { StreamFormat } from '../../../src/streaming/detect';
import { defaultStreamLimits } from '../../../src/streaming/limits';
import { StreamParser } from '../../../src/streaming/parser';

function assemble(
  bytes: Uint8Array,
  contentType: string | undefined,
  assembler = new ReplyAssembler(),
): ReplyAssembler {
  let format: StreamFormat = 'text';
  const parser = new StreamParser(
    {
      contentType,
      directive: undefined,
      maxEventSize: defaultStreamLimits.maxEventSize,
      typeFields: defaultStreamLimits.typeFields,
      now: () => 0,
    },
    {
      format: (decision) => {
        format = decision.format;
      },
      event: (event) => {
        assembler.push(event, format);
      },
      text: () => undefined,
      warning: () => undefined,
    },
  );
  parser.push(bytes);
  parser.end();
  return assembler;
}

function fixture(name: string): { bytes: Uint8Array; contentType: string } {
  const found = streamFixtures.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Missing fixture ${name}`);
  }
  return found;
}

function jsonEvent(value: StreamEvent['value'], index = 1): StreamEvent {
  return {
    index,
    time: 0,
    offset: 0,
    length: 1,
    line: index,
    kind: 'json',
    value,
    label: undefined,
    sse: undefined,
    marker: undefined,
    error: undefined,
    unterminated: false,
  };
}

describe('ReplyAssembler', () => {
  it.each([
    ['ag-ui.ndjson', 'ag-ui', 'Héllo, wörld 🚀✓'],
    ['ag-ui.sse', 'ag-ui', 'Héllo, wörld 🚀✓'],
    ['openai-chat.sse', 'openai-chat', 'Hi there'],
    ['openai-responses.sse', 'openai-responses', 'Synthetic'],
    ['anthropic.sse', 'anthropic', 'Synthetic'],
    ['ollama.ndjson', 'ollama', 'Synthetic'],
  ])('assembles the reply of every vendor fixture: %s', (name, adapter, reply) => {
    const { bytes, contentType } = fixture(name);
    const assembler = assemble(bytes, contentType);

    expect(assembler.adapter).toBe(adapter);
    expect(assembler.text()).toBe(reply);
    expect(assembler.truncated).toBe(false);
  });

  it('chooses no adapter for unknown events', () => {
    const assembler = new ReplyAssembler();
    assembler.push(jsonEvent({ type: 'heartbeat', delta: 'ignored' }), 'ndjson');
    assembler.push(jsonEvent({ message: { content: 42 } }, 2), 'ndjson');
    assembler.push(jsonEvent([1, 2, 3], 3), 'ndjson');

    expect(assembler.adapter).toBeUndefined();
    expect(assembler.text()).toBe('');
  });

  it('does not treat an OpenAI Responses object field named response as Ollama', () => {
    const assembler = new ReplyAssembler();
    assembler.push(
      jsonEvent({ type: 'response.created', response: { id: 'resp-synthetic-1' } }),
      'ndjson',
    );

    expect(assembler.adapter).toBeUndefined();

    assembler.push(jsonEvent({ type: 'response.output_text.delta', delta: 'Syn' }, 2), 'ndjson');

    expect(assembler.adapter).toBe('openai-responses');
    expect(assembler.text()).toBe('Syn');
  });

  it('recognises Ollama only in NDJSON streams', () => {
    const sse = new ReplyAssembler();
    sse.push(jsonEvent({ model: 'synthetic-model', response: 'Syn' }), 'sse');
    const ndjson = new ReplyAssembler();
    ndjson.push(jsonEvent({ model: 'synthetic-model', response: 'Syn' }), 'ndjson');

    expect(sse.adapter).toBeUndefined();
    expect(ndjson.adapter).toBe('ollama');
    expect(ndjson.text()).toBe('Syn');
  });

  it('keeps the first adapter and ignores events of other shapes', () => {
    const assembler = new ReplyAssembler();
    assembler.push(jsonEvent({ type: 'RUN_STARTED', threadId: 'thread-1' }), 'ndjson');
    assembler.push(jsonEvent({ model: 'synthetic-model', response: 'other' }, 2), 'ndjson');
    assembler.push(
      jsonEvent({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'msg-1', delta: 'chunk' }, 3),
      'ndjson',
    );

    expect(assembler.adapter).toBe('ag-ui');
    expect(assembler.text()).toBe('chunk');
  });

  it('ignores events that are not JSON', () => {
    const assembler = new ReplyAssembler();
    assembler.push({ ...jsonEvent('[DONE]'), kind: 'text', marker: 'done' }, 'sse');

    expect(assembler.adapter).toBeUndefined();
  });

  it('stops at the length limit and marks the reply truncated', () => {
    const { bytes, contentType } = fixture('ag-ui.ndjson');
    const assembler = assemble(bytes, contentType, new ReplyAssembler(4));

    expect(assembler.text()).toBe('Héll');
    expect(assembler.truncated).toBe(true);
  });
});
