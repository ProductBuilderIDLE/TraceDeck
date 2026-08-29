import { createHash } from 'node:crypto';

export function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCode = left.codePointAt(leftIndex) as number;
    const rightCode = right.codePointAt(rightIndex) as number;

    if (leftCode !== rightCode) return leftCode - rightCode;

    leftIndex += leftCode > 0xffff ? 2 : 1;
    rightIndex += rightCode > 0xffff ? 2 : 1;
  }

  return left.length - right.length;
}

function collectObjectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    keys.add(key);
    collectObjectKeys(source[key], keys);
  }
}

export function canonicalStringify(value: unknown): string {
  const keys = new Set<string>();
  collectObjectKeys(value, keys);
  return JSON.stringify(value, [...keys].sort(compareCodePoints));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function stableBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareCodePoints(keyOf(left), keyOf(right)));
}
