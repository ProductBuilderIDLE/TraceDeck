/**
 * Minimal structural validators for IPC payloads.
 *
 * Every handler runs its payload through one of these before touching the database or the
 * filesystem. The renderer is treated as untrusted: a compromised renderer must not be able
 * to reach a code path with a malformed or hostile payload.
 */

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(field: string, expected: string): never {
  throw new ValidationError(`Field "${field}" must be ${expected}.`);
}

export function asObject(value: unknown, field = 'payload'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'an object');
  }
  return value as Record<string, unknown>;
}

export function requireInt(value: unknown, field: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    fail(field, `an integer >= ${min}`);
  }
  return value;
}

export function optionalInt(
  value: unknown,
  field: string,
  min = Number.MIN_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInt(value, field, min);
}

export function requireString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== 'string') fail(field, 'a string');
  if (value.length > maxLength) fail(field, `a string of at most ${maxLength} characters`);
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 4096): string {
  const str = requireString(value, field, maxLength);
  if (str.trim().length === 0) fail(field, 'a non-empty string');
  return str;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 4096,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLength);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, 'a boolean');
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoolean(value, field);
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(field, `one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return requireEnum(value, field, allowed);
}

export function requireStringArray(value: unknown, field: string, maxItems = 1000): string[] {
  if (!Array.isArray(value)) fail(field, 'an array of strings');
  if (value.length > maxItems) fail(field, `an array of at most ${maxItems} items`);
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

export function optionalStringArray(
  value: unknown,
  field: string,
  maxItems = 1000,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringArray(value, field, maxItems);
}

export function optionalEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  maxItems = 100,
): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(field, `an array of: ${allowed.join(', ')}`);
  if (value.length > maxItems) fail(field, `an array of at most ${maxItems} items`);
  return value.map((item, index) => requireEnum(item, `${field}[${index}]`, allowed));
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rejects `undefined`/`null` payloads for channels that declare a `void` request. */
export function expectVoid(value: unknown): void {
  if (value !== undefined && value !== null) {
    throw new ValidationError('This channel does not accept a payload.');
  }
}
