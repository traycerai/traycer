import { describe, expect, it } from "vitest";
import {
  PERSIST_STORES,
  composerHarnessMemoryKey,
  composerRunSettingsKey,
  epicCanvasKey,
  openEpicKey,
  persistKey,
  scopeBucket,
  worktreeIntentMemoryKey,
  worktreeIntentStagingKey,
} from "@/lib/persist/keys";

// CRITICAL: every literal below is HAND-TRANSCRIBED from the current store
// source (its `name:` / `*PersistKey` builder), NOT derived from the builders
// or a sibling constant. A wrong leaf must fail HERE, before any store adopts
// the builder. Do not "simplify" these to `persistKey(STORE_KEYS.x)` — that
// would make the test circular and unable to catch a divergence.

describe("persist key builders — output-preserving against current source", () => {
  it("emits the current localStorage key for each of the 18 static stores", () => {
    // Source: src/stores/onboarding/onboarding-store.ts
    expect(persistKey("onboarding")).toBe("traycer-gui-app:onboarding");
    // Source: src/stores/command-palette/command-palette-store.ts
    expect(persistKey("command-palette")).toBe(
      "traycer-gui-app:command-palette",
    );
    // Source: src/stores/composer/composer-draft-store.ts (plural divergence)
    expect(persistKey("composer-drafts")).toBe(
      "traycer-gui-app:composer-drafts",
    );
    // Source: src/stores/epics/artifact-read-state-store.ts
    expect(persistKey("artifact-read-state")).toBe(
      "traycer-gui-app:artifact-read-state",
    );
    // Source: src/stores/epics/git-panel-store.ts
    expect(persistKey("git-panel")).toBe("traycer-gui-app:git-panel");
    // Source: src/stores/epics/initial-chat-handoff-store.ts (plural divergence)
    expect(persistKey("initial-chat-handoffs")).toBe(
      "traycer-gui-app:initial-chat-handoffs",
    );
    // Source: src/stores/epics/left-panel-store.ts
    expect(persistKey("left-panel")).toBe("traycer-gui-app:left-panel");
    // Source: src/stores/file-tree/file-tree-store.ts
    expect(persistKey("file-tree")).toBe("traycer-gui-app:file-tree");
    // Source: src/stores/home/history-search-store.ts
    expect(persistKey("history-search")).toBe("traycer-gui-app:history-search");
    // Source: src/stores/home/landing-draft-store.ts (leaf `draft`, NOT
    // `landing-draft`).
    expect(persistKey("draft")).toBe("traycer-gui-app:draft");
    // Source: src/stores/settings/host-update-banner-store.ts
    expect(persistKey("host-update-banner")).toBe(
      "traycer-gui-app:host-update-banner",
    );
    // Source: src/stores/settings/keybinding-store.ts (plural divergence)
    expect(persistKey("keybindings")).toBe("traycer-gui-app:keybindings");
    // Source: src/stores/settings/local-snapshot-clear-store.ts (plural divergence)
    expect(persistKey("local-snapshot-clears")).toBe(
      "traycer-gui-app:local-snapshot-clears",
    );
    // Source: src/stores/settings/settings-store.ts
    expect(persistKey("settings")).toBe("traycer-gui-app:settings");
    // Source: src/stores/tabs/settings-section-store.ts (NOT a divergence)
    expect(persistKey("settings-section")).toBe(
      "traycer-gui-app:settings-section",
    );
    // Source: src/stores/rate-limits/rate-limit-popover-store.ts
    expect(persistKey("rate-limit-popover")).toBe(
      "traycer-gui-app:rate-limit-popover",
    );
    // Source: src/stores/tabs/store.ts
    expect(persistKey("tabs")).toBe("traycer-gui-app:tabs");
    // Source: src/stores/workspace/workspace-folders-store.ts
    expect(persistKey("workspace-folders")).toBe(
      "traycer-gui-app:workspace-folders",
    );
  });

  it("emits the current localStorage key for each of the 6 scoped stores", () => {
    // Source: src/stores/composer/composer-run-settings-store.ts
    // (`composerRunSettingsPersistKey`).
    expect(composerRunSettingsKey(null)).toBe(
      "traycer-gui-app:composer-run-settings:anon",
    );
    expect(composerRunSettingsKey("a@b.com")).toBe(
      "traycer-gui-app:composer-run-settings:a@b.com",
    );
    // Source: src/stores/composer/composer-harness-memory-store.ts
    // (`composerHarnessMemoryKey`).
    expect(composerHarnessMemoryKey(null)).toBe(
      "traycer-gui-app:composer-harness-memory:anon",
    );
    expect(composerHarnessMemoryKey("a@b.com")).toBe(
      "traycer-gui-app:composer-harness-memory:a@b.com",
    );
    // Source: src/stores/worktree/worktree-intent-memory-store.ts
    // (`worktreeIntentMemoryPersistKey`).
    expect(worktreeIntentMemoryKey(null)).toBe(
      "traycer-gui-app:worktree-intent-memory:anon",
    );
    expect(worktreeIntentMemoryKey("a@b.com")).toBe(
      "traycer-gui-app:worktree-intent-memory:a@b.com",
    );
    // Source: src/stores/worktree/worktree-intent-staging-store.ts
    // (`worktreeIntentStagingPersistKey`).
    expect(worktreeIntentStagingKey(null)).toBe(
      "traycer-gui-app:worktree-intent-staging:anon",
    );
    expect(worktreeIntentStagingKey("a@b.com")).toBe(
      "traycer-gui-app:worktree-intent-staging:a@b.com",
    );
    // Source: src/stores/epics/canvas/store.ts (exported `persistKey`, bucketed
    // by userId).
    expect(epicCanvasKey(null)).toBe("traycer-gui-app:epic-canvas:anon");
    expect(epicCanvasKey("u1")).toBe("traycer-gui-app:epic-canvas:u1");
    // Source: src/stores/epics/open-epic/store.ts (local
    // `persistKey(epicId, userId)` emits `…:open-epic:{userBucket}:{epicId}`).
    expect(openEpicKey(null, "e1")).toBe("traycer-gui-app:open-epic:anon:e1");
    expect(openEpicKey("u1", "e1")).toBe("traycer-gui-app:open-epic:u1:e1");
  });

  it("buckets identity values, collapsing null and empty to `anon`", () => {
    expect(scopeBucket(null)).toBe("anon");
    expect(scopeBucket("")).toBe("anon");
    expect(scopeBucket("a@b.com")).toBe("a@b.com");
  });

  it("keeps open-epic segment order bucket-then-epicId", () => {
    // Today's arg order is (userId, epicId); the emitted string must stay
    // `…:open-epic:{bucket}:{epicId}`.
    expect(openEpicKey(null, "e1")).toBe("traycer-gui-app:open-epic:anon:e1");
  });

  it("has no two catalog entries sharing a leaf", () => {
    const leaves = PERSIST_STORES.map((entry) => entry.leaf);
    expect(new Set(leaves).size).toBe(leaves.length);
  });
});
