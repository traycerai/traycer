import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ModelOption } from "@/components/home/data/landing-options";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useChatRunSettingsBatch } from "@/hooks/chats/use-chat-run-settings-query";
import { useEpicUpdateChatProfile } from "@/hooks/epic/use-epic-chat-mutations";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

interface AffectedTaskChat {
  readonly chatId: string;
  readonly settings: ChatRunSettings;
}

/**
 * What the banner knows about the OTHER chats a task-wide switch would move.
 *
 * Which siblings match is a host read per sibling, so it is made only once the
 * person asks for task scope (`resolveScope`), never merely because the banner
 * is showing:
 *
 * - `none`: no candidate sibling at all (no epic, or no other live chat of this
 *   task on this tab's host), so there is nothing to offer.
 * - `unresolved`: candidates exist and nothing has been read yet.
 * - `resolving`: the reads are in flight.
 * - `resolved`: `otherChatCount` siblings pin the same harness, profile and
 *   model, and `switchOtherTaskChats` moves exactly those. `uncheckedChatCount`
 *   siblings could not be read (the read failed, or could not run), so whether
 *   they match is unknown - the switch leaves them alone, and the banner has to
 *   say so rather than present the matched set as the whole task.
 */
export type TaskChatScope =
  | { readonly kind: "none" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "resolving" }
  | {
      readonly kind: "resolved";
      readonly otherChatCount: number;
      readonly uncheckedChatCount: number;
    };

