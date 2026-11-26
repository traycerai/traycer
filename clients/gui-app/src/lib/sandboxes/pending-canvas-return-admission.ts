import {
  readDraftAuthoritySlot,
  subscribeToDraftAuthorityChanges,
} from "@/lib/drafts/draft-authority";
import {
  subscribeToCanonicalChatCanvasAcknowledgements,
  type DraftAuthorityCanvasScope,
} from "@/lib/drafts/draft-authority-sidecar";
import {
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import type { DraftAuthorityActor } from "@/lib/drafts/draft-authority-types";
import { nativeComposerCanvasScope } from "@/stores/composer/composer-canvas-persistence";

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
const listeners = new Map<string, Set<() => void>>();

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
  const currentScope = nativeComposerCanvasScope();
  const key = keyFor({ accountId: actor.accountId, chatId, hostId });
  return (
    currentScope !== null &&
    currentScope.kind === scope.kind &&
    currentScope.id === scope.id &&
    draftAuthorityActorIsCurrent(actor) &&
    admissions.get(key)?.has(entry) === true
  );
}

export function subscribeToPendingCanvasAdmission(
  binding: AdmissionKey,
  listener: () => void,
): () => void {
  const key = keyFor(binding);
  const current = listeners.get(key) ?? new Set<() => void>();
  const notify = () => listener();
  current.add(notify);
  listeners.set(key, current);
  return () => {
    if (current.delete(notify) && current.size === 0) listeners.delete(key);
  };
}

export function registerPendingCanvasReturnAdmission(
  actor: DraftAuthorityActor,
  chatId: string,
  hostId: string,
): () => void {
  const scope = nativeComposerCanvasScope();
  if (scope === null || !draftAuthorityActorIsCurrent(actor)) {
    return () => undefined;
  }
  const key = keyFor({ accountId: actor.accountId, chatId, hostId });
  const entry = { actor, scope, chatId, hostId };
  const mounted = admissions.get(key) ?? new Set<MountedCanvasReturnAdmission>();
  mounted.add(entry);
  admissions.set(key, mounted);
  const signal = (): void => {
    for (const listener of listeners.get(key) ?? []) listener();
  };

  let epoch = 0;
  let stopSidecar: (() => void) | null = null;
  const bindSidecar = (): void => {
    const expected = ++epoch;
    void readDraftAuthoritySlot({ kind: "chat", id: chatId })
      .then((read) => {
        if (
          expected !== epoch ||
          !pendingCanvasReturnAdmissionIsCurrent(entry)
        ) {
          return;
        }
        stopSidecar?.();
        stopSidecar =
          read.kind === "current" && read.record.kind === "live"
            ? subscribeToCanonicalChatCanvasAcknowledgements(
                { actor, reference: read.record.draft, scope },
                signal,
              )
            : null;
        signal();
      })
      .catch(() => undefined);
  };
  const stopSlot = subscribeToDraftAuthorityChanges((slot) => {
    if (slot.kind === "chat" && slot.id === chatId) bindSidecar();
  });
  const stopSession = subscribeToDraftAuthoritySessionChanges(signal);
  bindSidecar();
  signal();
  return () => {
    if (!mounted.delete(entry)) return;
    if (mounted.size === 0) admissions.delete(key);
    epoch += 1;
    stopSidecar?.();
    stopSlot();
    stopSession();
    signal();
  };
}
