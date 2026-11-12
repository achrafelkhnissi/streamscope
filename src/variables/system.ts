import { addOffset, formatDate, type OffsetUnit, type Zone } from './dates';

export interface SystemContext {
  now(): Date;
  randomInt(minInclusive: number, maxExclusive: number): number;
  uuid(): string;
}

export type SystemValue = { ok: true; value: string } | { ok: false; message: string };

const offset = String.raw`(?:\s+(-?\d+)\s+(y|Q|M|w|d|h|m|s|ms))?`;
const guidPattern = /^\$guid$/;
const timestampPattern = new RegExp(String.raw`^\$timestamp${offset}$`);
const datetimePattern = new RegExp(
  String.raw`^\$(datetime|localDatetime)\s+(rfc1123|iso8601|'[^']+'|"[^"]+")${offset}$`,
);
const randomIntPattern = /^\$randomInt\s+(-?\d+)\s+(-?\d+)$/;
const namePattern = /^\$(\w+)/;

const expectedFormats: Record<string, string> = {
  guid: '$guid',
  timestamp: '$timestamp [<offset> <unit>]',
  datetime: '$datetime rfc1123|iso8601|"<format>" [<offset> <unit>]',
  localDatetime: '$localDatetime rfc1123|iso8601|"<format>" [<offset> <unit>]',
  randomInt: '$randomInt <min> <max>',
};
const laterVariables: ReadonlySet<string> = new Set([
  'processEnv',
  'dotenv',
  'aadToken',
  'aadV2Token',
  'secret',
]);

function ok(value: string): SystemValue {
  return { ok: true, value };
}

function problem(message: string): SystemValue {
  return { ok: false, message };
}

function shifted(
  context: SystemContext,
  amount: string | undefined,
  unit: string | undefined,
  zone: Zone,
): Date {
  const now = context.now();
  return amount === undefined || unit === undefined
    ? now
    : addOffset(now, Number.parseInt(amount, 10), unit as OffsetUnit, zone);
}

function formatted(date: Date, format: string, zone: Zone): string {
  if (format === 'rfc1123') {
    return zone === 'utc'
      ? date.toUTCString()
      : formatDate(date, 'ddd, DD MMM YYYY HH:mm:ss ZZ', zone);
  }
  if (format === 'iso8601') {
    return zone === 'utc' ? date.toISOString() : formatDate(date, 'YYYY-MM-DDTHH:mm:ssZ', zone);
  }
  return formatDate(date, format.slice(1, -1), zone);
}

function outOfRange(expression: string): SystemValue {
  return problem(`\`{{${expression}}}\` gives a date out of range.`);
}

function known(expression: string, context: SystemContext): SystemValue | undefined {
  if (guidPattern.test(expression)) {
    return ok(context.uuid());
  }
  const timestamp = timestampPattern.exec(expression);
  if (timestamp) {
    const date = shifted(context, timestamp[1], timestamp[2], 'utc');
    return Number.isNaN(date.getTime())
      ? outOfRange(expression)
      : ok(String(Math.floor(date.getTime() / 1000)));
  }
  const datetime = datetimePattern.exec(expression);
  if (datetime) {
    const zone: Zone = datetime[1] === 'datetime' ? 'utc' : 'local';
    const date = shifted(context, datetime[3], datetime[4], zone);
    return Number.isNaN(date.getTime())
      ? outOfRange(expression)
      : ok(formatted(date, datetime[2] ?? '', zone));
  }
  const randomInt = randomIntPattern.exec(expression);
  if (randomInt) {
    const min = Number(randomInt[1]);
    const max = Number(randomInt[2]);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min >= max) {
      return problem(`\`{{${expression}}}\` needs a minimum below its maximum.`);
    }
    return ok(String(context.randomInt(min, max)));
  }
  return undefined;
}

export function resolveSystemVariable(expression: string, context: SystemContext): SystemValue {
  const value = known(expression, context);
  if (value) {
    return value;
  }
  const name = namePattern.exec(expression)?.[1] ?? '';
  const format = expectedFormats[name];
  if (format !== undefined) {
    return problem(`\`{{${expression}}}\` does not match the expected format \`${format}\`.`);
  }
  if (laterVariables.has(name)) {
    return problem(`\`{{${expression}}}\` is not supported yet.`);
  }
  return problem(`Unknown system variable \`{{${expression}}}\`.`);
}
