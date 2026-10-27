import { useCallback, useSyncExternalStore } from "react";
import type { Mutation } from "@tanstack/react-query";

import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { classifyRecoverableForkFailure } from "@/lib/chats/recoverable-fork-refusal";
import {
  chatRunsOpencodeLineOne,
  epicCreateChatCarriesOpencodeLine,
  providersSetSelectionMovesChats,
} from "@/lib/chat/opencode-line";
import {
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
} from "@/lib/commands/actions/new-chat";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { epicMutationKeys } from "@/lib/query-keys";

const NO_SUBSCRIBE = (): (() => void) => () => {};

interface ContinueOnOpencodeTwoTabMenuProps {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly tabId: string;
}

/**
 * The tab menu's "Continue on OpenCode 2" for an OpenCode chat on 1.x: a new
 * chat in the same epic, on the same host, seeded with this chat's transcript
 * and recorded on line 2. This chat is kept as it is. Offered only where the
 * host's `epic.createChat` takes a line, and not where its
 * `providers.setSelection` moves existing chats: there, picking Managed 2.x in
 * Settings moves this chat itself.
 */
export function ContinueOnOpencodeTwoTabMenu(
  props: ContinueOnOpencodeTwoTabMenuProps,
) {
  const { epicId, chatId, hostId, tabId } = props;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const chat = useSyncExternalStore(
    handle === null ? NO_SUBSCRIBE : handle.store.subscribe,
    () => (handle === null ? null : handle.store.getState().chat),
  );
  const client = useHostClientForHostId(hostId);
  const createChat = useEpicCreateChatForHostClient(client);
  const isContinuation = useCallback(
    (mutation: Mutation) => {
      const variables = mutation.state.variables;
      return (
        typeof variables === "object" &&
        variables !== null &&
        "epicId" in variables &&
        variables.epicId === epicId &&
        "hostId" in variables &&
        variables.hostId === hostId &&
        "opencodeLine" in variables &&
        variables.opencodeLine === 2 &&
        "forkSource" in variables &&
        typeof variables.forkSource === "object" &&
        variables.forkSource !== null &&
        "sourceChatId" in variables.forkSource &&
        variables.forkSource.sourceChatId === chatId
      );
    },
    [epicId, hostId, chatId],
  );
  const creatingContinuation =
    useIsMutatingOf({
      mutationKey: epicMutationKeys.createChat(),
      predicate: isContinuation,
    }) > 0;
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const version = useHostMethodSchemaVersion(hostId, "epic.createChat");
  const setSelectionVersion = useHostMethodSchemaVersion(
    hostId,
    "providers.setSelection",
  );
  if (
    chat === null ||
    !epicCreateChatCarriesOpencodeLine(version) ||
    providersSetSelectionMovesChats(setSelectionVersion) ||
    !chatRunsOpencodeLineOne(chat)
  ) {
    return null;
  }
  return (
    <ContextMenuItem
      disabled={createChat.isPending || creatingContinuation}
      onSelect={() => {
        if (createChat.isPending || creatingContinuation) return;
        // The projection wait cancels itself on its own timeout; the menu
        // unmounts as soon as this item is picked, so nothing here could
        // hold the cancel.
        openNewChatInActiveTile({
          epicId,
          tabId,
          hostId,
          parentId: null,
          worktreeIntent: null,
          title: chat.title.trim() === "" ? "" : `${chat.title} (OpenCode 2)`,
          settings: chat.settings,
          forkSource: {
            boundary: "latest",
            sourceChatId: chatId,
            sourceOwnerUserId: chat.userId,
          },
          source: "direct_ui",
          createChat: (request, callbacks) => {
            // `mutateAsync`, not `mutate`: picking the item closes the menu
            // and unmounts this component, and TanStack drops `mutate`'s
            // per-call callbacks then, so the clone would be made but never
            // opened. A refusal resolves, and the mutation's own `onSuccess`
            // already reported it, so it is never opened.
            createChat
              .mutateAsync({ ...request, opencodeLine: 2 })
              .then((response) => {
                if (response.refusal === undefined)
                  callbacks.onSuccess(response);
              }, callbacks.onError);
          },
          openWhenProjected: (intent) =>
            openCreatedChatWhenProjectedWithNavigation({
              intent,
              navigateNestedFocus,
            }),
          onCreateError: (error) => {
            // The shared create toast stays silent on a fork the host could
            // not serve, so this is the only place that says so.
            if (classifyRecoverableForkFailure(error) !== null) {
              toast(
                "This agent has no reply to continue from yet. Try again after it answers.",
              );
            }
          },
        });
      }}
    >
      <ArrowRightLeft className="size-4" />
      Continue on OpenCode 2
    </ContextMenuItem>
  );
}
