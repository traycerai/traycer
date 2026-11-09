import {
  settleFileNodeInContent,
  type FileNodeSettlement,
} from "@/lib/composer/file-attachments";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";

/**
 * Settles a file node in a landing draft's runtime, for an upload that
 * finished after its composer stopped showing that draft. A draft the runtime
 * cannot hydrate, or one no longer holding the node, is left as it is.
 */
export function settleFileNodeInLandingDraft(
  draftId: string | null,
  nodeId: string,
  settlement: FileNodeSettlement,
): void {
  const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
  if (runtime === null) return;
  const { content, selection } = runtime.store.getState();
  const next = settleFileNodeInContent(content, nodeId, settlement);
  if (next !== null) runtime.setSnapshot(next, selection);
}
