import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicUpdateChatRunSettings } from "@/hooks/epic/use-epic-chat-mutations";
import { enqueuePersistChatRunSettings } from "@/lib/chats/chat-run-settings-write-queue";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

interface AffectedTaskChat {
  readonly chatId: string;
  readonly settings: ChatRunSettings;
}

export interface TaskProfileRateLimitSwitch {
  /**
   * How many chats in this task (epic) a task-wide switch would move off the
   * limited profile - every chat on this tab's host whose persisted settings
   * pin the same harness + profile, always counting this chat itself. `1`
   * (just this chat) whenever the epic store is unavailable, so the banner
   * simply hides the task-wide affordance on surfaces without an epic.
   */
  readonly affectedChatCount: number;
  /**
   * Switches every OTHER affected chat to `nextProfileId`: persists each
   * chat's settings durably via `epic.updateChatRunSettings` (best-effort -
   * an old host rejects the optional method and those chats keep legacy
   * persist-on-next-send behavior), live-updates any warm session so an open
   * composer re-seeds immediately, and restamps its already-queued prompts so
   * they don't keep running on the old profile. The caller's own composer
   * commit (`onSwitchProfile`) covers this chat.
   */
  readonly switchOtherTaskChats: (nextProfileId: string | null) => void;
}

const NO_AFFECTED: ReadonlyArray<AffectedTaskChat> = [];

/**
 * Task-wide counterpart of the composer's rate-limit switch prompt: finds the
 * sibling chats of this task that are pinned to the SAME limited profile so
 * the banner can offer "switch all N chats in this task", not just the
 * current session. Reads the open-epic store's chat projections (which carry
 * each chat's persisted `settings` and `hostId`), so unopened chats count
 * too - a durable per-chat pin is exactly what an incoming agent-to-agent
 * message would run on.
 */
export function useTaskProfileRateLimitSwitch(input: {
  readonly enabled: boolean;
  readonly harnessId: GuiHarnessId;
  readonly profileId: string | null;
  readonly epicId: string | null;
  readonly chatId: string;
}): TaskProfileRateLimitSwitch {
  const { enabled, harnessId, profileId, epicId, chatId } = input;
  const tabHostId = useTabHostId();
  const epicHandle = useMaybeOpenEpicHandle();
  // Gated on `enabled` (not just `epicHandle`): every mounted composer in the
  // task calls this hook, so without the gate each one subscribes to the
  // full `chats` slice and re-renders on every chat-list mutation even in
  // the common case where the profile isn't limited and `affected` below
  // would short-circuit to `NO_AFFECTED` anyway.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled || epicHandle === null) return () => {};
      return epicHandle.store.subscribe(onStoreChange);
    },
    [enabled, epicHandle],
  );
  const chats = useSyncExternalStore<ChatsSlice | null>(subscribe, () =>
    !enabled || epicHandle === null ? null : epicHandle.store.getState().chats,
  );

  const affected = useMemo<ReadonlyArray<AffectedTaskChat>>(() => {
    if (!enabled || chats === null || epicId === null) {
      return NO_AFFECTED;
    }
    return chats.allIds
      .map((id) => chats.byId[id])
      .filter((chat) => chat.hostId === tabHostId)
      .flatMap((chat) => {
        const settings = chat.settings;
        if (
          settings === null ||
          settings.harnessId !== harnessId ||
          (settings.profileId ?? null) !== profileId
        ) {
          return [];
        }
        return [{ chatId: chat.id, settings }];
      });
  }, [enabled, chats, epicId, tabHostId, harnessId, profileId]);

  // The current chat always counts (its composer holds the limited profile
  // even when its persisted record lags, e.g. never-sent or pre-capability
  // records).
  const affectedChatCount = affected.some((chat) => chat.chatId === chatId)
    ? affected.length
    : affected.length + 1;

  const updateChatRunSettings = useEpicUpdateChatRunSettings();
  const updateChatRunSettingsMutateAsync = updateChatRunSettings.mutateAsync;
  const switchOtherTaskChats = useCallback(
    (nextProfileId: string | null): void => {
      if (epicId === null) return;
      for (const chat of affected) {
        if (chat.chatId === chatId) continue;
        const settings: ChatRunSettings = {
          ...chat.settings,
          profileId: nextProfileId,
        };
        // Routed through the same module-scoped queue the sibling's own
        // composer writes use (chat-tile.tsx), so this task-wide switch can't
        // race an in-flight write from that chat's own composer and leave it
        // pinned to stale settings.
        enqueuePersistChatRunSettings(updateChatRunSettingsMutateAsync, {
          epicId,
          chatId: chat.chatId,
          settings,
        });
        const warmSession = getChatSessionRegistry().peek(epicId, chat.chatId);
        // Warm sessions re-seed their composer toolbar from
        // `currentComposerSettings`, so an open sibling tile reflects the
        // switch immediately instead of stomping it on its next send.
        warmSession?.store.getState().setCurrentComposerSettings(settings);
        // Also restamp its already-queued (not-yet-sent) prompts - otherwise
        // they keep running on the old profile until another composer change
        // happens to touch them. No queue item is "open for editing" from
        // this task-wide switch's perspective, so nothing is excluded.
        warmSession?.store.getState().restampQueuedItemSettings(settings, null);
      }
    },
    [affected, chatId, epicId, updateChatRunSettingsMutateAsync],
  );

  return { affectedChatCount, switchOtherTaskChats };
}
