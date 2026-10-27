import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { sandboxRefusalCopyFor } from "@/components/chat/segments/sandbox-refusal-copy";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import type { ChatBotFailedRequest } from "@/components/chat/chat-bot-presentation-context";
import {
  BOT_CONVERSATION_RETRY_VERSION,
  useBotConversationSendMutation,
} from "@/hooks/bots/use-bot-mutations";
import type { BotSessionActivity } from "@/hooks/bots/use-bot-activity";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * Why the bot did not answer a message of one channel or thread, and Retry,
 * Edit and Sign in for it, while the session that failed or parked on it
 * still holds it (`failedOn`). The reason is the session's, in the words the
 * agent chat's error row gives it. Retry sends the message to the bot again as it is: the
 * same request, re-delivered to the session it went to, with no new row.
 * Edit, on the viewer's own message, hands its text to the box (`onEdit`),
 * whose send replaces it. A retry the host refuses says so where a failed
 * send does (`failure`). Neither is offered by a host that cannot do them
 * (`bot.conversation.send` below 1.1).
 */
export function useBotFailedRequest(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  /** The channel; `null` before it is known, when nothing is offered. */
  readonly conversationId: string | null;
  /** The thread the messages were sent in; `null` for the channel's posts. */
  readonly threadId: string | null;
  /** The session that failed or parked answering the request and still holds it, else `null`. */
  readonly failedOn: (requestId: string) => BotSessionActivity | null;
  readonly onEdit: (edit: BotComposerEdit) => void;
  readonly failure: BotSendFailure;
}): (
  requestId: string,
  senderUserId: string | null,
) => ChatBotFailedRequest | null {
  const { client, hostId, botId, conversationId, threadId, failedOn, onEdit } =
    args;
  const { fail, clear } = args.failure;
  const sendVersion = useHostMethodSchemaVersion(
    hostId,
    "bot.conversation.send",
  );
  const supported =
    sendVersion !== null &&
    sendVersion.major === BOT_CONVERSATION_RETRY_VERSION.major &&
    sendVersion.minor >= BOT_CONVERSATION_RETRY_VERSION.minor;
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  const signIn = useProviderSignIn(hostId);
  const { mutate, isPending, variables } =
    useBotConversationSendMutation(client);
  const retryingId = isPending
    ? (variables.redeliver?.requestId ?? null)
    : null;
  return useCallback(
    (
      requestId: string,
      senderUserId: string | null,
    ): ChatBotFailedRequest | null => {
      const session = supported ? failedOn(requestId) : null;
      if (
        conversationId === null ||
        session === null ||
        (session.state !== "failed" && session.state !== "parked")
      ) {
        return null;
      }
      const reason = session.reason;
      return {
        state: session.state,
        // A sandbox's refusal in the words the error row gives it, from the
        // same code and text.
        summary:
          reason === null
            ? null
            : (sandboxRefusalCopyFor(reason.code, reason.summary)
                ?.description ?? reason.summary),
        signIn:
          reason?.action === "sign-in" ? () => signIn(reason.harnessId) : null,
        retry: (text) => {
          clear();
          mutate(
            {
              botId,
              conversationId,
              text,
              threadId,
              announcementId: null,
              redeliver: { requestId },
              supersedes: null,
            },
            { onError: fail },
          );
        },
        retrying: retryingId === requestId,
        edit:
          senderUserId !== null && senderUserId === viewerUserId
            ? (text) => onEdit({ requestId, text })
            : null,
      };
    },
    [
      botId,
      clear,
      conversationId,
      fail,
      failedOn,
      mutate,
      onEdit,
      retryingId,
      signIn,
      supported,
      threadId,
      viewerUserId,
    ],
  );
}

/**
 * Settings ▸ Providers on the bot's host, at the harness that signed the
 * person out, where the agent chat sends them for the same error; the
 * section root when the harness is not one this client knows.
 */
function useProviderSignIn(hostId: string): (harnessId: string) => void {
  const { openSettings } = useSystemTabModalActions();
  return useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      const focus = useProvidersFocusStore.getState();
      if (harness.success) {
        focus.setHostHarnessFocus({ harnessId: harness.data, hostId });
      } else {
        // No earlier action's focus may move Providers off this host.
        focus.clearFocusHarnessId();
      }
      openSettings({
        section: "providers",
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId,
      });
    },
    [openSettings, hostId],
  );
}
