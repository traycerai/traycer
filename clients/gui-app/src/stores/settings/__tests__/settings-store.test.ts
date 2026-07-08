import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MODE,
  DEFAULT_PERMISSION,
} from "@/components/home/data/landing-options";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { useSettingsStore } from "@/stores/settings/settings-store";

function resetSettingsStore(): void {
  window.localStorage.clear();
  useSettingsStore.setState({
    artifactIconColorMode: "byType",
    artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
    defaultPermission: DEFAULT_PERMISSION,
    defaultAgentMode: DEFAULT_AGENT_MODE,
    defaultEditor: "vscode",
    notifyOnChatTurnComplete: true,
    showGlobalResourceMonitor: true,
    showNavigatorResourceStats: false,
    pinContextUsageBreakdown: false,
    quoteReplyEnabled: true,
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
  });
}

describe("useSettingsStore", () => {
  beforeEach(resetSettingsStore);
  afterEach(resetSettingsStore);

  it("initializes artifact icon colors from defaults", () => {
    expect(useSettingsStore.getState().artifactIconColorMode).toBe("byType");
    expect(useSettingsStore.getState().artifactIconColors).toEqual(
      DEFAULT_EPIC_NODE_ICON_COLORS,
    );
  });

  it("updates the global artifact icon color mode", () => {
    useSettingsStore.getState().setArtifactIconColorMode("none");

    expect(useSettingsStore.getState().artifactIconColorMode).toBe("none");
  });

  it("updates one artifact icon color without replacing the rest", () => {
    useSettingsStore.getState().setArtifactIconColor("ticket", "#FF00AA");

    expect(useSettingsStore.getState().artifactIconColors).toEqual({
      ...DEFAULT_EPIC_NODE_ICON_COLORS,
      ticket: "#ff00aa",
    });
  });

  it("ignores invalid artifact icon colors", () => {
    useSettingsStore.getState().setArtifactIconColor("ticket", "violet");

    expect(useSettingsStore.getState().artifactIconColors).toEqual(
      DEFAULT_EPIC_NODE_ICON_COLORS,
    );
  });

  it("rehydrates persisted artifact icon settings via default hydration", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          artifactIconColorMode: "none",
          artifactIconColors: {
            ...DEFAULT_EPIC_NODE_ICON_COLORS,
            chat: "#abcdef",
          },
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().artifactIconColorMode).toBe("none");
    expect(useSettingsStore.getState().artifactIconColors).toEqual({
      ...DEFAULT_EPIC_NODE_ICON_COLORS,
      chat: "#abcdef",
    });
  });

  it("resets artifact icon colors to defaults", () => {
    useSettingsStore.getState().setArtifactIconColor("ticket", "#ff00aa");
    useSettingsStore.getState().resetArtifactIconColors();

    expect(useSettingsStore.getState().artifactIconColors).toEqual(
      DEFAULT_EPIC_NODE_ICON_COLORS,
    );
  });

  it("defaultEditor initializes to vscode", () => {
    expect(useSettingsStore.getState().defaultEditor).toBe("vscode");
  });

  it("setDefaultEditor persists a valid editor id", () => {
    useSettingsStore.getState().setDefaultEditor("cursor");

    expect(useSettingsStore.getState().defaultEditor).toBe("cursor");
  });

  it("setDefaultEditor accepts null to clear the selection", () => {
    useSettingsStore.getState().setDefaultEditor("vscode");
    useSettingsStore.getState().setDefaultEditor(null);

    expect(useSettingsStore.getState().defaultEditor).toBeNull();
  });

  it("rehydrates a persisted defaultEditor via default hydration", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { defaultEditor: "cursor" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().defaultEditor).toBe("cursor");
  });

  it("keeps the initial defaultEditor when none is persisted", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { artifactIconColorMode: "none" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().defaultEditor).toBe("vscode");
  });

  it("defaults chat turn-completion notifications to on", () => {
    expect(useSettingsStore.getState().notifyOnChatTurnComplete).toBe(true);
  });

  it("toggles chat turn-completion notifications off", () => {
    useSettingsStore.getState().setNotifyOnChatTurnComplete(false);

    expect(useSettingsStore.getState().notifyOnChatTurnComplete).toBe(false);
  });

  it("persists the chat turn-completion notification preference", () => {
    useSettingsStore.getState().setNotifyOnChatTurnComplete(false);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain('"notifyOnChatTurnComplete":false');
  });

  it("rehydrates the chat turn-completion preference from persisted settings", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { notifyOnChatTurnComplete: false },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notifyOnChatTurnComplete).toBe(false);
  });

  it("defaults the global resource monitor button to on", () => {
    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(true);
  });

  it("toggles and persists the global resource monitor button preference", () => {
    useSettingsStore.getState().setShowGlobalResourceMonitor(false);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
    expect(persisted ?? "").toContain('"showGlobalResourceMonitor":false');
  });

  it("rehydrates the global resource monitor button preference", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { showGlobalResourceMonitor: false },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
  });

  it("defaults navigator resource stats to off", () => {
    expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(false);
  });

  it("toggles and persists navigator resource stats", () => {
    useSettingsStore.getState().setShowNavigatorResourceStats(true);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(true);
    expect(persisted ?? "").toContain('"showNavigatorResourceStats":true');
  });

  it("rehydrates navigator resource stats from persisted settings", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { showNavigatorResourceStats: true },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(true);
  });

  it("defaults the pinned context usage breakdown to off", () => {
    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
  });

  it("toggles the pinned context usage breakdown on", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
  });

  it("persists the pinned context usage breakdown preference", () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain('"pinContextUsageBreakdown":true');
  });

  it("rehydrates the pinned context usage breakdown from persisted settings", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { pinContextUsageBreakdown: true },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
  });

  it("rehydrates old settings without the field to the default off", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { artifactIconColorMode: "none" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
  });

  it("defaults quote reply on text selection to on", () => {
    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(true);
  });

  it("toggles quote reply on text selection off", () => {
    useSettingsStore.getState().setQuoteReplyEnabled(false);

    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(false);
  });

  it("persists the quote reply preference", () => {
    useSettingsStore.getState().setQuoteReplyEnabled(false);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain('"quoteReplyEnabled":false');
  });

  it("rehydrates the quote reply preference from persisted settings", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { quoteReplyEnabled: false },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(false);
  });

  it("rehydrates old settings without quoteReplyEnabled to the default on", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { artifactIconColorMode: "none" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(true);
  });

  it("defaults new chats to full access permissions", () => {
    expect(useSettingsStore.getState().defaultPermission).toBe("full_access");
  });

  it("defaults new runs to epic mode", () => {
    expect(useSettingsStore.getState().defaultAgentMode).toBe("epic");
  });

  it("persists regular mode when selected", () => {
    useSettingsStore.getState().setDefaultAgentMode("regular");
    const persistedSettings = window.localStorage.getItem(
      "traycer-gui-app:settings",
    );

    expect(useSettingsStore.getState().defaultAgentMode).toBe("regular");
    expect(persistedSettings).not.toBeNull();
    expect(persistedSettings ?? "").toContain('"defaultAgentMode":"regular"');
  });

  it("rehydrates regular mode from persisted settings", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          defaultAgentMode: "regular",
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().defaultAgentMode).toBe("regular");
  });

  it("accepts valid persisted default permissions", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          defaultPermission: "auto_accept_edits",
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().defaultPermission).toBe(
      "auto_accept_edits",
    );
  });

  it("initializes diff viewer preferences to the shared defaults", () => {
    expect(useSettingsStore.getState().diffViewerPreferences).toEqual({
      mode: "split",
      wordWrap: false,
      ignoreWhitespace: false,
      backgrounds: true,
      lineNumbers: true,
      indicatorStyle: "bars",
    });
  });

  it("replaces diff viewer preferences through the setter", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      mode: "unified",
      wordWrap: true,
      ignoreWhitespace: true,
      backgrounds: false,
      lineNumbers: false,
      indicatorStyle: "classic",
    });

    expect(useSettingsStore.getState().diffViewerPreferences).toEqual({
      mode: "unified",
      wordWrap: true,
      ignoreWhitespace: true,
      backgrounds: false,
      lineNumbers: false,
      indicatorStyle: "classic",
    });
  });

  it("patches diff viewer preferences against the latest store state", () => {
    useSettingsStore.getState().patchDiffViewerPreferences({ wordWrap: true });
    useSettingsStore
      .getState()
      .patchDiffViewerPreferences({ ignoreWhitespace: true });

    expect(useSettingsStore.getState().diffViewerPreferences).toEqual({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      wordWrap: true,
      ignoreWhitespace: true,
    });
  });

  it("persists diff viewer preferences", () => {
    useSettingsStore.getState().setDiffViewerPreferences({
      ...DEFAULT_DIFF_VIEWER_PREFERENCES,
      mode: "unified",
      ignoreWhitespace: true,
    });
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain('"mode":"unified"');
    expect(persisted ?? "").toContain('"ignoreWhitespace":true');
  });

  it("rehydrates valid persisted diff viewer preferences", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          diffViewerPreferences: {
            mode: "unified",
            wordWrap: true,
            ignoreWhitespace: true,
            backgrounds: false,
            lineNumbers: false,
            indicatorStyle: "none",
          },
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().diffViewerPreferences).toEqual({
      mode: "unified",
      wordWrap: true,
      ignoreWhitespace: true,
      backgrounds: false,
      lineNumbers: false,
      indicatorStyle: "none",
    });
  });
});
