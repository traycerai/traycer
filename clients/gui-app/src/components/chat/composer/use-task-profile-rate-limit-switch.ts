import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ModelOption } from "@/components/home/data/landing-options";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicUpdateChatProfile } from "@/hooks/epic/use-epic-chat-mutations";
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
   * Switches every OTHER affected chat to `nextProfileId` via the narrow
   * `epic.updateChatProfile` RPC (best-effort - an old host rejects the
   * optional method and those chats keep legacy persist-on-next-send
   * behavior). The host patches its own authoritative persisted tuple and,
   * for a warm session, moves already-queued prompts and a not-yet-spawned
   * parked turn onto the new profile with it. Warm sessions additionally get
   * a local composer re-seed so open sibling tiles reflect the switch
   * immediately. The caller's own composer commit (`onSwitchProfile`) covers
   * this chat.
   */
  readonly switchOtherTaskChats: (nextProfileId: string | null) => void;
}

const NO_AFFECTED: ReadonlyArray<AffectedTaskChat> = [];

/**
 * Whether a sibling chat's persisted settings make it eligible for a task-wide
 * switch off the limited profile. Beyond the same harness + limited profile,
 * the sibling must use the SAME model as the composer that owns the banner:
 * the destination was validated as strictly better only for that model
 * (`useProfileRateLimitSwitchPrompt`'s `selectedModel`), so the guarantee
 * transfers only to same-model chats. A differently-modeled sibling could
 * otherwise be moved to a profile that is equal or worse for ITS model.
 * `selectedModelSlug` is `null` when the composer's model is unresolved
 * (catalog still loading); no persisted sibling matches a null slug, so
 * task-wide switching is conservatively withheld until the model resolves.
 */
export function taskChatInheritsProfileSwitch(
  settings: ChatRunSettings,
  criteria: {
    readonly harnessId: GuiHarnessId;
    readonly profileId: string | null;
    readonly selectedModelSlug: string | null;
  },
): boolean {
  return (
    settings.harnessId === criteria.harnessId &&
    (settings.profileId ?? null) === criteria.profileId &&
    settings.model === criteria.selectedModelSlug
  );
}

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
  /** The composer's selected model, or `null` when unresolved. Gates which
   * siblings inherit the switch - see `taskChatInheritsProfileSwitch`. */
  readonly selectedModel: ModelOption | null;
  readonly epicId: string | null;
  readonly chatId: string;
}): TaskProfileRateLimitSwitch {
  const { enabled, harnessId, profileId, selectedModel, epicId, chatId } =
    input;
  const selectedModelSlug = selectedModel?.slug ?? null;
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
          !taskChatInheritsProfileSwitch(settings, {
            harnessId,
            profileId,
            selectedModelSlug,
          })
        ) {
          return [];
        }
        return [{ chatId: chat.id, settings }];
      });
  }, [
    enabled,
    chats,
    epicId,
    tabHostId,
    harnessId,
    profileId,
    selectedModelSlug,
  ]);

  // The current chat always counts (its composer holds the limited profile
  // even when its persisted record lags, e.g. never-sent or pre-capability
  // records).
  const affectedChatCount = affected.some((chat) => chat.chatId === chatId)
    ? affected.length
    : affected.length + 1;

  const updateChatProfile = useEpicUpdateChatProfile();
  const updateChatProfileMutate = updateChatProfile.mutate;
  const switchOtherTaskChats = useCallback(
    (nextProfileId: string | null): void => {
      if (epicId === null) return;
      for (const chat of affected) {
        if (chat.chatId === chatId) continue;
        // Narrow profile-only update: the host patches its own authoritative
        // persisted tuple (and, for a warm session, moves queued prompts and
        // a not-yet-spawned parked turn with it). Deliberately NOT a
        // client-side `{ ...chat.settings, profileId }` rebuild - the store
        // projection can lag the sibling's real settings, and re-persisting
        // a stale full tuple just to move the profile is exactly the
        // subset-field misuse `epic.updateChatRunSettings` v1.1 forbids.
        updateChatProfileMutate({
          epicId,
          chatId: chat.chatId,
          profileId: nextProfileId,
        });
        // Warm sessions re-seed their composer toolbar from
        // `currentComposerSettings`, so an open sibling tile reflects the
        // switch immediately instead of stomping it on its next send. This is
        // local display state, not a wire persist.
        const warmSession = getChatSessionRegistry().peek(epicId, chat.chatId);
        warmSession?.store.getState().setCurrentComposerSettings({
          ...chat.settings,
          profileId: nextProfileId,
        });
      }
    },
    [affected, chatId, epicId, updateChatProfileMutate],
  );

  return { affectedChatCount, switchOtherTaskChats };
}
