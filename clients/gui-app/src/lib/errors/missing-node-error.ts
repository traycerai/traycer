/**
 * Thrown when a node (or its proposed new parent) referenced by a
 * tree-mutation operation is absent from the underlying Y.Doc.
 */
export class MissingNodeError extends Error {
  constructor(missingId: string, role: "node" | "parent") {
    super(`Reparent target missing: ${role}=${missingId} not found in epic.`);
    this.name = "MissingNodeError";
  }
}
