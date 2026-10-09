import { useCallback } from "react";
import { toast } from "sonner";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicConversationPlacement } from "@/hooks/host/use-composer-placement";
import {
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
} from "@/lib/commands/actions/new-chat";
import { resolveLandingPlacement } from "@/lib/composer/landing-placement";

export interface SwitcherNewChat {
  /** Create an empty agent (a child of `parentId` when non-null) and show it. */
  readonly start: (parentId: string | null) => void;
  readonly isPending: boolean;
}

/**
 * The phone's "new agent": create an EMPTY chat and open it, the way an
 * agent-to-agent `create_agent` does, so the user types the first message in
 * the chat itself. No New Conversation modal on the phone.
 *
 * The modal is also what this replaces as a fix, not just as a design: its
 * host (`NewConversationModalHost`) mounts only while the router sits on this
 * tab's route, and the installed app boots its router at `/` on a cold launch
 * while the restored tab fills the screen. The sheet and its "+" do not wait
 * for the route, so "+" filed an open request nothing rendered and closed the
 * sheet - the user landed back on the chat they were in. This path owns its
 * create and its open (`openTile` writes the route itself), so it needs no
 * host mounted anywhere.
 *
 * Same placement as the modal: this Epic's last-created-chat host, else the
 * host the Epic is served from, re-recorded on every create. No settings and
 * no workspace are stamped: the chat tile's own composer picks the model and
 * resolves the workspace on the first send, as it does for an A2A-created chat.
 *
 * The sheet stays open until the host answers: `mutate`'s per-call callbacks
 * are dropped once the calling component unmounts, and this hook lives inside
 * the sheet. `onOpened` closes it as the new chat takes the screen.
 */
export function useSwitcherNewChat(
  epicId: string,
  tabId: string,
  onOpened: () => void,
): SwitcherNewChat {
  const sessionHostId = useEpicSessionHostId();
  const placement = useEpicConversationPlacement({
    epicId,
    overrideHostId: null,
    sessionHostId,
  });
  const submitTarget = placement.submitTarget;
  const recordPlacement = placement.pin.setSelection;
  const createChat = useEpicCreateChatForHostClient(submitTarget.client);
  const navigateNestedFocus = useEpicNestedFocusNavigation();

  const start = useCallback(
    (parentId: string | null) => {
      if (createChat.isPending) return;
      const verdict = resolveLandingPlacement(submitTarget);
      if (verdict.kind === "refused") {
        toast.error(verdict.message);
        return;
      }
      recordPlacement(verdict.hostId);
      openNewChatInActiveTile({
        epicId,
        tabId,
        hostId: verdict.hostId,
        parentId,
        worktreeIntent: null,
        title: "",
        settings: null,
        forkSource: null,
        source: "direct_ui",
        createChat: (request, callbacks) => {
          createChat.mutate(request, callbacks);
        },
        // The mutation's own `onError` already toasts.
        onCreateError: () => undefined,
        openWhenProjected: (intent) => {
          const cancel = openCreatedChatWhenProjectedWithNavigation({
            intent,
            navigateNestedFocus,
          });
          onOpened();
          return cancel;
        },
      });
    },
    [
      createChat,
      epicId,
      navigateNestedFocus,
      onOpened,
      recordPlacement,
      submitTarget,
      tabId,
    ],
  );

  return { start, isPending: createChat.isPending };
}
