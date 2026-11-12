export interface StreamFixture {
  name: string;
  format: 'sse' | 'ndjson';
  contentType: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();

const agUiEvents = [
  { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
  { type: 'TEXT_MESSAGE_START', messageId: 'msg-1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'Héllo' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: ', wörld' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: ' 🚀' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: '✓' },
  { type: 'TEXT_MESSAGE_END', messageId: 'msg-1' },
  { type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'run-1' },
];

function chatChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id: 'chatcmpl-synthetic-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'synthetic-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function namedEvents(events: readonly (readonly [string, unknown])[]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const responseDeltas = ['Syn', 'the', 'tic'];

const openAiResponses = namedEvents([
  [
    'response.created',
    {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'resp-synthetic-1', object: 'response', status: 'in_progress' },
    },
  ],
  ...responseDeltas.map(
    (delta, index) =>
      [
        'response.output_text.delta',
        {
          type: 'response.output_text.delta',
          sequence_number: index + 1,
          item_id: 'msg-1',
          output_index: 0,
          content_index: 0,
          delta,
        },
      ] as const,
  ),
  [
    'response.completed',
    {
      type: 'response.completed',
      sequence_number: 4,
      response: { id: 'resp-synthetic-1', object: 'response', status: 'completed' },
    },
  ],
]);

const anthropic = namedEvents([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg-synthetic-1',
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model',
        content: [],
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  ['ping', { type: 'ping' }],
  ...responseDeltas.map(
    (text) =>
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      ] as const,
  ),
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const ollamaLines = [
  ...responseDeltas.map((content, index) => ({
    model: 'synthetic-model',
    created_at: `2026-11-12T00:00:0${String(index)}Z`,
    message: { role: 'assistant', content },
    done: false,
  })),
  {
    model: 'synthetic-model',
    created_at: '2026-11-12T00:00:03Z',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
  },
];

const edgeCasesSse = [
  '﻿: keep-alive\n',
  'data: line one\n',
  'data: line two\r\n',
  'data: line three\r',
  '\r\n',
  'data:no-space\n',
  '\n',
  'id: a\0b\n',
  'data: {"type":"with-null-id"}\n',
  '\n',
  'retry: 10a\n',
  'retry: 3000\n',
  'data: retried\n',
  '\n',
  'event: error\r\n',
  'data: {"type":"error","message":"synthetic failure"}\r\n',
  '\r\n',
  'data\n',
  '\n',
  'id: 7\n',
  '\n',
  'data: café ✓ 🚀\r',
  '\r',
  'data: partial\n',
].join('');

const edgeCasesNdjson = [
  '{"type":"first"}\r\n',
  '\r\n',
  '  \r\n',
  '{"type":"broken",\r\n',
  '{"type":"big","id":12345678901234567890}\r\n',
  '[1,2,3]\r\n',
  '{"type":"last"}',
].join('');

function text(
  name: string,
  format: 'sse' | 'ndjson',
  contentType: string,
  content: string,
): StreamFixture {
  return { name, format, contentType, bytes: encoder.encode(content) };
}

const sse = 'text/event-stream';
const ndjson = 'application/x-ndjson';

export const streamFixtures: readonly StreamFixture[] = [
  text(
    'ag-ui.ndjson',
    'ndjson',
    ndjson,
    agUiEvents.map((event) => `${JSON.stringify(event)}\n`).join(''),
  ),
  text(
    'ag-ui.sse',
    'sse',
    sse,
    agUiEvents.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  ),
  text(
    'openai-chat.sse',
    'sse',
    sse,
    [
      chatChunk({ role: 'assistant', content: 'Hi' }, null),
      chatChunk({ content: ' there' }, null),
      chatChunk({ content: null }, 'stop'),
      '[DONE]',
    ]
      .map((data) => `data: ${data}\n\n`)
      .join(''),
  ),
  text('openai-responses.sse', 'sse', sse, openAiResponses),
  text('anthropic.sse', 'sse', sse, anthropic),
  text(
    'ollama.ndjson',
    'ndjson',
    ndjson,
    ollamaLines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  ),
  text('edge-cases.sse', 'sse', sse, edgeCasesSse),
  text('edge-cases.ndjson', 'ndjson', ndjson, edgeCasesNdjson),
  {
    name: 'invalid-utf8.ndjson',
    format: 'ndjson',
    contentType: ndjson,
    bytes: Uint8Array.from([
      ...encoder.encode('{"type":"bad","text":"'),
      0xc3,
      0x28,
      ...encoder.encode('"}\n'),
    ]),
  },
];