export interface TaskProfileRateLimitSwitch {
  readonly scope: TaskChatScope;
  /**
   * Reads every candidate sibling afresh for the current warning episode.
   * Called on each tick of task scope and on a retry - every call is a new
   * check, never an answer cached by an earlier one.
   */
  readonly resolveScope: () => void;
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

/**
 * The last task-scope check id handed out, renderer-wide.
 *
 * Module-level rather than per hook: the id is part of the sibling reads'
 * cache key, and the query cache outlives any one composer. A per-mount counter
 * restarted at the same ids on a remount - reopening the chat, or a second
 * composer for the same task - and so read a previous mount's cached answers
 * back without asking the host.
 */
let lastTaskScopeCheckId = 0;

function nextTaskScopeCheckId(): number {
  lastTaskScopeCheckId += 1;
  return lastTaskScopeCheckId;
}

const NO_AFFECTED: ReadonlyArray<AffectedTaskChat> = [];
const NO_CANDIDATES: ReadonlyArray<string> = [];
const SCOPE_NONE: TaskChatScope = { kind: "none" };
const SCOPE_UNRESOLVED: TaskChatScope = { kind: "unresolved" };
const SCOPE_RESOLVING: TaskChatScope = { kind: "resolving" };

/**
 * Whether a sibling chat's persisted settings make it eligible for a task-wide
 * switch off the limited profile. Beyond the same harness + limited profile,
 * the sibling must use the SAME model as the composer that owns the banner:
 * a proven-better destination is only proven for that model, and an
 * unknown-usage destination was only ever offered as a deliberate choice to
 * that model's composer - nothing was validated for it at all
 * (`useProfileRateLimitSwitchPrompt`'s `selectedModel` scopes both). Either
 * way the guarantee (or deliberate choice) transfers only to same-model
 * chats; a differently-modeled sibling could otherwise be moved to a profile
 * that is equal, worse, or simply unvetted for ITS model.
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
 * registry-backed sibling chats of this task that are pinned to the SAME
 * limited profile so the banner can offer "switch all N chats in this task",
 * not just the current session. The record projection establishes which new
 * chats belong to this tab's host; authoritative run settings are then read
 * from that host. Legacy doc-only chats, archived chats and chats on other
 * hosts are outside this operation by design.
 *
 * The reads are one request per candidate sibling, so they wait for
 * `resolveScope` rather than following the banner: every mounted composer of
 * a task with a limited profile would otherwise read every sibling each time
 * its banner appeared.
 */
export function useTaskProfileRateLimitSwitch(input: {
  readonly enabled: boolean;
  /**
   * The banner's warning episode (`null` while no banner is showing). A
   * `resolveScope` answers only the episode it was made in, so a new warning
   * asks again instead of inheriting an old request.
   */
  readonly episodeKey: string | null;
  readonly harnessId: GuiHarnessId;
  readonly profileId: string | null;
  /** The composer's selected model, or `null` when unresolved. Gates which
   * siblings inherit the switch - see `taskChatInheritsProfileSwitch`. */
  readonly selectedModel: ModelOption | null;
  readonly epicId: string | null;
  readonly chatId: string;
}): TaskProfileRateLimitSwitch {
  const {
    enabled,
    episodeKey,
    harnessId,
    profileId,
    selectedModel,
    epicId,
    chatId,
  } = input;
  const selectedModelSlug = selectedModel?.slug ?? null;
  const tabHostId = useTabHostId();
  const tabHostClient = useTabHostClient();
  const epicHandle = useMaybeOpenEpicHandle();
  // Gated on `enabled` (not just `epicHandle`): every mounted composer in the
  // task calls this hook, so without the gate each one subscribes to the
  // full `chatRecords` slice and re-renders on every record-list mutation even in
  // the common case where the profile isn't limited and `affected` below
  // would short-circuit to `NO_AFFECTED` anyway.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled || epicHandle === null) return () => {};
      return epicHandle.store.subscribe(onStoreChange);
    },
    [enabled, epicHandle],
  );
  const chatRecords = useSyncExternalStore<ChatsSlice | null>(subscribe, () =>
    !enabled || epicHandle === null
      ? null
      : epicHandle.store.getState().chatRecords,
  );

  const candidateChatIds = useMemo<ReadonlyArray<string>>(() => {
    if (!enabled || chatRecords === null || epicId === null) {
      return NO_CANDIDATES;
    }
    return chatRecords.allIds.filter((candidateChatId) => {
      const chat = chatRecords.byId[candidateChatId];
      return (
        chat.hostId === tabHostId &&
        candidateChatId !== chatId &&
        chat.archivedAt === null
      );
    });
  }, [chatId, chatRecords, enabled, epicId, tabHostId]);

  // The latest explicit check: which warning episode it was made in, and an
  // id no other check in this renderer has used, which makes it its own set
  // of reads.
  const [check, setCheck] = useState<{
    readonly episodeKey: string | null;
    readonly id: number;
  }>({ episodeKey: null, id: 0 });
  const requested =
    enabled && episodeKey !== null && check.episodeKey === episodeKey;
  const resolveScope = useCallback(() => {
    setCheck({ episodeKey, id: nextTaskScopeCheckId() });
  }, [episodeKey]);

  const batch = useChatRunSettingsBatch({
    client: tabHostClient,
    epicId: epicId ?? "",
    chatIds: candidateChatIds,
    enabled: requested && epicId !== null && selectedModelSlug !== null,
    checkId: check.id,
  });

  const affected = useMemo<ReadonlyArray<AffectedTaskChat>>(() => {
    if (!requested || epicId === null) {
      return NO_AFFECTED;
    }
    return candidateChatIds.flatMap((candidateChatId, index) => {
      const read = batch.reads.at(index);
      const settings =
        read !== undefined && read.kind === "answered" ? read.settings : null;
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
      return [{ chatId: candidateChatId, settings }];
    });
  }, [
    requested,
    epicId,
    candidateChatIds,
    batch.reads,
    harnessId,
    profileId,
    selectedModelSlug,
  ]);

  const otherChatCount = affected.length;
  const uncheckedChatCount = useMemo(
    () =>
      batch.reads.filter(
        (read) => read.kind === "failed" || read.kind === "unavailable",
      ).length,
    [batch.reads],
  );
  const scope = useMemo<TaskChatScope>(() => {
    if (candidateChatIds.length === 0) return SCOPE_NONE;
    if (!requested) return SCOPE_UNRESOLVED;
    // The composer's model not loaded yet is a transient gate, not an answer:
    // the batch starts on its own once it resolves. Reporting `resolved` here
    // (every read `unavailable`) would release the held switch, and a switch
    // in that window moves only this chat - after which the siblings, pinned
    // to the old profile, can never match.
    if (batch.resolving || selectedModelSlug === null) return SCOPE_RESOLVING;
    return { kind: "resolved", otherChatCount, uncheckedChatCount };
  }, [
    batch.resolving,
    candidateChatIds.length,
    otherChatCount,
    requested,
    selectedModelSlug,
    uncheckedChatCount,
  ]);

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
        //
        // Peeked on THIS TAB'S host, which is also the host the registry
        // candidates were filtered by: the sibling being
        // re-seeded is by construction a chat of this tab's host, and a
        // same-id chat on another host is a different agent whose composer
        // must not be touched by this switch.
        const warmSession = getChatSessionRegistry().peek(
          epicId,
          chat.chatId,
          tabHostId,
        );
        warmSession?.store.getState().setCurrentComposerSettings({
          ...chat.settings,
          profileId: nextProfileId,
        });
      }
    },
    [affected, chatId, epicId, tabHostId, updateChatProfileMutate],
  );

  return { scope, resolveScope, switchOtherTaskChats };
}
