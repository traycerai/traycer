import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import type { DraftAuthorityCanvasScope } from "@/lib/drafts/draft-authority-sidecar";
import type { DraftAuthorityActor, DraftAuthorityVersion } from "@/lib/drafts/draft-authority-types";
import { readScopedCanvasAssets } from "@/lib/drafts/scoped-canvas-assets";
import { captureNativeChatCanvasAssets } from "@/stores/composer/composer-draft-store";

export interface ProtectedChatCanvasCapture {
  readonly draft: DraftAuthorityVersion;
  readonly scope: DraftAuthorityCanvasScope;
  readonly sidecarVersion: string;
}

export function protectedChatCanvasCaptureIsCurrent(
  actor: DraftAuthorityActor,
  captured: ProtectedChatCanvasCapture,
): boolean {
  if (!draftAuthorityActorIsCurrent(actor)) return false;
  const current = captureNativeChatCanvasAssets(captured.draft.slot.id, actor);
  return current.kind === "protected" &&
    current.draft.slot.kind === captured.draft.slot.kind &&
    current.draft.occurrence === captured.draft.occurrence &&
    current.draft.version === captured.draft.version &&
    current.scope.kind === captured.scope.kind &&
    current.scope.id === captured.scope.id &&
    current.sidecarVersion === captured.sidecarVersion;
}

export async function readProtectedChatCanvasImages(
  actor: DraftAuthorityActor,
  captured: ProtectedChatCanvasCapture,
): Promise<ReadonlyMap<string, Blob> | null> {
  if (!protectedChatCanvasCaptureIsCurrent(actor, captured)) return null;
  const result = await readScopedCanvasAssets({
    actor,
    draft: captured.draft,
    scope: captured.scope,
  });
  return result.kind === "current" &&
    result.sidecar.version === captured.sidecarVersion &&
    protectedChatCanvasCaptureIsCurrent(actor, captured)
    ? result.bytes
    : null;
}
