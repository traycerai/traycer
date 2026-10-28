import { useCallback } from "react";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";
import { handPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

/** Capture a bound chat's send before the ordinary pending driver wakes it. */
export function useBoundSandboxSend(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly target: Extract<
    ChatSandboxState,
    { readonly kind: "resting" }
  > | null;
}): (submission: ChatComposerSubmitInput) => boolean {
  const { epicId, chatId, target } = input;
  return useCallback(
    (submission: ChatComposerSubmitInput): boolean => {
      // Without the configuration the wake bills under, nothing is staged and
      // the draft stays until it resolves.
      const configuration = target?.configuration ?? null;
      if (target === null || configuration === null) return false;
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
        configuration,
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
    [chatId, epicId, target],
  );
}
