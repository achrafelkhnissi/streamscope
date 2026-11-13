import type { Expr } from '../expressions/ast';
import type { Outcome } from '../expressions/evaluate';
import { checkJsonPath } from '../expressions/jsonpath';
import { parseExpression, sourcesOf } from '../expressions/parse';
import type { ResponseHead } from '../transport/model';
import { evaluateJobs, fileBodyBytes, sourceKey, type BodySubject } from './body';
import {
  bodySelectorReason,
  bodyUnavailableReason,
  cancelledReason,
  failedReason,
  headerNameReason,
  noHeadersReason,
  notSentReason,
  requestReferenceReason,
  unsupportedResponseReason,
  xpathReason,
} from './messages';
import { headValues } from './tracker';

export interface ReferencedRun {
  readonly label: string;
  readonly status: string;
  readonly head: ResponseHead | undefined;
  readonly done: Promise<unknown>;
  readonly headArrived: Promise<void>;
  failure(): string | undefined;
  readonly bodyLength: number;
  readBody(maxBytes: number): Promise<Uint8Array | undefined>;
  bodyFile(): Promise<{ path: string; length: number } | undefined>;
  readonly workerFile: string;
}

export type ReferenceResult = { ok: true; text: string } | { ok: false; reason: string };

type Translation =
  | { ok: true; part: 'head' | 'body'; expression: Expr; text: string }
  | { ok: false; reason: string };

const bodyPrefix = 'response.body';
const headersPrefix = 'response.headers';
const noneCollected = new Map<string, never>();

function under(reference: string, prefix: string): string | undefined {
  if (reference === prefix) {
    return '';
  }
  return reference.startsWith(`${prefix}.`) ? reference.slice(prefix.length + 1) : undefined;
}

function parsed(part: 'head' | 'body', text: string): Translation {
  const result = parseExpression(text, 'capture');
  return result.ok
    ? { ok: true, part, expression: result.expr, text }
    : { ok: false, reason: result.error.message };
}

function translate(name: string, reference: string): Translation {
  if (reference.split('.', 1)[0] === 'request') {
    return { ok: false, reason: requestReferenceReason(name, reference) };
  }
  const selector = under(reference, bodyPrefix);
  if (selector !== undefined) {
    if (selector === '*') {
      return parsed('body', 'body');
    }
    if (selector === '') {
      return { ok: false, reason: bodySelectorReason(name) };
    }
    if (!selector.startsWith('$')) {
      return { ok: false, reason: xpathReason(name) };
    }
    const problem = checkJsonPath(selector);
    return problem === undefined
      ? parsed('body', `jsonpath(${JSON.stringify(selector)})`)
      : { ok: false, reason: problem.message };
  }
  const header = under(reference, headersPrefix);
  if (header !== undefined) {
    return header === ''
      ? { ok: false, reason: headerNameReason(name) }
      : parsed('head', `headers[${JSON.stringify(header)}]`);
  }
  return { ok: false, reason: unsupportedResponseReason(name, reference) };
}

function endedReason(run: ReferencedRun, reference: string): string | undefined {
  switch (run.status) {
    case 'completed':
      return undefined;
    case 'cancelled':
      return cancelledReason(run.label, reference);
    case 'blocked':
      return notSentReason(run.label, run.failure());
    default:
      return failedReason(run.label, reference, run.failure());
  }
}

function contentTypeOf(head: ResponseHead | undefined): string | undefined {
  return head?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

async function bodySubject(run: ReferencedRun): Promise<BodySubject | string> {
  const contentType = contentTypeOf(run.head);
  if (run.bodyLength <= fileBodyBytes) {
    const bytes = await run.readBody(run.bodyLength);
    if (bytes !== undefined) {
      return { kind: 'body', bytes, contentType };
    }
  }
  const file = await run.bodyFile();
  return file === undefined
    ? bodyUnavailableReason
    : { kind: 'file', path: file.path, length: file.length, contentType };
}

function headersKnown(expression: Expr, head: ResponseHead): Map<string, Outcome> {
  const known = new Map<string, Outcome>();
  for (const node of sourcesOf(expression)) {
    if (node.kind === 'source' && node.name === 'headers') {
      known.set(sourceKey(node), { present: true, value: headValues(head).headers, path: '' });
    }
  }
  return known;
}

async function evaluated(
  run: ReferencedRun,
  name: string,
  subject: BodySubject,
  { expression, text }: { expression: Expr; text: string },
  known: ReadonlyMap<string, Outcome>,
): Promise<ReferenceResult> {
  const [answer] = await evaluateJobs(
    subject,
    [{ name, expression, text, known, collected: noneCollected }],
    run.workerFile,
  );
  if (answer === undefined) {
    throw new Error('evaluateJobs returned no result for the reference');
  }
  const [, result] = answer;
  return result.present ? { ok: true, text: result.text } : { ok: false, reason: result.reason };
}

export async function evaluateResponseReference(
  run: ReferencedRun,
  reference: string,
): Promise<ReferenceResult> {
  const translation = translate(run.label, reference);
  if (!translation.ok) {
    return translation;
  }
  if (translation.part === 'head') {
    if (run.head === undefined) {
      await Promise.race([run.headArrived, run.done]);
    }
    const head = run.head;
    if (head === undefined) {
      return { ok: false, reason: endedReason(run, reference) ?? noHeadersReason };
    }
    const subject: BodySubject = {
      kind: 'body',
      bytes: new Uint8Array(),
      contentType: contentTypeOf(head),
    };
    return evaluated(
      run,
      reference,
      subject,
      translation,
      headersKnown(translation.expression, head),
    );
  }
  await run.done;
  const ended = endedReason(run, reference);
  if (ended !== undefined) {
    return { ok: false, reason: ended };
  }
  const subject = await bodySubject(run);
  return typeof subject === 'string'
    ? { ok: false, reason: subject }
    : evaluated(run, reference, subject, translation, new Map());
}
