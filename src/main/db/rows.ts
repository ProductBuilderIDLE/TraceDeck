/** Row shapes as SQLite returns them, plus helpers for the JSON and boolean columns. */

export interface ProjectRow {
  id: number;
  name: string;
  root_path: string;
  created_at: string;
  last_opened_at: string | null;
  last_scan_at: string | null;
  configuration_json: string;
}

export interface ScanRow {
  id: number;
  project_id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  git_commit: string | null;
  total_files: number;
  parsed_files: number;
  error_count: number;
  summary_json: string | null;
}

export interface FileRow {
  id: number;
  project_id: number;
  relative_path: string;
  absolute_path: string;
  extension: string;
  content_hash: string;
  modified_at: string;
  is_entry_point: number;
  scan_id: number;
}

export interface SymbolRow {
  id: number;
  project_id: number;
  file_id: number;
  name: string;
  kind: string;
  is_exported: number;
  is_default_export: number;
  start_line: number;
  end_line: number;
  metadata_json: string;
  scan_id: number;
}

export interface EdgeRow {
  id: number;
  project_id: number;
  from_node_type: string;
  from_node_id: string;
  to_node_type: string;
  to_node_id: string;
  edge_type: string;
  source_file_id: number | null;
  source_line: number | null;
  metadata_json: string;
  scan_id: number;
}

export interface FindingRow {
  id: number;
  project_id: number;
  scan_id: number;
  finding_type: string;
  severity: string;
  title: string;
  description: string;
  related_node_ids_json: string;
  details_json: string;
  fingerprint: string;
  created_at: string;
  dismissed_at: string | null;
}

export interface RuleRow {
  id: number;
  project_id: number;
  name: string;
  enabled: number;
  rule_type: string;
  source_pattern: string;
  target_pattern: string;
  configuration_json: string;
  created_at: string;
  updated_at: string;
}

export interface ReportRow {
  id: number;
  project_id: number;
  name: string;
  report_type: string;
  configuration_json: string;
  created_at: string;
}

/**
 * Persisted JSON is written by this app, but a truncated write or a hand-edited database
 * should degrade to a default rather than crash the process on open.
 */
export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export function toBool(value: number | null | undefined): boolean {
  return value === 1;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
