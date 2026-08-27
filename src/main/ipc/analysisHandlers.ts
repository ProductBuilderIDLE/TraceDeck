import type { EdgeType, FindingType, NodeType } from '@shared/types';
import { DEFAULT_MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH } from '@shared/constants';
import { parseNodeId } from '@shared/nodeIds';
import type { DataStore } from '../db';
import type { AnalysisService } from '../services/analysisService';
import {
  asObject,
  clampInt,
  optionalBoolean,
  optionalEnum,
  optionalEnumArray,
  optionalInt,
  optionalString,
  requireBoolean,
  requireInt,
  requireNonEmptyString,
} from '../utils/validation';
import { HandledError, type HandlerMap } from './registry';

const NODE_TYPES: readonly NodeType[] = ['file', 'symbol', 'folder'];
const EDGE_TYPES: readonly EdgeType[] = [
  'import',
  'export',
  're-export',
  'dynamic-import',
  'require',
  'reference',
];
const FINDING_TYPES: readonly FindingType[] = [
  'circular-dependency',
  'unused-export-candidate',
  'architecture-violation',
  'unresolved-import',
  'type-error',
];

/** Rejects node ids that are not one of the three shapes the graph uses. */
function requireNodeId(value: unknown, field: string): string {
  const nodeId = requireNonEmptyString(value, field, 2048);
  if (!parseNodeId(nodeId)) {
    throw new HandledError(`"${field}" is not a valid graph node id.`, 'INVALID_NODE_ID');
  }
  return nodeId;
}

function requireProject(store: DataStore, projectId: number) {
  const project = store.projects.findById(projectId);
  if (!project) throw new HandledError('That project no longer exists.', 'NOT_FOUND');
  return project;
}

export function analysisHandlers(store: DataStore, analysis: AnalysisService): HandlerMap {
  return {
    'dashboard:stats': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      return analysis.dashboardStats(requireProject(store, projectId));
    },

    'graph:query': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);

      const focusNodeId = optionalString(value['focusNodeId'], 'focusNodeId', 2048);

      return analysis.graph({
        projectId,
        ...(focusNodeId ? { focusNodeId: requireNodeId(focusNodeId, 'focusNodeId') } : {}),
        focusDepth: clampInt(optionalInt(value['focusDepth'], 'focusDepth', 1) ?? 2, 1, 10),
        nodeTypes: optionalEnumArray(value['nodeTypes'], 'nodeTypes', NODE_TYPES),
        edgeTypes: optionalEnumArray(value['edgeTypes'], 'edgeTypes', EDGE_TYPES),
        folderPrefix: optionalString(value['folderPrefix'], 'folderPrefix', 1024),
        includeUnresolved: optionalBoolean(value['includeUnresolved'], 'includeUnresolved'),
        nodeLimit: optionalInt(value['nodeLimit'], 'nodeLimit', 1),
      });
    },

    'graph:blast-radius': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);

      const maxDepth = clampInt(
        optionalInt(value['maxDepth'], 'maxDepth', 1) ?? DEFAULT_MAX_TRAVERSAL_DEPTH,
        1,
        MAX_TRAVERSAL_DEPTH,
      );

      return analysis.blastRadius({
        projectId,
        nodeId: requireNodeId(value['nodeId'], 'nodeId'),
        maxDepth,
        edgeTypes: optionalEnumArray(value['edgeTypes'], 'edgeTypes', EDGE_TYPES),
        includeUnresolved: optionalBoolean(value['includeUnresolved'], 'includeUnresolved'),
      });
    },

    'graph:risk-score': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);
      return analysis.riskScore(projectId, requireNodeId(value['nodeId'], 'nodeId'));
    },

    'graph:file-detail': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);

      const detail = analysis.fileDetail(projectId, requireNodeId(value['nodeId'], 'nodeId'));
      if (!detail) throw new HandledError('That file is not part of the last scan.', 'NOT_FOUND');
      return detail;
    },

    'search:query': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);

      return analysis.search({
        projectId,
        query: requireNonEmptyString(value['query'], 'query', 256),
        types: optionalEnumArray(value['types'], 'types', NODE_TYPES),
        limit: optionalInt(value['limit'], 'limit', 1),
      });
    },

    'findings:list': async (payload) => {
      const value = asObject(payload);
      const projectId = requireInt(value['projectId'], 'projectId', 1);
      requireProject(store, projectId);

      return store.findings.list(projectId, {
        findingType: optionalEnum(value['findingType'], 'findingType', FINDING_TYPES),
        includeDismissed: optionalBoolean(value['includeDismissed'], 'includeDismissed'),
      });
    },

    'findings:dismiss': async (payload) => {
      const value = asObject(payload);
      const findingId = requireInt(value['findingId'], 'findingId', 1);
      const dismissed = requireBoolean(value['dismissed'], 'dismissed');

      return { updated: store.findings.setDismissed(findingId, dismissed) };
    },
  };
}
