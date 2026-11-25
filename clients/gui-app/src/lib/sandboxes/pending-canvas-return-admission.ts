import {
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import type { DraftAuthorityCanvasScope } from "@/lib/drafts/draft-authority-sidecar";
import type { DraftAuthorityActor } from "@/lib/drafts/draft-authority-types";
import { desktopComposerCanvasScope } from "@/stores/composer/composer-canvas-persistence";

interface AdmissionKey {
  readonly accountId: string;
  readonly chatId: string;
  readonly hostId: string;
}

export interface MountedCanvasReturnAdmission {
  readonly actor: DraftAuthorityActor;
  readonly chatId: string;
  readonly hostId: string;
  readonly scope: DraftAuthorityCanvasScope;
}

const admissions = new Map<string, Set<MountedCanvasReturnAdmission>>();

function keyFor(binding: AdmissionKey): string {
  return JSON.stringify([binding.accountId, binding.hostId, binding.chatId]);
}

export function readPendingCanvasReturnAdmission(
  actor: DraftAuthorityActor,
  chatId: string,
  hostId: string,
): MountedCanvasReturnAdmission | null {
  if (!draftAuthorityActorIsCurrent(actor)) return null;
  const key = keyFor({ accountId: actor.accountId, chatId, hostId });
  for (const entry of admissions.get(key) ?? []) {
    if (
      entry.actor.sessionGeneration === actor.sessionGeneration &&
      pendingCanvasReturnAdmissionIsCurrent(entry)
    ) {
      return entry;
    }
  }
  return null;
}

export function pendingCanvasReturnAdmissionIsCurrent(
  entry: MountedCanvasReturnAdmission,
): boolean {
  const { actor, chatId, hostId, scope } = entry;
  const currentScope = desktopComposerCanvasScope();
  const key = keyFor({ accountId: actor.accountId, chatId, hostId });
  return (
    currentScope !== null &&
    currentScope.kind === scope.kind &&
    currentScope.id === scope.id &&
    draftAuthorityActorIsCurrent(actor) &&
    admissions.get(key)?.has(entry) === true
  );
}

export function registerPendingCanvasReturnAdmission(
  actor: DraftAuthorityActor,
  chatId: string,
  hostId: string,
): () => void {
  const scope = desktopComposerCanvasScope();
  if (scope === null || !draftAuthorityActorIsCurrent(actor)) {
    return () => undefined;
  }
  const key = keyFor({ accountId: actor.accountId, chatId, hostId });
  const entry = { actor, scope, chatId, hostId };
  const mounted = admissions.get(key) ?? new Set<MountedCanvasReturnAdmission>();
  mounted.add(entry);
  admissions.set(key, mounted);
  return () => {
    if (!mounted.delete(entry)) return;
    if (mounted.size === 0) admissions.delete(key);
  };
}
