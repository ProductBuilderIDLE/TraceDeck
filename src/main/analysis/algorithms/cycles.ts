import type { GraphIndex } from './graphIndex';

export interface CycleEdge {
  from: string;
  to: string;
  line: number | null;
  specifier: string | null;
}

export interface DetectedCycle {
  /** Node ids in the strongly connected component, in a stable traversal order. */
  nodes: string[];
  /** A concrete walk through the component that returns to its starting node. */
  path: string[];
  edges: CycleEdge[];
}

/**
 * Tarjan's strongly connected components algorithm, written iteratively.
 *
 * A recursive implementation overflows the call stack on real repositories — a deep import
 * chain is thousands of frames — so the DFS state is kept on an explicit stack instead.
 *
 * Only components with two or more nodes are reported. A node that imports itself is a
 * degenerate self-loop, not the kind of cycle a developer needs to break, so it is excluded
 * unless it participates in a larger component.
 */
export function findStronglyConnectedComponents(index: GraphIndex): string[][] {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  let nextIndex = 0;

  interface Frame {
    node: string;
    successors: string[];
    position: number;
  }

  // Sorting makes component discovery order deterministic across runs.
  for (const start of [...index.nodeIds].sort()) {
    if (indices.has(start)) continue;

    const frames: Frame[] = [
      { node: start, successors: [...index.dependenciesOf(start)].sort(), position: 0 },
    ];

    indices.set(start, nextIndex);
    lowLinks.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as Frame;

      if (frame.position < frame.successors.length) {
        const successor = frame.successors[frame.position] as string;
        frame.position += 1;

        if (!indices.has(successor)) {
          indices.set(successor, nextIndex);
          lowLinks.set(successor, nextIndex);
          nextIndex += 1;
          stack.push(successor);
          onStack.add(successor);
          frames.push({
            node: successor,
            successors: [...index.dependenciesOf(successor)].sort(),
            position: 0,
          });
        } else if (onStack.has(successor)) {
          const current = lowLinks.get(frame.node) as number;
          lowLinks.set(frame.node, Math.min(current, indices.get(successor) as number));
        }
        continue;
      }

      // Every successor of this node has been explored.
      frames.pop();

      if (lowLinks.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop() as string;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);

        if (component.length > 1) {
          components.push(component.sort());
        }
      }

      const parent = frames[frames.length - 1];
      if (parent) {
        const parentLow = lowLinks.get(parent.node) as number;
        lowLinks.set(parent.node, Math.min(parentLow, lowLinks.get(frame.node) as number));
      }
    }
  }

  return components.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

/**
 * Finds a concrete cycle inside a strongly connected component so the UI can show a readable
 * "a imports b imports c imports a" chain rather than an unordered set of files.
 */
function traceCyclePath(component: readonly string[], index: GraphIndex): string[] {
  const members = new Set(component);
  const start = component[0] as string;

  const previous = new Map<string, string>();
  const queue: string[] = [start];
  const visited = new Set<string>([start]);

  while (queue.length > 0) {
    const current = queue.shift() as string;

    for (const next of [...index.dependenciesOf(current)].sort()) {
      if (!members.has(next)) continue;

      if (next === start) {
        const path = [current];
        let cursor = current;
        while (previous.has(cursor)) {
          cursor = previous.get(cursor) as string;
          path.push(cursor);
        }
        path.reverse();
        return [...path, start];
      }

      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }

  return [...component, start];
}

export function detectCycles(index: GraphIndex): DetectedCycle[] {
  return findStronglyConnectedComponents(index).map((component) => {
    const path = traceCyclePath(component, index);
    const edges: CycleEdge[] = [];

    for (let position = 0; position < path.length - 1; position += 1) {
      const from = path[position] as string;
      const to = path[position + 1] as string;
      const edge = index.edgesFrom(from).find((candidate) => candidate.to === to);
      edges.push({
        from,
        to,
        line: edge?.sourceLine ?? null,
        specifier: edge?.specifier ?? null,
      });
    }

    return { nodes: component, path, edges };
  });
}

/** Node ids that take part in any cycle, for highlighting and risk scoring. */
export function nodesInCycles(cycles: readonly DetectedCycle[]): Set<string> {
  const result = new Set<string>();
  for (const cycle of cycles) {
    for (const node of cycle.nodes) result.add(node);
  }
  return result;
}
