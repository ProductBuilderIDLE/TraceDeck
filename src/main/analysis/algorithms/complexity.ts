/** Decision-point count plus one, matching the classic McCabe definition. */
export function cyclomaticFromDecisions(decisionPoints: number): number {
  return Math.max(1, decisionPoints + 1);
}

export const COMPLEXITY_HOTSPOT_THRESHOLD = 10;
