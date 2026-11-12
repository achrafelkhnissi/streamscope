import { isSensitiveHeader, maskUrl } from '../masking/masking';
import type { OutgoingRequest } from './model';

export const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const rewritingStatuses: ReadonlySet<number> = new Set([301, 302, 303]);
const bodyHeaders: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
  'transfer-encoding',
]);
export function redirectTarget(
  request: OutgoingRequest,
  status: number,
  location: string,
): { ok: true; request: OutgoingRequest } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(location, request.url);
  } catch {
    return {
      ok: false,
      message: `The server redirected to \`${maskUrl(location)}\`, which is not a valid URL.`,
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      message: `The server redirected to \`${maskUrl(location)}\`, which is not an http or https URL.`,
    };
  }
  const rewrite = rewritingStatuses.has(status);
  if (
    !rewrite &&
    request.body.length > 0 &&
    request.url.protocol === 'https:' &&
    url.protocol === 'http:'
  ) {
    return {
      ok: false,
      message: `The server redirected to plain http (\`${maskUrl(location)}\`), so Streamscope did not resend the request body without TLS.`,
    };
  }
  const crossOrigin = url.origin !== request.url.origin;
  const headers = request.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    const credential = lower === 'host' || isSensitiveHeader(name);
    return !(rewrite && bodyHeaders.has(lower)) && !(crossOrigin && credential);
  });
  return {
    ok: true,
    request: {
      method: rewrite && request.method.toUpperCase() !== 'HEAD' ? 'GET' : request.method,
      url,
      headers,
      body: rewrite ? [] : request.body,
    },
  };
}
