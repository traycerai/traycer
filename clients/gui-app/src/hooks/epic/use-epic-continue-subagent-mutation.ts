import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ContinueSubagentRefusalReason } from "@traycer/protocol/host/epic/unary-schemas";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { invalidateEpicChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";

/**
 * What each refusal says. The host's `detail` rides under it: the reason is
 * what happened, the detail is which record it happened to.
 */
const REFUSAL_COPY: Record<ContinueSubagentRefusalReason, string> = {
  unsupported_harness:
    "Only Codex and Claude subagents can be continued as a chat.",
  block_not_subagent: "This subagent can't be continued as a chat.",
  still_running: "This subagent is still running. Try again when it finishes.",
  session_unreadable: "Couldn't read this subagent's conversation.",
  creation_failed: "Couldn't create the chat.",
};

interface ContinueSubagentMutationContext {
  readonly hostId: string;
}

/**
 * Mutation hook for `epic.continueSubagent`: one native subagent's
 * conversation carried on as a chat of its own.
 *
 * Sent to the TAB's host, never the app-wide one: the subagent ran where its
 * parent chat runs, and only that host holds its session.
 *
 * A refusal is a successful response, so it is worded here, in `onSuccess`;
 * the caller's own `onSuccess` opens the chat for the other two kinds.
 */
export function useEpicContinueSubagent() {
  const client = useTabHostClient();
  const hostId = useTabHostId();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.continueSubagent",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.continueSubagent(),
      // The host the request is SENT to, captured before it goes: the answer
      // is about that host's registry whatever the tab does meanwhile.
      onMutate: (): ContinueSubagentMutationContext => ({ hostId }),
      onSuccess: (
        response,
        _variables,
        ctx: ContinueSubagentMutationContext,
      ) => {
        if (response.kind === "refused") {
          toast.error(REFUSAL_COPY[response.reason], {
            description:
              response.detail.length > 0 ? response.detail : undefined,
          });
          return;
        }
        // The chat landed in the host's chat database and in nothing this
        // renderer listens to. A tile for it waits on its record, so without
        // this re-read it sits on its loading state until a poll delivers
        // one. `existing` too: the first request's answer may never have
        // reached this renderer.
        invalidateEpicChatRecords(queryClient, ctx.hostId);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't continue this subagent as a chat.");
      },
    },
  });
}
