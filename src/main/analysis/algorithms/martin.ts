export interface FolderCouplingInput {
  fromPath: string;
  toPath: string;
}

export interface FolderComposition {
  folder: string;
  fileCount: number;
  abstractFileCount: number;
}

export interface MartinMetrics {
  folder: string;
  fileCount: number;
  afferent: number;
  efferent: number;
  instability: number;
  abstractness: number;
}

function folderOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  if (slash <= 0) return relativePath.includes('/') ? relativePath.slice(0, slash) : '.';
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.';
}

/**
 * Computes Martin instability (Ce / (Ca + Ce)) and abstractness (abstract files / files)
 * per top-level-ish folder. Edges inside the same folder are ignored.
 */
export function computeMartinMetrics(
  edges: readonly FolderCouplingInput[],
  composition: readonly FolderComposition[],
): MartinMetrics[] {
  const afferent = new Map<string, number>();
  const efferent = new Map<string, number>();

  for (const edge of edges) {
    const from = folderOf(edge.fromPath);
    const to = folderOf(edge.toPath);
    if (from === to) continue;
    efferent.set(from, (efferent.get(from) ?? 0) + 1);
    afferent.set(to, (afferent.get(to) ?? 0) + 1);
  }

  const folders = new Map<string, FolderComposition>();
  for (const entry of composition) folders.set(entry.folder, entry);

  for (const folder of [...afferent.keys(), ...efferent.keys()]) {
    if (!folders.has(folder)) folders.set(folder, { folder, fileCount: 0, abstractFileCount: 0 });
  }

  return [...folders.values()]
    .map((entry) => {
      const ca = afferent.get(entry.folder) ?? 0;
      const ce = efferent.get(entry.folder) ?? 0;
      const denom = ca + ce;
      return {
        folder: entry.folder,
        fileCount: entry.fileCount,
        afferent: ca,
        efferent: ce,
        instability: denom === 0 ? 0 : ce / denom,
        abstractness: entry.fileCount === 0 ? 0 : entry.abstractFileCount / entry.fileCount,
      };
    })
    .sort((left, right) => left.folder.localeCompare(right.folder));
}
