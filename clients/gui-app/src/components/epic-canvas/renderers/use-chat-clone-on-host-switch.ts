import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useHostBinding } from "@/lib/host";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { cloneChatOnHostSwitch } from "@/lib/commands/actions/clone-chat-on-host-switch";

/**
 * Lifted out of `chat-tile.tsx` (P1.2 fixup F5) so the host it targets is
 * reachable by a test. The defect this module exists to keep fixed is a
 * TIMING one - the clone resolves settings asynchronously before it creates -
 * and it is only observable by driving the hook across that window, which is
 * impossible while it is a private function inside a 2,800-line tile.
 */
export interface UseChatCloneOnHostSwitchArgs {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly sourceSettings: ChatRunSettings | null;
  /** The source chat's RAW stored title, or `""` when this banner has no
   *  record to read one from - a dead tile whose record was retracted is
   *  exactly that case. Empty leaves the clone's name to the host's
   *  fork-seed gap-fill, which reads the title off the copy the history
   *  came from. */
  readonly sourceTitle: string;
  /** The owner this banner was showing, or `null` when it does not know. */
  readonly sourceOwnerUserId: string | null;
}

/**
 * Wires the chat dead-tile banner's Clone action to
 * `cloneChatOnHostSwitch`. Targets the directory's currently selected
 * host (the user's active default). Tracks the returned cancel in a
 * ref and disposes it on unmount so an aborted clone doesn't leak the
 * projection-wait subscription (ticket 10).
 */
export function useChatCloneOnHostSwitch(args: UseChatCloneOnHostSwitchArgs): {
  readonly clone: () => void;
  readonly cloning: boolean;
} {
  const binding = useHostBinding();
  // Resolved at RENDER, not in the click handler: `cloneChatOnHostSwitch`
  // awaits settings resolution before it creates, and the app-wide selection
  // can move inside that window. Reading the target here and binding the
  // mutation to THAT host up front means the clone lands where the button was
  // pressed for, or refuses - it can never be re-pointed mid-flight. (A
  // mutation pinned to the app-wide active host instead would reject the
  // whole clone on a move, which is safe but loses the user's action for no
  // reason - `useEpicCreateChatForHostClient` is what lets the target be
  // frozen here instead.)
  const cloneTargetHostId = useEffectiveHostId();
  const cloneTargetClient = useHostClientForHostId(cloneTargetHostId);
  const createChat = useEpicCreateChatForHostClient(cloneTargetClient);
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const cancelRef = useRef<(() => void) | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    const cancelHandle = cancelRef;
    return () => {
      if (cancelHandle.current !== null) {
        cancelHandle.current();
        cancelHandle.current = null;
      }
    };
  }, []);

  const clone = useCallback(() => {
    if (binding === null) {
      toast("Can't clone this agent - no host connection.");
      return;
    }
    if (cloneTargetHostId === null) {
      toast("Pick an active host before cloning this agent.");
      return;
    }
    if (cloneTargetHostId === args.sourceHostId) {
      // The refusal this finding is about: the active host IS the agent's
      // own bound host, so there is nowhere to clone to - silently doing
      // nothing here used to read as a broken button.
      toast(
        "The active host is this agent's own bound host - switch to a different host before cloning.",
      );
      return;
    }
    if (cloneTargetClient === null) {
      // Named, but not addressable (no endpoint, or no live credential
      // context). Refuse rather than start a clone whose create can only fail
      // after the projection-wait subscription has already been armed. Checked
      // AFTER the same-host case so an unreachable own-host still gets the
      // message that actually explains the button.
      toast("That host can't be reached right now - try again in a moment.");
      return;
    }
    if (cancelRef.current !== null) cancelRef.current();
    setCloning(true);
    cancelRef.current = cloneChatOnHostSwitch({
      epicId: args.epicId,
      tabId: args.tabId,
      sourceChatId: args.chatId,
      sourceOwnerUserId: args.sourceOwnerUserId,
      sourceHostId: args.sourceHostId,
      sourceTitle: args.sourceTitle,
      targetHostId: cloneTargetHostId,
      directory: binding.directory,
      sourceSettings: args.sourceSettings,
      globalClient: binding.hostClient,
      onProfileFallbackToAmbient: () => {
        toast(
          "Continuing on the Terminal account - your profile isn't available on this host.",
        );
      },
      onHistoryUnavailable: (reason) => {
        toast(
          reason === "no-checkpoint"
            ? "This agent hasn't replied yet, so its history can't be carried - continuing with settings only."
            : "This device can't send this agent's history to that host version - continuing with settings only.",
        );
      },
      onCloneFailed: () => {
        setCloning(false);
      },
      navigateNestedFocus,
      createChat: (request, callbacks) => {
        createChat.mutate(request, {
          onSuccess: callbacks.onSuccess,
          onError: callbacks.onError,
        });
      },
    });
  }, [
    binding,
    cloneTargetClient,
    cloneTargetHostId,
    createChat,
    navigateNestedFocus,
    args.epicId,
    args.tabId,
    args.chatId,
    // The cloud list can resolve AFTER this banner first renders, so the
    // callback must be rebuilt when the owner lands - otherwise a click still
    // sends the `null` this closed over on the first pass (ticket 37).
    args.sourceOwnerUserId,
    args.sourceHostId,
    args.sourceSettings,
    args.sourceTitle,
  ]);

  return { clone, cloning };
}
