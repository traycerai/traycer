import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useArtifactReadStateStore } from "@/stores/epics/artifact-read-state-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useGitPanelStore } from "@/stores/epics/git-panel-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useFileTreeStore } from "@/stores/file-tree/file-tree-store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useLocalSnapshotClearStore } from "@/stores/settings/local-snapshot-clear-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorktreesSettingsViewStore } from "@/stores/settings/worktrees-settings-view-store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";

// Call-site regression guard for the full persist-name chain:
//   catalog leaf (keys.ts) → STORE_KEYS[camelName] → the store's persist call.
// Each expected name below is a HAND-WRITTEN literal, NOT derived from the
// builders or STORE_KEYS — deriving it would make the test circular and unable
// to catch a divergence. A wrong leaf, a typo'd STORE_KEYS access, or a store
// that stops routing through the catalog must fail HERE.
//
// The six scoped singletons (composer-run-settings, composer-harness-memory,
// worktree-intent-memory, worktree-intent-staging, epic-canvas,
// app-local-notifications) are constructed
// at module load in their initial `anon` bucket; the persist lifecycle bridges
// retarget them at runtime. The construction-time name asserted here is
// therefore the `anon` one.

// The persist middleware's `getOptions()` returns a `Partial<PersistOptions>`,
// so `name` is structurally optional here even though every store configures it.
interface StorePersistHandle {
  readonly persist: {
    readonly getOptions: () => { readonly name?: string };
  };
}

const STORE_PERSIST_NAME_CASES: ReadonlyArray<
  [label: string, store: StorePersistHandle, expectedName: string]
> = [
  // ── Static singletons ────────────────────────────────────────────────────
  [
    "useCommandPaletteStore",
    useCommandPaletteStore,
    "traycer-gui-app:command-palette",
  ],
  [
    "useComposerDraftStore",
    useComposerDraftStore,
    "traycer-gui-app:composer-drafts",
  ],
  // NOTE: useInterviewDraftStore is intentionally absent. It no longer uses the
  // zustand `persist` middleware (so it has no `.persist.getOptions().name`): it
  // persists one localStorage key per (chatId, blockId) via `interviewDraftKey`
  // for cross-window isolation — the same reason the app-local display-receipt
  // store is not listed here.
  [
    "useArtifactReadStateStore",
    useArtifactReadStateStore,
    "traycer-gui-app:artifact-read-state",
  ],
  ["useGitPanelStore", useGitPanelStore, "traycer-gui-app:git-panel"],
  [
    "useInitialChatHandoffStore",
    useInitialChatHandoffStore,
    "traycer-gui-app:initial-chat-handoffs",
  ],
  ["useLeftPanelStore", useLeftPanelStore, "traycer-gui-app:left-panel"],
  ["useFileTreeStore", useFileTreeStore, "traycer-gui-app:file-tree"],
  [
    "useHistorySearchStore",
    useHistorySearchStore,
    "traycer-gui-app:history-search",
  ],
  ["useLandingDraftStore", useLandingDraftStore, "traycer-gui-app:draft"],
  [
    "useHostUpdateBannerStore",
    useHostUpdateBannerStore,
    "traycer-gui-app:host-update-banner",
  ],
  ["useKeybindingStore", useKeybindingStore, "traycer-gui-app:keybindings"],
  [
    "useLocalSnapshotClearStore",
    useLocalSnapshotClearStore,
    "traycer-gui-app:local-snapshot-clears",
  ],
  ["useSettingsStore", useSettingsStore, "traycer-gui-app:settings"],
  [
    "useSettingsSectionStore",
    useSettingsSectionStore,
    "traycer-gui-app:settings-section",
  ],
  [
    "useWorktreesSettingsViewStore",
    useWorktreesSettingsViewStore,
    "traycer-gui-app:worktrees-settings-view",
  ],
  [
    "useRateLimitPopoverStore",
    useRateLimitPopoverStore,
    "traycer-gui-app:rate-limit-popover",
  ],
  ["useTabsStore", useTabsStore, "traycer-gui-app:tabs"],
  [
    "useWorkspaceFoldersStore",
    useWorkspaceFoldersStore,
    "traycer-gui-app:workspace-folders",
  ],

  // ── Scoped singletons (initial `anon` bucket at construction) ─────────────
  [
    "useComposerRunSettingsStore",
    useComposerRunSettingsStore,
    "traycer-gui-app:composer-run-settings:anon",
  ],
  [
    "useComposerHarnessMemoryStore",
    useComposerHarnessMemoryStore,
    "traycer-gui-app:composer-harness-memory:anon",
  ],
  [
    "useWorktreeIntentMemoryStore",
    useWorktreeIntentMemoryStore,
    "traycer-gui-app:worktree-intent-memory:anon",
  ],
  [
    "useWorktreeIntentStagingStore",
    useWorktreeIntentStagingStore,
    "traycer-gui-app:worktree-intent-staging:anon",
  ],
  [
    "useEpicCanvasStore",
    useEpicCanvasStore,
    "traycer-gui-app:epic-canvas:anon",
  ],
  [
    "useAppLocalNotificationsStore",
    useAppLocalNotificationsStore,
    "traycer-gui-app:app-local-notifications:anon",
  ],
];

describe("store persist names — resolved against hand-written literals", () => {
  it.each(STORE_PERSIST_NAME_CASES)(
    "%s resolves its persist name",
    (_label, store, expectedName) => {
      expect(store.persist.getOptions().name).toBe(expectedName);
    },
  );
});
