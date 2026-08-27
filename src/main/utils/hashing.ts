import { createHash } from 'node:crypto';

/**
 * Content hashes drive incremental rescans: a file whose hash and mtime both match the stored
 * values is not re-parsed. SHA-256 is used rather than a faster non-cryptographic hash because
 * a collision here would silently skip a changed file and produce a wrong graph.
 */
export function hashContent(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

const FINGERPRINT_SEPARATOR = '\u0000';

/** Stable identity for a finding across scans, so dismissals survive a rescan. */
export function fingerprint(...parts: Array<string | number | null | undefined>): string {
  // A NUL separator cannot occur in a path or symbol name, so two different part lists can
  // never join into the same string.
  const joined = parts
    .map((part) => (part === null || part === undefined ? '' : String(part)))
    .join(FINGERPRINT_SEPARATOR);
  return createHash('sha256').update(joined).digest('hex').slice(0, 32);
}
