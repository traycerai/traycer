import { useCallback } from "react";
import { toast } from "sonner";
import { isTeamSandboxHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { toastFromHostError } from "@/lib/host-error-toast";
import { chatContinueMutationKeys } from "@/lib/query-keys";

/**
 * Whether the chat's own host is gone for good, as far as this device can
 * tell: no longer in the directory at all (a destroyed sandbox's host is
 * revoked), or a sandbox the server has destroyed or failed. The server's own
 * row is what the continue is decided on; this only chooses which action the
 * dead tile offers.
 */
function sourceIsRemoved(entry: HostDirectoryEntry | null): boolean {
  if (entry === null) return true;
  if (!isRemoteHostDirectoryEntry(entry) || entry.sandbox === null) {
    return false;
  }
  return (
    entry.sandbox.state === "destroyed" || entry.sandbox.state === "failed"
  );
}

/**
 * Continue a removed team sandbox's chat on the person's own team sandbox
 * (`chat.continueHere`), keeping the chat id: the server moves the chat's
 * authority there and the new host hydrates it from its published copy.
 *
 * Offered only when the person's host is a team sandbox that serves the
 * method and the chat's host is gone. The tab stays bound to its host for
 * life, so a continue opens a NEW tab on the new host, which says it is
 * catching up until the chat is live there; this tab stays as it is. A
 * refusal for another environment (or a chat that never was a team
 * sandbox's) falls back to `fallback`, the dead tile's Clone.
 */
export function useChatContinueHere(args: {
  readonly epicId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly name: string;
  readonly fallback: () => void;
}): {
  readonly eligible: boolean;
  readonly continueHere: () => void;
  readonly continuing: boolean;
} {
  const targetHostId = useEffectiveHostId();
  const targetEntry = useHostDirectoryEntry(targetHostId ?? "");
  const sourceEntry = useHostDirectoryEntry(args.sourceHostId);
  const supported = useHostSupportsMethod(targetHostId, "chat.continueHere");
  const targetClient = useHostClientForHostId(targetHostId);
  const { openTile } = useEpicTileNavigation();
  const eligible =
    targetHostId !== null &&
    targetHostId !== args.sourceHostId &&
    targetEntry !== null &&
    isTeamSandboxHostDirectoryEntry(targetEntry) &&
    supported &&
    sourceIsRemoved(sourceEntry);
  const mutation = useHostMutation({
    client: targetClient,
    method: "chat.continueHere",
    mapVariables: (variables: { readonly operationId: string }) => ({
      epicId: args.epicId,
      chatId: args.chatId,
      operationId: variables.operationId,
    }),
    options: {
      mutationKey: chatContinueMutationKeys.continueHere(args.chatId),
      onError: (error) =>
        toastFromHostError(error, "Couldn't continue this agent here."),
    },
  });
  const { mutate, isPending } = mutation;
  const { epicId, chatId, name, fallback } = args;
  const continueHere = useCallback(() => {
    if (targetHostId === null) return;
    // One id per press: the mutation's own retry (and a lost answer) reuses
    // it, so the server moves the chat at most once for this press.
    mutate(
      { operationId: crypto.randomUUID() },
      {
        onSuccess: (answer) => {
          if (answer.kind === "refused") {
            if (answer.reason === "other-environment") {
              fallback();
              return;
            }
            if (answer.reason === "source-live") {
              toast("This agent's sandbox still exists. Resume it instead.");
              return;
            }
            if (answer.reason === "never-published") {
              toast("This agent has nothing saved to continue from.");
              return;
            }
          }
          // Accepted, ready, or already moved by another press: open the
          // chat where it now belongs.
          const ownerHostId = answer.ownerHostId;
          if (ownerHostId === null) return;
          openTile({
            node: {
              id: chatId,
              instanceId: crypto.randomUUID(),
              type: "chat",
              name,
              hostId: ownerHostId,
            },
            target: { epicId },
            gesture: "explicit",
            modifiers: null,
            placement: null,
            // Dedupe is per host: the dead tab on the old host never matches,
            // and a second press focuses the tab the first one opened.
            dedupe: true,
            source: "direct_ui",
          });
        },
      },
    );
  }, [targetHostId, mutate, fallback, openTile, epicId, chatId, name]);
  return { eligible, continueHere, continuing: isPending };
}
