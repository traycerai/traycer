/**
 * Thrown when a reparent would form a cycle (the proposed new parent is
 * the node itself or one of its descendants).
 */
export class ReparentCycleError extends Error {
  constructor(nodeId: string, newParentId: string) {
    super(
      `Cannot reparent ${nodeId} under ${newParentId}: target is the node itself or a descendant.`,
    );
    this.name = "ReparentCycleError";
  }
}
