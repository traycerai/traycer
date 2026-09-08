import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useFocusStopAgent,
  type FocusStopAgentInput,
} from "@/hooks/home-focus/use-focus-stop-agent-mutation";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useManagedCommandStop } from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { routeNotificationForHost } from "@/lib/notifications";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import { useMergedNotificationsActions } from "@/stores/notifications/merged-notifications";
import { parseManagedCommandRowKey } from "@/lib/home-focus/focus-background";
import type {
  FocusBackgroundRow,
  FocusPromptRow,
} from "@/lib/home-focus/focus-model";

export interface FocusActions {
  /**
   * Opens the chat (or browser session) a prompt is waiting in, and
   * acknowledges the row on success.
   *
   * CLICK-THROUGH, not decide-in-place, and that is a discovery rather than a
   * preference: approving, denying and answering are methods on a
   * warm `chat.subscribe` session, so there is no unary RPC this cross-task
   * surface could call. An origin-bound prompt whose host this window is not
   * addressing still NAVIGATES, but settles as `"failure"` and stays unread -
   * the existing refusal in `useNotificationActivation`, which exists so a
   * prompt is never credited to a host that never showed it.
   */
  readonly openPrompt: (row: FocusPromptRow) => void;
  /** Focuses the agent's tile where one is already open, else opens the task's
   * tab focused on it. */
  readonly openAgent: (epicId: string, agentId: string) => void;
  /**
   * Opens the CHAT a background row belongs to - the shell's owner, not the
   * shell. There is no cross-task route to a managed-command output tile, and
   * the chat is where the row's other capabilities live anyway (a background
   * item's stop is an action on that chat's warm session, which is why
   * `stoppable` is false for one here).
   */
  readonly openBackground: (row: FocusBackgroundRow) => void;
  readonly openTask: (epicId: string) => void;
  /**
   * `agent.stop`, sent to the AGENT's host (`FocusAgentRow.hostId`) rather than
   * to whichever host this window addresses; `null` follows the window.
   *
   * `cascade` also stops the subtree the agent delegated to - callers pass
   * `true` and issue one call per ROOT, because a cascade already covers every
   * descendant and a second call for a child would race its own parent's
   * teardown. Unary and epic-addressed, so it works for any task on the
   * account, opened in this window or not.
   *
   * ASYMMETRY WORTH KNOWING: this does NOT check `FocusTaskRow.stoppable`, while
   * {@link FocusActions.stopManagedCommand} does check the row's own flag. The
   * flag is a property of the TASK (every one of its agents is reachable) and
   * this takes a single agent, so enforcing it here would refuse a reachable
   * agent because a sibling on a sleeping host is not. Gating the control is
   * the view's job; this sends what it is told to send.
   */
  readonly stopAgent: (input: FocusStopAgentInput) => void;
  /**
   * `managedCommand.stop`, pinned to the command's own host. A row with
   * `stoppable: false` is refused here rather than sent and failed: a
   * background item has no unary stop at all, and a command whose host the
   * registry cannot name has nowhere to send one.
   */
  readonly stopManagedCommand: (row: FocusBackgroundRow) => void;
  /**
   * Ids with a stop currently in flight, so a row can disable its own button
   * without the view holding pending state per row.
   *
   * Keyed by whatever the ROW can name itself with: an agent contributes its
   * `agentId`, a background row its `key`. The key rather than the command id
   * because `FocusBackgroundRow` exposes no command id - the key IS its
   * address, and a renderer holding a row can look itself up without parsing
   * anything. An id leaves the set when the RPC settles, success or failure: a
   * failed stop is not still running.
   */
  readonly stopping: ReadonlySet<string>;
}

export type { FocusStopAgentInput };

const EMPTY_STOPPING: ReadonlySet<string> = new Set<string>();

