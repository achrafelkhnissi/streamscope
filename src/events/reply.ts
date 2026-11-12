import type { StreamFormat } from '../streaming/detect';
import { maxReplyLength } from '../streaming/limits';
import type { JsonValue, StreamEvent } from './model';

export type ReplyAdapterName =
  'ag-ui' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'ollama';

export interface ReplyAdapter {
  name: ReplyAdapterName;
  recognises(event: StreamEvent, format: StreamFormat): boolean;
  text(event: StreamEvent): string | undefined;
}

type JsonObject = { readonly [key: string]: JsonValue };

function field(value: JsonValue | undefined, name: string): JsonValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const object = value as JsonObject;
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

function stringField(value: JsonValue | undefined, name: string): string | undefined {
  const found = field(value, name);
  return typeof found === 'string' ? found : undefined;
}

function firstItem(value: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(value) ? (value as readonly JsonValue[])[0] : undefined;
}

const agUi: ReplyAdapter = {
  name: 'ag-ui',
  recognises: (event) => {
    const type = stringField(event.value, 'type');
    return type === 'RUN_STARTED' || (type?.startsWith('TEXT_MESSAGE_') ?? false);
  },
  text: (event) => {
    const type = stringField(event.value, 'type');
    return type === 'TEXT_MESSAGE_CONTENT' || type === 'TEXT_MESSAGE_CHUNK'
      ? stringField(event.value, 'delta')
      : undefined;
  },
};

const openAiChat: ReplyAdapter = {
  name: 'openai-chat',
  recognises: (event) => stringField(event.value, 'object') === 'chat.completion.chunk',
  text: (event) => stringField(field(firstItem(field(event.value, 'choices')), 'delta'), 'content'),
};

const openAiResponses: ReplyAdapter = {
  name: 'openai-responses',
  recognises: (event) => stringField(event.value, 'type') === 'response.output_text.delta',
  text: (event) =>
    stringField(event.value, 'type') === 'response.output_text.delta'
      ? stringField(event.value, 'delta')
      : undefined,
};

const anthropic: ReplyAdapter = {
  name: 'anthropic',
  recognises: (event) => event.sse?.event === 'content_block_delta',
  text: (event) =>
    event.sse?.event === 'content_block_delta'
      ? stringField(field(event.value, 'delta'), 'text')
      : undefined,
};

function ollamaText(event: StreamEvent): string | undefined {
  return (
    stringField(field(event.value, 'message'), 'content') ?? stringField(event.value, 'response')
  );
}

const ollama: ReplyAdapter = {
  name: 'ollama',
  recognises: (event, format) => format === 'ndjson' && ollamaText(event) !== undefined,
  text: ollamaText,
};

export const replyAdapters: readonly ReplyAdapter[] = [
  agUi,
  openAiChat,
  openAiResponses,
  anthropic,
  ollama,
];

const trailingHighSurrogate = /[\uD800-\uDBFF]$/;

export class ReplyAssembler {
  private chosen: ReplyAdapter | undefined;
  private readonly parts: string[] = [];
  private length = 0;
  private cut = false;

  constructor(private readonly maxLength: number = maxReplyLength) {}

  get adapter(): ReplyAdapterName | undefined {
    return this.chosen?.name;
  }

  get truncated(): boolean {
    return this.cut;
  }

  get size(): number {
    return this.length;
  }

  push(event: StreamEvent, format: StreamFormat): void {
    if (event.kind !== 'json' || this.cut) {
      return;
    }
    this.chosen ??= replyAdapters.find((adapter) => adapter.recognises(event, format));
    const text = this.chosen?.text(event);
    if (text === undefined || text === '') {
      return;
    }
    const room = this.maxLength - this.length;
    if (text.length <= room) {
      this.parts.push(text);
      this.length += text.length;
      return;
    }
    const kept = text.slice(0, room).replace(trailingHighSurrogate, '');
    this.parts.push(kept);
    this.length += kept.length;
    this.cut = true;
  }

  text(): string {
    const joined = this.parts.join('');
    this.parts.splice(0, this.parts.length, joined);
    return joined;
  }

  release(): string {
    const joined = this.text();
    this.parts.length = 0;
    return joined;
  }

  since(offset: number): string {
    const count = Math.max(0, this.length - offset);
    let wanted = count;
    let first = this.parts.length;
    while (wanted > 0 && first > 0) {
      first -= 1;
      wanted -= this.parts[first]?.length ?? 0;
    }
    const joined = this.parts.slice(first).join('');
    return joined.slice(joined.length - count);
  }
}
