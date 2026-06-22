/**
 * Thrown when a reparent tries to nest an artifact under a chat/agent, or a
 * chat/agent under an artifact.
 */
export class CrossFamilyParentError extends Error {
  constructor(nodeId: string, newParentId: string) {
    super(
      `Cannot reparent ${nodeId} under ${newParentId}: nodes belong to different tree families.`,
    );
    this.name = "CrossFamilyParentError";
  }
}