/**
 * Every action the focus view can take, and deliberately no more.
 *
 * Navigation goes through `routeNotificationForHost` rather than assembling tab
 * intents here. That function is the bell's own Open path - reuse an open
 * tile's tab and focus it, fall back to opening the epic's tab focused on
 * the artifact - and routing through it keeps Home's "Open" behaving exactly
 * like the bell's, including the closed-tile revival path and the host-bound
 * tile matching. Reimplementing it would also mean calling a canvas
 * `prepare*FocusTarget` action directly, which the tile-open boundary rules ban
 * for good reason.
 */
export function useFocusActions(): FocusActions {
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const { activate } = useNotificationActivation();
  const notificationActions = useMergedNotificationsActions();
  const markAsRead = notificationActions.markAsRead;
  const stopAgentMutation = useFocusStopAgent();
  const stopManagedCommandMutation = useManagedCommandStop();
  const { mutate: stopAgentMutate } = stopAgentMutation;
  const { mutate: stopManagedCommandMutate } = stopManagedCommandMutation;

  // In-flight stops, tracked here rather than read off the mutations: one
  // mutation observer serves every row, so `isPending` would light every Stop
  // button on the page the moment any one of them was pressed.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(EMPTY_STOPPING);
  const beginStopping = useCallback((id: string) => {
    setStopping((current) => new Set(current).add(id));
  }, []);
  const endStopping = useCallback((id: string) => {
    setStopping((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next.size === 0 ? EMPTY_STOPPING : next;
    });
  }, []);

  const openPrompt = useCallback(
    (row: FocusPromptRow) => {
      const payload = row.activation.payload;
      if (payload === null) return;
      activate({
        payload,
        receivedAt: Date.now(),
        feedId: row.activation.feedId,
        originHostId: row.activation.originHostId,
        onResult: activationResultHandler({
          row: row.activation,
          feedId: row.activation.feedId,
          surface: "home",
          markAsRead,
          onSuccess: null,
        }),
      });
    },
    [activate, markAsRead],
  );

  const openChat = useCallback(
    (epicId: string, chatId: string) => {
      routeNotificationForHost(
        navigate,
        { kind: "chat", epicId, chatId },
        Date.now(),
        // No origin host: the activity union names an agent, not the machine it
        // runs on, so any tile holding that id is the right one to focus. A
        // prompt is the case that DOES need an origin, and it goes through
        // `openPrompt`.
        { originHostId: null, effectiveHostId },
      );
    },
    [navigate, effectiveHostId],
  );

  const openAgent = useCallback(
    (epicId: string, agentId: string) => {
      openChat(epicId, agentId);
    },
    [openChat],
  );

  const openBackground = useCallback(
    (row: FocusBackgroundRow) => {
      openChat(row.epicId, row.chatId);
    },
    [openChat],
  );

  const openTask = useCallback(
    (epicId: string) => {
      routeNotificationForHost(navigate, { kind: "epic", epicId }, Date.now(), {
        originHostId: null,
        effectiveHostId,
      });
    },
    [navigate, effectiveHostId],
  );

  const stopAgent = useCallback(
    (input: FocusStopAgentInput) => {
      beginStopping(input.agentId);
      stopAgentMutate(input, {
        onSettled: () => endStopping(input.agentId),
      });
    },
    [stopAgentMutate, beginStopping, endStopping],
  );

  const stopManagedCommand = useCallback(
    (row: FocusBackgroundRow) => {
      if (!row.stoppable) return;
      const target = parseManagedCommandRowKey(row.key);
      if (target === null) return;
      beginStopping(row.key);
      stopManagedCommandMutate(
        {
          hostId: target.hostId,
          epicId: target.epicId,
          commandId: target.commandId,
        },
        { onSettled: () => endStopping(row.key) },
      );
    },
    [stopManagedCommandMutate, beginStopping, endStopping],
  );

  return useMemo(
    () => ({
      openPrompt,
      openAgent,
      openBackground,
      openTask,
      stopAgent,
      stopManagedCommand,
      stopping,
    }),
    [
      openPrompt,
      openAgent,
      openBackground,
      openTask,
      stopAgent,
      stopManagedCommand,
      stopping,
    ],
  );
}
