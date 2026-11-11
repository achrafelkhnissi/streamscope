export type OffsetUnit = 'y' | 'Q' | 'M' | 'w' | 'd' | 'h' | 'm' | 's' | 'ms';
export type Zone = 'utc' | 'local';

interface Fields {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
  offsetMinutes: number;
}

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const tokenPattern =
  /\[([^\]]+)]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g;
const elapsedUnits: Partial<Record<OffsetUnit, number>> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
};
const monthUnits: Partial<Record<OffsetUnit, number>> = { y: 12, Q: 3, M: 1 };

function fields(date: Date, zone: Zone): Fields {
  if (zone === 'utc') {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
      seconds: date.getUTCSeconds(),
      milliseconds: date.getUTCMilliseconds(),
      offsetMinutes: 0,
    };
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    weekday: date.getDay(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
    milliseconds: date.getMilliseconds(),
    offsetMinutes: -date.getTimezoneOffset(),
  };
}

function withCalendarDate(date: Date, zone: Zone, year: number, month: number, day: number): Date {
  const result = new Date(date.getTime());
  if (zone === 'utc') {
    result.setUTCFullYear(year, month, day);
  } else {
    result.setFullYear(year, month, day);
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addOffset(date: Date, amount: number, unit: OffsetUnit, zone: Zone): Date {
  const elapsed = elapsedUnits[unit];
  if (elapsed !== undefined) {
    return new Date(date.getTime() + amount * elapsed);
  }
  const { year, month, day } = fields(date, zone);
  const months = monthUnits[unit];
  if (months !== undefined) {
    const target = month + amount * months;
    return withCalendarDate(date, zone, year, target, Math.min(day, daysInMonth(year, target)));
  }
  return withCalendarDate(date, zone, year, month, day + amount * (unit === 'w' ? 7 : 1));
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function offsetText(offsetMinutes: number, separator: string): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60), 2)}${separator}${pad(absolute % 60, 2)}`;
}

function token(match: string, value: Fields): string {
  const hours12 = value.hours % 12 || 12;
  const weekday = weekdayNames[value.weekday] ?? '';
  const month = monthNames[value.month] ?? '';
  const table: Record<string, string> = {
    YYYY: pad(value.year, 4),
    YY: String(value.year).slice(-2),
    M: String(value.month + 1),
    MM: pad(value.month + 1, 2),
    MMM: month.slice(0, 3),
    MMMM: month,
    D: String(value.day),
    DD: pad(value.day, 2),
    d: String(value.weekday),
    dd: weekday.slice(0, 2),
    ddd: weekday.slice(0, 3),
    dddd: weekday,
    H: String(value.hours),
    HH: pad(value.hours, 2),
    h: String(hours12),
    hh: pad(hours12, 2),
    a: value.hours < 12 ? 'am' : 'pm',
    A: value.hours < 12 ? 'AM' : 'PM',
    m: String(value.minutes),
    mm: pad(value.minutes, 2),
    s: String(value.seconds),
    ss: pad(value.seconds, 2),
    SSS: pad(value.milliseconds, 3),
    Z: offsetText(value.offsetMinutes, ':'),
    ZZ: offsetText(value.offsetMinutes, ''),
  };
  return table[match] ?? match;
}

export function formatDate(date: Date, pattern: string, zone: Zone): string {
  const value = fields(date, zone);
  return pattern.replace(
    tokenPattern,
    (match, literal: string | undefined) => literal ?? token(match, value),
  );
}
