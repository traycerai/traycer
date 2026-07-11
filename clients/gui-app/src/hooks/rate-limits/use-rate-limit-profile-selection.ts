import { useCallback, useSyncExternalStore } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { useShallow } from "zustand/react/shallow";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";

export interface ActiveChatTarget {
  readonly epicId: string;
  readonly chatId: string;
}

export interface RateLimitProfileSelection {
  readonly activeChatSettings: ChatRunSettings | null;
  readonly lastProfileByHarness: Readonly<
    Partial<Record<ChatRunSettings["harnessId"], string | null>>
  >;
}

/**
 * Resolve the focused chat tile from the active header tab + active canvas
 * pane. A chat open elsewhere in the canvas is intentionally ignored: only
 * the pane carrying global focus controls the header's "current" identity.
 */
export function selectActiveChatTarget(
  state: Pick<EpicCanvasStore, "activeTabId" | "tabsById" | "canvasByTabId">,
): ActiveChatTarget | null {
  if (state.activeTabId === null) return null;
  const tab = state.tabsById[state.activeTabId];
  const canvas = state.canvasByTabId[state.activeTabId];
  if (tab === undefined || canvas === undefined) return null;
  if (canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.activeTabId === null) return null;
  const tile = canvas.tilesByInstanceId[pane.activeTabId];
  if (tile === undefined || tile.type !== "chat") return null;
  return { epicId: tab.epicId, chatId: tile.id };
}

/**
 * One reactive snapshot shared by both header rate-limit surfaces.
 *
 * The focused chat's live `currentComposerSettings` is authoritative for its
 * harness. Other harnesses (and every harness when no chat pane is focused)
 * use persisted per-harness profile memory. Cross-harness
 * `globalLastRunSettings` is deliberately absent from this flow.
 */
export function useRateLimitProfileSelection(): RateLimitProfileSelection {
  const activeChatTarget = useEpicCanvasStore(
    useShallow(selectActiveChatTarget),
  );
  const handle = useExistingChatSessionHandle(
    activeChatTarget?.epicId ?? "",
    activeChatTarget?.chatId ?? "",
  );
  const subscribeToComposerSettings = useCallback(
    (listener: () => void) => {
      if (handle === null) return () => undefined;
      // Chat stores update at token-stream frequency. Keep this header bridge
      // subscribed to the store lifetime, but notify React only when the one
      // selected slice changes; block deltas, usage, approvals, and run-state
      // churn never schedule a header render.
      return handle.store.subscribe((state, previousState) => {
        if (
          state.currentComposerSettings ===
          previousState.currentComposerSettings
        ) {
          return;
        }
        listener();
      });
    },
    [handle],
  );
  const getComposerSettings = useCallback(
    () => handle?.store.getState().currentComposerSettings ?? null,
    [handle],
  );
  const activeChatSettings = useSyncExternalStore(
    subscribeToComposerSettings,
    getComposerSettings,
    () => null,
  );
  const lastProfileByHarness = useComposerHarnessMemoryStore(
    (state) => state.lastProfileByHarness,
  );
  return { activeChatSettings, lastProfileByHarness };
}

/**
 * Profile id for one configured provider's rate-limit query and Active badge.
 * A removed/stale managed id cannot address this provider anymore, so it
 * degrades to the ambient profile instead of issuing a query for a dead id.
 */
export function resolveRateLimitProfileId(
  selection: RateLimitProfileSelection,
  providerId: RateLimitProviderId,
  profiles: ReadonlyArray<ProviderProfile>,
): string | null {
  const harnessId = providerIdToGuiHarnessId(providerId);
  const activeSettings = selection.activeChatSettings;
  const candidate =
    activeSettings !== null && activeSettings.harnessId === harnessId
      ? (activeSettings.profileId ?? null)
      : (selection.lastProfileByHarness[harnessId] ?? null);
  if (candidate === null) return null;
  return profiles.some(
    (profile) => profile.kind === "managed" && profile.profileId === candidate,
  )
    ? candidate
    : null;
}
