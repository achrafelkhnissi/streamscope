export const tooMuchWorkReason = 'the expression needs too much work for this value';
export const unitsPerCheck = 1024;
export const rememberedKeyCount = 1024;

export interface WorkLimits {
  units?: number;
  expired?: () => boolean;
  reason?: string;
}

class OutOfWork extends Error {}

export const outOfWork: Error = new OutOfWork(tooMuchWorkReason);

export class WorkBudget {
  readonly reason: string;
  private used = 0;
  private next: number;
  private over = false;
  private readonly limit: number;
  private readonly expired: (() => boolean) | undefined;
  private remembered: Map<object, readonly string[]> | undefined;

  constructor({
    units = Number.POSITIVE_INFINITY,
    expired,
    reason = tooMuchWorkReason,
  }: WorkLimits = {}) {
    this.limit = units;
    this.expired = expired;
    this.reason = reason;
    this.next = Math.min(unitsPerCheck, units + 1);
  }

  get spent(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.over;
  }

  spend(units: number): void {
    this.used += units;
    if (this.used >= this.next) {
      this.check();
    }
  }

  keysOf(object: object): readonly string[] {
    const known = this.remembered?.get(object);
    if (known !== undefined) {
      this.spend(1);
      return known;
    }
    const keys = Object.keys(object);
    this.spend(keys.length);
    if (keys.length >= rememberedKeyCount) {
      this.remembered ??= new Map();
      this.remembered.set(object, keys);
    }
    return keys;
  }

  private check(): void {
    if (this.over || this.used > this.limit || this.expired?.() === true) {
      this.over = true;
      throw outOfWork;
    }
    this.next = Math.min(this.used + unitsPerCheck, this.limit + 1);
  }
}

export function textUnits(length: number): number {
  return length >>> 4;
}

export function keysOf(object: object, budget: WorkBudget | undefined): readonly string[] {
  return budget === undefined ? Object.keys(object) : budget.keysOf(object);
}
