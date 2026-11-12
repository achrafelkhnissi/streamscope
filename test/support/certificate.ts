import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';

const oids = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
};

function length(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items);
const explicit = (tag: number, item: Buffer): Buffer => tlv(0xa0 | tag, item);
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const octets = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const bits = (bytes: Buffer): Buffer => tlv(0x03, Buffer.from([0]), bytes);
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));

export function derInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const minimal = bytes.subarray(start);
  const first = minimal[0] ?? 0;
  return tlv(0x02, first & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups = [part & 0x7f];
    for (let value = part >>> 7; value > 0; value >>>= 7) {
      groups.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid(oids.commonName), utf8(commonName))));
}

function generalName(host: string): Buffer {
  return isIPv4(host)
    ? tlv(0x87, Buffer.from(host.split('.').map(Number)))
    : tlv(0x82, Buffer.from(host, 'ascii'));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octets(value));
}

export function createSelfSignedCertificate(hosts: readonly string[]): {
  cert: string;
  key: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = sequence(oid(oids.ecdsaWithSha256));
  const subject = name(hosts[0] ?? 'localhost');
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const tbs = sequence(
    explicit(0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(8)),
    algorithm,
    subject,
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      sequence(
        extension(oids.subjectAltName, false, sequence(...hosts.map(generalName))),
        extension(oids.basicConstraints, true, sequence(boolean(true))),
      ),
    ),
  );
  const certificate = sequence(tbs, algorithm, bits(sign('sha256', tbs, privateKey)));
  const base64 = certificate.toString('base64').replace(/(.{64})/g, '$1\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
