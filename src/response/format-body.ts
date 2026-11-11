import { formatBytes } from './labels';
import { reindentJson } from './reindent-json';

export type BodyLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'plaintext';

export interface FormattedBody {
  languageId: BodyLanguage;
  text: string;
  binary: boolean;
}

const binaryPrefixes = ['image/', 'audio/', 'video/', 'font/'];
const binaryTypes: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/wasm',
]);
const javascriptTypes: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/javascript',
  'text/ecmascript',
]);
const charsetPattern = /;\s*charset\s*=\s*"?([^";\s]+)"?/i;

function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type === '' ? undefined : type;
}

function isBinary(type: string | undefined, bytes: Uint8Array): boolean {
  if (type === undefined) {
    return bytes.includes(0);
  }
  return binaryTypes.has(type) || binaryPrefixes.some((prefix) => type.startsWith(prefix));
}

function decoderFor(label: string) {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('utf-8');
  }
}

function decode(bytes: Uint8Array, contentType: string | undefined): string {
  return decoderFor(charsetPattern.exec(contentType ?? '')?.[1] ?? 'utf-8').decode(bytes);
}

function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

function prettyJson(text: string): string | undefined {
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  return reindentJson(text);
}

function language(type: string | undefined): BodyLanguage {
  if (type === undefined) {
    return 'plaintext';
  }
  if (type.endsWith('/xml') || type.endsWith('+xml')) {
    return 'xml';
  }
  if (type === 'text/html') {
    return 'html';
  }
  if (javascriptTypes.has(type)) {
    return 'javascript';
  }
  return type === 'text/css' ? 'css' : 'plaintext';
}

export function formatBody(bytes: Uint8Array, contentType: string | undefined): FormattedBody {
  if (bytes.length === 0) {
    return { languageId: 'plaintext', text: '', binary: false };
  }
  const type = mediaType(contentType);
  if (isBinary(type, bytes)) {
    return {
      languageId: 'plaintext',
      text: `Binary body (${formatBytes(bytes.length)}). Use Save Response to keep it.`,
      binary: true,
    };
  }
  const text = decode(bytes, contentType);
  const declaredJson = type === 'application/json' || type?.endsWith('+json') === true;
  const sniffedJson = (type === undefined || type === 'text/plain') && looksLikeJson(text);
  if (declaredJson || sniffedJson) {
    const pretty = prettyJson(text);
    return pretty === undefined
      ? { languageId: 'plaintext', text, binary: false }
      : { languageId: 'json', text: pretty, binary: false };
  }
  return { languageId: language(type), text, binary: false };
}
