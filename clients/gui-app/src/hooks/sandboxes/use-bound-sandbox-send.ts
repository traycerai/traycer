import { useCallback, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { draftStorageRefusalPresentation } from "@/lib/drafts/draft-storage-refusal";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { handPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "@/lib/drafts/draft-authority-session";
import {
  flushCanonicalChatDraft,
  projectCanonicalChatDeletion,
  readComposerDraftSnapshot,
} from "@/stores/composer/composer-draft-store";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

/**
 * Capture a bound chat's send before the ordinary pending driver wakes it.
 *
 * An agent the cloud catalogue says sandboxes don't run is refused here, before
 * anything is staged, so the sandbox is never woken for it - the same check a
 * new sandbox's Send makes (`useStagedSendSignInCheck`). So is every send while
 * there is no catalogue to check against (still reading, or a read that
 * failed); an older server's catalogue that names no agents lets it through.
 * The composer's gate shows those refusals; this is the backstop at the send
 * itself.
 */
export function useBoundSandboxSend(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly target: RestingChatSandbox | null;
}): (submission: ChatComposerSubmitInput) => Promise<boolean> {
  const { epicId, chatId, target } = input;
  const catalogue = useSandboxCatalogue(target !== null).data;
  const currentTarget = useRef(target);
  useLayoutEffect(() => {
    currentTarget.current = target;
    return () => {
      currentTarget.current = null;
    };
  }, [target]);
  return useCallback(
    async (submission: ChatComposerSubmitInput): Promise<boolean> => {
      if (target === null || catalogue === undefined) return false;
      const offeredAgents = catalogue.offeredAgents;
      if (
        offeredAgents !== undefined &&
        !offeredAgents.includes(submission.settings.harnessId)
      )
        return false;
      const actor = captureDraftAuthorityActor();
      if (actor === null) return false;
      const revision = readComposerDraftSnapshot(chatId).revision;
      const held = Object.values(
        usePendingSandboxSendStore.getState().sends,
      ).some(
        (send) =>
          send.epicId === epicId &&
          send.userId === actor.accountId &&
          send.request.kind === "message" &&
          send.request.chatId === chatId &&
          send.delivery === null,
      );
      if (held) return false;
      const { sandbox } = target;
      const surfaceKey = JSON.stringify([
        "bound-sandbox-send",
        sandbox.hostId,
        epicId,
        chatId,
      ]);
      const source = await flushCanonicalChatDraft(chatId);
      if (
        !draftAuthorityActorIsCurrent(actor) ||
        currentTarget.current?.sandbox.id !== sandbox.id ||
        currentTarget.current.sandbox.hostId !== sandbox.hostId ||
        readComposerDraftSnapshot(chatId).revision !== revision
      ) return false;
      if (source.kind === "unavailable") {
        const presentation = draftStorageRefusalPresentation("staged-send");
        if (presentation.kind === "composer-failure")
          toast.error(presentation.title, { description: presentation.description });
      }
      if (source.kind !== "committed") return false;
      if (readStagedSandbox(surfaceKey) === null) {
        useStagedSandboxStore.getState().stage(surfaceKey, {
          kind: "existing",
          hostId: sandbox.hostId,
          sandboxId: sandbox.id,
          name: sandbox.displayName,
          configuration: target.configuration,
          verb: sandbox.state === "stopped" ? "start" : "resume",
        });
      }
      const handed = await handPendingSandboxSend({
        fromSurfaceKey: surfaceKey,
        actor,
        source: source.draft,
        epicId,
        request: {
          kind: "message",
          chatId,
          hostId: sandbox.hostId,
          worktreeIntent: readStagedWorktreeIntent({
            surface: "owner",
            hostId: sandbox.hostId,
            epicId,
            ownerKind: "chat",
            ownerId: chatId,
          }),
          browserAnnotations: submission.restore.browserAnnotations,
          deliveryPolicy: submission.deliveryPolicy,
        },
        content: submission.restore.browserAnnotations.length === 0
          ? submission.content
          : submission.restore.content,
        ...(submission.restore.browserAnnotations.length === 0
          ? {}
          : { submittedContent: submission.content }),
        text: submission.contentText,
        settings: submission.settings,
        epicConfirmed: true,
        now: Date.now(),
      });
      if (handed === null || !draftAuthorityActorIsCurrent(actor)) return false;
      submission.onOutboxCustody?.();
      if (handed.consumed !== null)
        void projectCanonicalChatDeletion(handed.consumed);
      return true;
    },
    [catalogue, chatId, epicId, target],
  );
}
