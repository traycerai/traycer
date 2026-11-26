import { readCanonicalChatCanvasAssets } from "@/lib/drafts/draft-authority-sidecar";
import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import { nativeComposerCanvasScope } from "@/stores/composer/composer-canvas-persistence";

type ScopedCanvasAssetRead = Parameters<typeof readCanonicalChatCanvasAssets>[0];

function canvasReadIsCurrent({
  actor,
  draft,
  scope,
}: ScopedCanvasAssetRead): boolean {
  const currentScope = nativeComposerCanvasScope();
  return (
    draft.slot.kind === "chat" &&
    currentScope !== null &&
    currentScope.kind === scope.kind &&
    currentScope.id === scope.id &&
    draftAuthorityActorIsCurrent(actor)
  );
}

/** Protected previews and send preparation read rooted assets from this scope. */
export async function readScopedCanvasAssets(request: ScopedCanvasAssetRead) {
  if (!canvasReadIsCurrent(request)) return { kind: "denied" } as const;
  const result = await readCanonicalChatCanvasAssets(request);
  if (
    !canvasReadIsCurrent(request) ||
    (result.kind === "current" &&
      result.sidecar.accountId !== request.actor.accountId)
  ) {
    return { kind: "denied" } as const;
  }
  return result;
}
