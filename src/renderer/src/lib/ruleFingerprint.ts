import type { ArchitectureRule } from '@shared/types';

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizedPattern(value: string): string {
  return toPosixPath(value).trim();
}

function normalizedSet(values: readonly string[], normalize = (value: string): string => value): string[] {
  return [...new Set(values.map(normalize))].sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
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

function canonicalStringify(value: unknown): string {
  const keys = new Set<string>();
  collectObjectKeys(value, keys);
  return JSON.stringify(value, [...keys].sort(compareCodePoints));
}

async function sha256(message: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  const bytes = new Uint8Array(buffer);
  let result = '';
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number;
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export async function ruleFingerprint(rule: ArchitectureRule): Promise<string> {
  const exceptions = normalizedSet(rule.configuration.exceptions, normalizedPattern);
  return sha256(
    canonicalStringify({
      name: rule.name,
      ruleType: rule.ruleType,
      sourcePattern: normalizedPattern(rule.sourcePattern),
      targetPattern: normalizedPattern(rule.targetPattern),
      severity: rule.configuration.severity,
      exceptions,
    }),
  );
}
