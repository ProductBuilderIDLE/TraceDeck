export interface FingerprintRecord {
  fingerprint: string;
  title: string;
}

export interface ScanCompareResult {
  added: FingerprintRecord[];
  removed: FingerprintRecord[];
  persisted: number;
}

/** Diffs two scan fingerprint lists by identity, independent of title edits. */
export function compareFingerprints(
  previous: readonly FingerprintRecord[],
  current: readonly FingerprintRecord[],
): ScanCompareResult {
  const previousById = new Map(previous.map((record) => [record.fingerprint, record]));
  const currentById = new Map(current.map((record) => [record.fingerprint, record]));

  const added: FingerprintRecord[] = [];
  const removed: FingerprintRecord[] = [];
  let persisted = 0;

  for (const record of current) {
    if (previousById.has(record.fingerprint)) persisted += 1;
    else added.push(record);
  }
  for (const record of previous) {
    if (!currentById.has(record.fingerprint)) removed.push(record);
  }

  return { added, removed, persisted };
}
