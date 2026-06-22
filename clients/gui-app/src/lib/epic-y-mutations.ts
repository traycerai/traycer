/**
 * Reparent validation + write helpers for the per-Epic Y.Doc.
 *
 * The reparent RULE itself lives in `@/lib/reparent-rules` (`evaluateReparent`)
 * and is shared verbatim with the production write
 * (`OpenEpicState.reparentArtifact`), so the DnD hover/commit pre-flight read
 * and the write can never disagree. This module only adapts that rule into the
 * two shapes used here:
 *   - `canReparent` - read-only result object; DnD hover affordances and the
 *     drag-end commit pre-flight it without touching the store.
 *   - `writeReparent` - validation-equivalent stand-alone write for the
 *     reparent unit-test suite. Production GUI code goes through
 *     `epicHandle.store.getState().reparentArtifact(id, parentId)` so the
 *     `LOCAL_ORIGIN` transaction marker matches every other local edit.
 */
import * as Y from "yjs";
import {
  evaluateReparent,
  reparentRejectionError,
  type ReparentRejectionReason,
} from "@/lib/reparent-rules";

export type CanReparentResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ReparentRejectionReason;
    };

export function canReparent(
  doc: Y.Doc,
  nodeId: string,
  newParentId: string | null,
): CanReparentResult {
  const evaluation = evaluateReparent(doc, nodeId, newParentId);
  return evaluation.ok
    ? { ok: true }
    : { ok: false, reason: evaluation.reason };
}

interface WriteReparentArgs {
  readonly doc: Y.Doc;
  readonly nodeId: string;
  readonly newParentId: string | null;
}

/**
 * Validation-equivalent stand-alone reparent for the unit-test suite.
 * Production GUI code goes through `OpenEpicState.reparentArtifact`.
 */
export function writeReparent(args: WriteReparentArgs): boolean {
  const { doc, nodeId, newParentId } = args;
  let mutated = false;
  const pendingErrors: Error[] = [];

  doc.transact(() => {
    const evaluation = evaluateReparent(doc, nodeId, newParentId);
    if (!evaluation.ok) {
      if (evaluation.reason === "same-parent") return; // no-op, no throw
      pendingErrors.push(
        reparentRejectionError(doc, evaluation.reason, nodeId, newParentId),
      );
      return;
    }
    evaluation.node.entry.set("parentId", newParentId);
    evaluation.node.entry.set("updatedAt", Date.now());
    mutated = true;
  }, "local");

  if (pendingErrors.length > 0) throw pendingErrors[0];
  return mutated;
}
