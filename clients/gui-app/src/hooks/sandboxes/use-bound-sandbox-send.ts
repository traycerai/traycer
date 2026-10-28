import { useCallback } from "react";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { handPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

/**
 * Capture a bound chat's send before the ordinary pending driver wakes it.
 *
 * An agent the cloud catalogue says sandboxes don't run is refused here, before
 * anything is staged, so the sandbox is never woken for it - the same check a
 * new sandbox's Send makes (`useStagedSendSignInCheck`). The composer's gate
 * shows that refusal; this is the backstop at the send itself.
 */
export function useBoundSandboxSend(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly target: RestingChatSandbox | null;
}): (submission: ChatComposerSubmitInput) => boolean {
  const { epicId, chatId, target } = input;
  const offeredAgents = useSandboxCatalogue(target !== null).data
    ?.offeredAgents;
  return useCallback(
    (submission: ChatComposerSubmitInput): boolean => {
      if (target === null) return false;
      if (
        offeredAgents !== undefined &&
        !offeredAgents.includes(submission.settings.harnessId)
      )
        return false;
      const userId = useAuthStore.getState().profile?.userId ?? null;
      const held = Object.values(
        usePendingSandboxSendStore.getState().sends,
      ).some(
        (send) =>
          send.epicId === epicId &&
          send.userId === userId &&
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
      useStagedSandboxStore.getState().stage(surfaceKey, {
        kind: "existing",
        hostId: sandbox.hostId,
        sandboxId: sandbox.id,
        name: sandbox.displayName,
        configuration: target.configuration,
        verb: sandbox.state === "stopped" ? "start" : "resume",
      });
      return (
        handPendingSandboxSend({
          fromSurfaceKey: surfaceKey,
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
          content: submission.content,
          text: submission.contentText,
          settings: submission.settings,
          epicConfirmed: true,
          now: Date.now(),
        }) !== null
      );
    },
    [chatId, epicId, offeredAgents, target],
  );
}
