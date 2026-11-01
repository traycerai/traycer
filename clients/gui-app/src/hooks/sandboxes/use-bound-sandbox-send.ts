import { useCallback } from "react";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxTraycerModels } from "@/hooks/sandboxes/use-sandbox-traycer-models-query";
import { traycerModelRefused } from "@/lib/sandboxes/sandbox-agent-refusal";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { handPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readStagedWorktreeIntent } from "@/stores/worktree/worktree-intent-staging-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

/**
 * Capture a bound chat's send before the ordinary pending driver wakes it.
 *
 * An agent the cloud catalogue says sandboxes don't run, or a Traycer model
 * their list leaves out, is refused here, before anything is staged, so the
 * sandbox is never woken for it - the same check a new sandbox's Send makes
 * (`useStagedSendSignInCheck`). So is every send while
 * there is no catalogue to check against (still reading, or a read that
 * failed); an older server's catalogue that names no agents lets it through.
 * The composer's gate shows those refusals; this is the backstop at the send
 * itself.
 */
export function useBoundSandboxSend(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly target: RestingChatSandbox | null;
}): (submission: ChatComposerSubmitInput) => boolean {
  const { epicId, chatId, target } = input;
  const catalogue = useSandboxCatalogue(target !== null).data;
  const traycerModels = useSandboxTraycerModels(target !== null).data;
  return useCallback(
    (submission: ChatComposerSubmitInput): boolean => {
      if (target === null || catalogue === undefined) return false;
      const offeredAgents = catalogue.offeredAgents;
      if (
        offeredAgents !== undefined &&
        !offeredAgents.includes(submission.settings.harnessId)
      )
        return false;
      if (
        submission.settings.harnessId === "traycer" &&
        traycerModelRefused(traycerModels, submission.settings.model)
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
    [catalogue, chatId, epicId, target, traycerModels],
  );
}
