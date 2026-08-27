import type { Db } from '../connection';
import type { EdgeMetadata, EdgeType, GraphEdge, NodeType } from '@shared/types';
import { parseJson, type EdgeRow } from '../rows';

function mapEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    fromNodeType: row.from_node_type as NodeType,
    fromNodeId: row.from_node_id,
    toNodeType: row.to_node_type as NodeType,
    toNodeId: row.to_node_id,
    edgeType: row.edge_type as EdgeType,
    sourceFileId: row.source_file_id,
    sourceLine: row.source_line,
    metadata: parseJson<EdgeMetadata>(row.metadata_json, {}),
    scanId: row.scan_id,
  };
}

export interface EdgeInsertInput {
  projectId: number;
  fromNodeType: NodeType;
  fromNodeId: string;
  toNodeType: NodeType;
  toNodeId: string;
  edgeType: EdgeType;
  sourceFileId: number | null;
  sourceLine: number | null;
  metadata: EdgeMetadata;
  scanId: number;
}

/** A directed edge reduced to what the traversal algorithms need. */
export interface AdjacencyEdge {
  from: string;
  to: string;
  edgeType: EdgeType;
  unresolved: boolean;
  sourceLine: number | null;
  specifier: string | null;
}

export class EdgeRepository {
  constructor(private readonly db: Db) {}

  insertMany(inputs: EdgeInsertInput[]): void {
    if (inputs.length === 0) return;

    const statement = this.db.prepare(
      `INSERT INTO graph_edges
         (project_id, from_node_type, from_node_id, to_node_type, to_node_id,
          edge_type, source_file_id, source_line, metadata_json, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const run = this.db.transaction((batch: EdgeInsertInput[]) => {
      for (const input of batch) {
        statement.run(
          input.projectId,
          input.fromNodeType,
          input.fromNodeId,
          input.toNodeType,
          input.toNodeId,
          input.edgeType,
          input.sourceFileId,
          input.sourceLine,
          JSON.stringify(input.metadata),
          input.scanId,
        );
      }
    });

    run(inputs);
  }

  /**
   * Removes every edge originating in the given files. Incremental rescans rebuild only the
   * edges declared by files that actually changed; edges pointing *into* those files are owned
   * by their own source files and stay untouched.
   */
  deleteBySourceFileIds(fileIds: number[]): void {
    if (fileIds.length === 0) return;
    const statement = this.db.prepare(`DELETE FROM graph_edges WHERE source_file_id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(id);
    });
    run(fileIds);
  }

  reassignToScan(fileIds: number[], scanId: number): void {
    if (fileIds.length === 0) return;
    const statement = this.db.prepare(`UPDATE graph_edges SET scan_id = ? WHERE source_file_id = ?`);
    const run = this.db.transaction((ids: number[]) => {
      for (const id of ids) statement.run(scanId, id);
    });
    run(fileIds);
  }

  listByProject(projectId: number): GraphEdge[] {
    return this.db
      .prepare<[number], EdgeRow>(`SELECT * FROM graph_edges WHERE project_id = ?`)
      .all(projectId)
      .map(mapEdge);
  }

  /** Compact projection used to build in-memory adjacency lists for traversal. */
  adjacency(projectId: number): AdjacencyEdge[] {
    const rows = this.db
      .prepare<[number], Pick<EdgeRow, 'from_node_id' | 'to_node_id' | 'edge_type' | 'source_line' | 'metadata_json'>>(
        `SELECT from_node_id, to_node_id, edge_type, source_line, metadata_json
         FROM graph_edges WHERE project_id = ?`,
      )
      .all(projectId);

    return rows.map((row) => {
      const metadata = parseJson<EdgeMetadata>(row.metadata_json, {});
      return {
        from: row.from_node_id,
        to: row.to_node_id,
        edgeType: row.edge_type as EdgeType,
        unresolved: metadata.unresolved === true,
        sourceLine: row.source_line,
        specifier: metadata.specifier ?? null,
      };
    });
  }

  listFrom(projectId: number, nodeId: string): GraphEdge[] {
    return this.db
      .prepare<[number, string], EdgeRow>(
        `SELECT * FROM graph_edges WHERE project_id = ? AND from_node_id = ?`,
      )
      .all(projectId, nodeId)
      .map(mapEdge);
  }

  listTo(projectId: number, nodeId: string): GraphEdge[] {
    return this.db
      .prepare<[number, string], EdgeRow>(
        `SELECT * FROM graph_edges WHERE project_id = ? AND to_node_id = ?`,
      )
      .all(projectId, nodeId)
      .map(mapEdge);
  }

  countByProject(projectId: number): number {
    const row = this.db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM graph_edges WHERE project_id = ?`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }

  countUnresolved(projectId: number): number {
    const row = this.db
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM graph_edges
         WHERE project_id = ? AND json_extract(metadata_json, '$.unresolved') = 1`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }
}
