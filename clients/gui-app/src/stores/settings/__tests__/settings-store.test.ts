import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION } from "@/components/home/data/landing-options";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { DEFAULT_NOTIFICATION_CHIME_SOUNDS } from "@/lib/notifications/notification-chime";
import {
  DEFAULT_LINK_OPEN_SETTINGS,
  DEFAULT_TILE_PLACEMENT_SETTINGS,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  linkOpenModeForKind,
  tilePlacementForCategory,
  useSettingsStore,
  type StartPageWallpaper,
} from "@/stores/settings/settings-store";

/** Seeds localStorage with one persisted payload and rehydrates from it. */
async function rehydrateFrom(state: Record<string, unknown>): Promise<void> {
  window.localStorage.setItem(
    "traycer-gui-app:settings",
    JSON.stringify({ state, version: 1 }),
  );
  await useSettingsStore.persist.rehydrate();
}

function resetSettingsStore(): void {
  window.localStorage.clear();
  useSettingsStore.setState({
    artifactIconColorMode: "byType",
    artifactIconColors: DEFAULT_EPIC_NODE_ICON_COLORS,
    defaultPermission: DEFAULT_PERMISSION,
    defaultEditor: "vscode",
    showGlobalResourceMonitor: true,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
    pinContextUsageBreakdown: false,
    chatTurnMinimapSide: "right",
    quoteReplyEnabled: true,
    linkOpen: DEFAULT_LINK_OPEN_SETTINGS,
    browserDevOrigins: [],
    tilePlacement: DEFAULT_TILE_PLACEMENT_SETTINGS,
    agentTabSurfacing: "off",
    worktreeBranchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
    diffViewerPreferences: DEFAULT_DIFF_VIEWER_PREFERENCES,
    notificationChimeSounds: DEFAULT_NOTIFICATION_CHIME_SOUNDS,
    startPageWallpaper: null,
    showGreeting: true,
    showRecentHistory: true,
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

  it("defaults the chat turn minimap to the right side", () => {
    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("right");
  });

  it("persists and rehydrates notification chimes by event type", async () => {
    useSettingsStore
      .getState()
      .setNotificationChimeSoundForEvent("failure", "coin");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"failure":"coin"');

    useSettingsStore.setState({
      notificationChimeSounds: DEFAULT_NOTIFICATION_CHIME_SOUNDS,
    });
    if (persisted === null) throw new Error("expected persisted settings");
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notificationChimeSounds.failure).toBe(
      "coin",
    );
  });

  it("migrates the legacy single chime to every event type", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { notificationChimeSound: "ripple" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notificationChimeSounds).toEqual({
      needs_action: "ripple",
      failure: "ripple",
      done: "ripple",
      info: "ripple",
    });
  });

  it("migrates the former collaboration chime lane to info", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          notificationChimeSounds: {
            needs_action: "orbit",
            failure: "classic",
            done: "prism",
            collaboration: "coin",
          },
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notificationChimeSounds).toEqual({
      needs_action: "orbit",
      failure: "classic",
      done: "prism",
      info: "coin",
    });
  });

  it("repairs invalid persisted notification chimes independently", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          notificationChimeSounds: {
            needs_action: "coin",
            failure: "classic",
            done: "airhorn",
            info: "ripple",
          },
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notificationChimeSounds).toEqual({
      needs_action: "coin",
      failure: "classic",
      done: DEFAULT_NOTIFICATION_CHIME_SOUNDS.done,
      info: "ripple",
    });
  });

  it("uses semantic defaults when persisted notification chimes are unusable", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { notificationChimeSounds: "airhorn" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().notificationChimeSounds).toEqual(
      DEFAULT_NOTIFICATION_CHIME_SOUNDS,
    );
  });

  it("persists and rehydrates the chat turn minimap side", async () => {
    useSettingsStore.getState().setMinimapSide("left");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"chatTurnMinimapSide":"left"');

    useSettingsStore.setState({ chatTurnMinimapSide: "right" });
    if (persisted === null) throw new Error("expected persisted settings");
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("left");
  });

  it("persists and rehydrates a hidden chat turn minimap", async () => {
    useSettingsStore.getState().setMinimapSide("hide");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"chatTurnMinimapSide":"hide"');

    useSettingsStore.setState({ chatTurnMinimapSide: "right" });
    if (persisted === null) throw new Error("expected persisted settings");
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("hide");
  });

  it("repairs an invalid persisted chat turn minimap side to right", async () => {
    useSettingsStore.setState({ chatTurnMinimapSide: "left" });
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { chatTurnMinimapSide: "top" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("right");
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

  it("defaults the navigator resource chip to no metrics, as the switch defaulted to off", () => {
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });

  it("toggles one navigator metric at a time, keeps chip order and persists the list", () => {
    const { toggleNavigatorResourceMetric } = useSettingsStore.getState();

    // Picked processes first, memory second, cpu last: the list still comes
    // out in chip order, never insertion order.
    toggleNavigatorResourceMetric("processes");
    toggleNavigatorResourceMetric("memory");
    toggleNavigatorResourceMetric("cpu");
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "memory",
      "processes",
    ]);

    toggleNavigatorResourceMetric("memory");
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "processes",
    ]);

    toggleNavigatorResourceMetric("processes");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"navigatorResourceMetrics":["cpu"]');
    expect(persisted ?? "").not.toContain("showNavigatorResourceStats");

    toggleNavigatorResourceMetric("cpu");
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });

  it("rehydrates the navigator metric list, dropping unknown ids and restoring chip order", async () => {
    await rehydrateFrom({
      navigatorResourceMetrics: ["processes", "ramShare", "cpu"],
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "processes",
    ]);

    await rehydrateFrom({ navigatorResourceMetrics: [] });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });

  it("migrates the retired navigator resource switch: on becomes every metric, off becomes none", async () => {
    await rehydrateFrom({ showNavigatorResourceStats: true });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "memory",
      "processes",
    ]);

    await rehydrateFrom({ showNavigatorResourceStats: false });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });

  it("collapses duplicates when rehydrating the navigator metric list", async () => {
    await rehydrateFrom({
      navigatorResourceMetrics: ["cpu", "cpu", "memory"],
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "memory",
    ]);
  });

  it("prefers the persisted metric list over the retired switch when both are present", async () => {
    await rehydrateFrom({
      showNavigatorResourceStats: true,
      navigatorResourceMetrics: ["memory"],
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "memory",
    ]);
  });

  it("keeps an EMPTY persisted list over the retired switch, rather than resurrecting the chips", async () => {
    // A user who turned every chip off wrote `[]`; falling back to the legacy
    // `true` on that would hand all three straight back.
    await rehydrateFrom({
      showNavigatorResourceStats: true,
      navigatorResourceMetrics: [],
    });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
  });

  it("falls back to no navigator metrics when neither key is persisted or the list is malformed", async () => {
    await rehydrateFrom({});
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);

    await rehydrateFrom({ navigatorResourceMetrics: "cpu" });
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
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

  it("defaults link opening to in-app for every kind", () => {
    expect(useSettingsStore.getState().linkOpen).toEqual(
      DEFAULT_LINK_OPEN_SETTINGS,
    );
    expect(
      linkOpenModeForKind(useSettingsStore.getState().linkOpen, "github"),
    ).toBe("in-app");
    expect(useSettingsStore.getState().browserDevOrigins).toEqual([]);
  });

  it("defaults tile placement to per-category with a split browser", () => {
    expect(useSettingsStore.getState().tilePlacement).toEqual({
      default: "per-category",
      content: "tab",
      conversation: "tab",
      browser: "split",
      sideChat: "split",
    });
    const placement = useSettingsStore.getState().tilePlacement;
    expect(tilePlacementForCategory(placement, "content")).toBe("tab");
    expect(tilePlacementForCategory(placement, "browser")).toBe("split");
    expect(tilePlacementForCategory(placement, "side-chat")).toBe("split");
  });

  it("lets an explicit default override the per-kind and per-category rows", () => {
    expect(
      linkOpenModeForKind(
        {
          ...DEFAULT_LINK_OPEN_SETTINGS,
          default: "external",
          github: "in-app",
        },
        "github",
      ),
    ).toBe("external");
    expect(
      tilePlacementForCategory(
        {
          default: "split",
          content: "tab",
          conversation: "tab",
          browser: "pip",
          sideChat: "tab",
        },
        "browser",
      ),
    ).toBe("split");
    // A flat default answers for the side-chat row too - it is not exempt
    // from "default" the way `pip` is exempt from `alt`.
    expect(
      tilePlacementForCategory(
        {
          default: "split",
          content: "tab",
          conversation: "tab",
          browser: "pip",
          sideChat: "tab",
        },
        "side-chat",
      ),
    ).toBe("split");
  });

  it("patches link open settings and persists them", () => {
    useSettingsStore.getState().setLinkOpen({ default: "per-kind" });
    useSettingsStore.getState().setLinkOpen({ terminal: "external" });
    useSettingsStore.getState().addBrowserDevOrigin("http://localhost:5173");
    const linkOpen = useSettingsStore.getState().linkOpen;

    expect(linkOpen.default).toBe("per-kind");
    expect(linkOpen.terminal).toBe("external");
    expect(linkOpen.markdown).toBe("in-app");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"terminal":"external"');
    expect(persisted ?? "").toContain('"browserDevOrigins"');
  });

  it("patches tile placement settings", () => {
    useSettingsStore.getState().setTilePlacement({ browser: "pip" });

    expect(useSettingsStore.getState().tilePlacement).toEqual({
      ...DEFAULT_TILE_PLACEMENT_SETTINGS,
      browser: "pip",
    });
  });

  it("fills a missing sideChat row on a pre-row persisted blob with the default", async () => {
    await rehydrateFrom({
      tilePlacement: {
        default: "per-category",
        content: "tab",
        conversation: "tab",
        browser: "split",
      },
    });

    expect(useSettingsStore.getState().tilePlacement).toEqual({
      default: "per-category",
      content: "tab",
      conversation: "tab",
      browser: "split",
      sideChat: "split",
    });
  });

  it("repairs an invalid persisted sideChat value to the default", async () => {
    await rehydrateFrom({
      tilePlacement: {
        default: "per-category",
        content: "tab",
        conversation: "tab",
        browser: "split",
        sideChat: "pip",
      },
    });

    expect(useSettingsStore.getState().tilePlacement.sideChat).toBe("split");
  });

  it("defaults agent tab surfacing to off", () => {
    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");
  });

  it("persists the agent tab surfacing setting", () => {
    useSettingsStore.getState().setAgentTabSurfacing("surface");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"agentTabSurfacing":"surface"');
  });

  it("repairs an invalid persisted agent tab surfacing value to off", async () => {
    useSettingsStore.setState({ agentTabSurfacing: "surface" });
    await rehydrateFrom({ agentTabSurfacing: "explode" });

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");
  });

  it("migrates the legacy pip surfacing mode to surface, leaving placement alone", async () => {
    await rehydrateFrom({ agentTabSurfacingMode: "pip" });

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("surface");
    // The old key described AGENT-opened tabs; the browser placement governs
    // every browser open, so carrying `pip` across would float every link.
    expect(useSettingsStore.getState().tilePlacement).toEqual(
      DEFAULT_TILE_PLACEMENT_SETTINGS,
    );
  });

  it("migrates the legacy tile surfacing mode to surface, leaving placement alone", async () => {
    await rehydrateFrom({ agentTabSurfacingMode: "tile" });

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("surface");
    expect(useSettingsStore.getState().tilePlacement).toEqual(
      DEFAULT_TILE_PLACEMENT_SETTINGS,
    );
  });

  it("keeps the legacy off surfacing mode off with default placement", async () => {
    await rehydrateFrom({ agentTabSurfacingMode: "off" });

    expect(useSettingsStore.getState().agentTabSurfacing).toBe("off");
    expect(useSettingsStore.getState().tilePlacement).toEqual(
      DEFAULT_TILE_PLACEMENT_SETTINGS,
    );
  });

  it("carries legacy link modes into the new link shape", async () => {
    await rehydrateFrom({
      browserLinkDefaultMode: "per-kind",
      terminalBrowserLinkOpenMode: "external",
      markdownBrowserLinkOpenMode: "in-app",
    });

    expect(useSettingsStore.getState().linkOpen).toEqual({
      default: "per-kind",
      markdown: "in-app",
      terminal: "external",
      github: "in-app",
      image: "in-app",
    });
  });

  it("falls back to defaults for unknown legacy link values", async () => {
    await rehydrateFrom({
      browserLinkDefaultMode: "sideways",
      terminalBrowserLinkOpenMode: "explode",
    });

    expect(useSettingsStore.getState().linkOpen).toEqual(
      DEFAULT_LINK_OPEN_SETTINGS,
    );
  });

  it("drops the legacy keys from the next persisted write", async () => {
    await rehydrateFrom({
      agentTabSurfacingMode: "pip",
      browserLinkDefaultMode: "per-kind",
      terminalBrowserLinkOpenMode: "external",
      markdownBrowserLinkOpenMode: "in-app",
    });
    useSettingsStore.getState().setAgentTabSurfacing("off");
    const persisted =
      window.localStorage.getItem("traycer-gui-app:settings") ?? "";

    expect(persisted).not.toContain("agentTabSurfacingMode");
    expect(persisted).not.toContain("browserLinkDefaultMode");
    expect(persisted).not.toContain("BrowserLinkOpenMode");
    expect(persisted).toContain('"linkOpen"');
    expect(persisted).toContain('"tilePlacement"');
  });

  it("dedupes, trims, and removes detected browser dev origins", () => {
    for (let index = 0; index < 52; index += 1) {
      useSettingsStore
        .getState()
        .addBrowserDevOrigin(`http://localhost:${5100 + index}`);
    }
    useSettingsStore.getState().addBrowserDevOrigin("http://localhost:5151");

    const origins = useSettingsStore.getState().browserDevOrigins;
    expect(origins).toHaveLength(50);
    expect(origins[0]).toBe("http://localhost:5102");
    expect(origins.at(-1)).toBe("http://localhost:5151");

    useSettingsStore.getState().removeBrowserDevOrigin("http://localhost:5151");

    expect(useSettingsStore.getState().browserDevOrigins).not.toContain(
      "http://localhost:5151",
    );
  });

  it("defaults new chats to full access permissions", () => {
    expect(useSettingsStore.getState().defaultPermission).toBe("full_access");
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

  it("defaults the worktree branch prefix to traycer/", () => {
    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
    expect(DEFAULT_WORKTREE_BRANCH_PREFIX).toBe("traycer/");
  });

  it("updates the worktree branch prefix via the setter", () => {
    useSettingsStore.getState().setWorktreeBranchPrefix("feat-");

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
  });

  it("accepts an empty worktree branch prefix (no prefix)", () => {
    useSettingsStore.getState().setWorktreeBranchPrefix("");

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("");
  });

  it("persists the worktree branch prefix", () => {
    useSettingsStore.getState().setWorktreeBranchPrefix("anurag/");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain('"worktreeBranchPrefix":"anurag/"');
  });

  it("rehydrates a persisted worktree branch prefix", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { worktreeBranchPrefix: "feat-" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
  });

  it("rehydrates an invalid persisted worktree branch prefix to the default", async () => {
    // Leading-dash and control-char values must not rehydrate verbatim.
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { worktreeBranchPrefix: "-wip/" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("rehydrates a control-character worktree branch prefix to the default", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { worktreeBranchPrefix: "a\x01b" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("rehydrates a non-string worktree branch prefix to the default", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { worktreeBranchPrefix: 42 },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("rehydrates a null worktree branch prefix to the default", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { worktreeBranchPrefix: null },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("still shallow-merges unrelated persisted fields through the custom merge", async () => {
    // Custom merge only special-cases worktreeBranchPrefix; other fields must
    // still rehydrate via the normal shallow spread path.
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          worktreeBranchPrefix: "feat-",
          quoteReplyEnabled: false,
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe("feat-");
    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(false);
  });

  it("rehydrates old settings without worktreeBranchPrefix to the default", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { artifactIconColorMode: "none" },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().worktreeBranchPrefix).toBe(
      DEFAULT_WORKTREE_BRANCH_PREFIX,
    );
  });

  it("defaults the start-page wallpaper to null and greeting/history to shown", () => {
    expect(useSettingsStore.getState().startPageWallpaper).toBeNull();
    expect(useSettingsStore.getState().showGreeting).toBe(true);
    expect(useSettingsStore.getState().showRecentHistory).toBe(true);
  });

  it("persists and rehydrates a start-page wallpaper set via the setter", async () => {
    const wallpaper = {
      style: "dither",
      intensity: 0.8,
      tintWithAccent: false,
      name: "wallpaper.png",
      curatedId: null,
    } satisfies StartPageWallpaper;
    useSettingsStore.getState().setStartPageWallpaper(wallpaper);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    if (persisted === null) throw new Error("expected persisted settings");
    const parsedPersisted: unknown = JSON.parse(persisted);
    expect(
      (parsedPersisted as { state: { startPageWallpaper: unknown } }).state
        .startPageWallpaper,
    ).toEqual(wallpaper);

    useSettingsStore.setState({ startPageWallpaper: null });
    // `setState` writes through the persist middleware too, so it just
    // clobbered `persisted` in storage with the reset value - restore the
    // captured JSON before rehydrating, or rehydrate only re-reads the
    // clobbered `null`.
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().startPageWallpaper).toEqual(wallpaper);
  });

  it("persists and rehydrates showGreeting/showRecentHistory independently via their setters", async () => {
    useSettingsStore.getState().setShowGreeting(false);
    useSettingsStore.getState().setShowRecentHistory(false);
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    if (persisted === null) throw new Error("expected persisted settings");
    const parsedPersisted: unknown = JSON.parse(persisted);
    expect(
      (
        parsedPersisted as {
          state: { showGreeting: unknown; showRecentHistory: unknown };
        }
      ).state,
    ).toEqual(
      expect.objectContaining({
        showGreeting: false,
        showRecentHistory: false,
      }),
    );

    useSettingsStore.setState({ showGreeting: true, showRecentHistory: true });
    // `setState` writes through the persist middleware too, clobbering the
    // just-captured storage with the reset values - restore it before
    // rehydrating.
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().showGreeting).toBe(false);
    expect(useSettingsStore.getState().showRecentHistory).toBe(false);
  });

  it("rehydrates a persisted wallpaper with an unknown style to null", async () => {
    await rehydrateFrom({ startPageWallpaper: { style: "mosaic" } });

    expect(useSettingsStore.getState().startPageWallpaper).toBeNull();
  });

  it("repairs an out-of-range persisted intensity to the default, keeping the style", async () => {
    await rehydrateFrom({
      startPageWallpaper: { style: "grain", intensity: 42 },
    });

    expect(useSettingsStore.getState().startPageWallpaper).toEqual({
      style: "grain",
      intensity: 0.6,
      tintWithAccent: true,
      name: null,
      curatedId: null,
    });
  });

  it("defaults a persisted wallpaper with no tint flag to tinting with the accent", async () => {
    await rehydrateFrom({
      startPageWallpaper: { style: "dither", intensity: 0.5 },
    });

    expect(useSettingsStore.getState().startPageWallpaper).toEqual({
      style: "dither",
      intensity: 0.5,
      tintWithAccent: true,
      name: null,
      curatedId: null,
    });
  });

  it("rehydrates old settings without the appearance fields to their defaults", async () => {
    await rehydrateFrom({ artifactIconColorMode: "none" });

    expect(useSettingsStore.getState().startPageWallpaper).toBeNull();
    expect(useSettingsStore.getState().showGreeting).toBe(true);
    expect(useSettingsStore.getState().showRecentHistory).toBe(true);
  });

  it("rehydrates a persisted wallpaper with no curatedId to null", async () => {
    await rehydrateFrom({
      startPageWallpaper: { style: "photo", name: "custom.png" },
    });

    expect(
      useSettingsStore.getState().startPageWallpaper?.curatedId,
    ).toBeNull();
  });

  it("caps a persisted curatedId over 64 characters", async () => {
    const longId = "a".repeat(100);
    await rehydrateFrom({
      startPageWallpaper: { style: "photo", curatedId: longId },
    });

    expect(useSettingsStore.getState().startPageWallpaper?.curatedId).toBe(
      "a".repeat(64),
    );
  });

  it("rehydrates a non-string persisted curatedId to null", async () => {
    await rehydrateFrom({
      startPageWallpaper: { style: "photo", curatedId: 42 },
    });

    expect(
      useSettingsStore.getState().startPageWallpaper?.curatedId,
    ).toBeNull();
  });

  it("picks up another window's settings write via the cross-window storage listener", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({ state: { showGreeting: false }, version: 1 }),
    );

    window.dispatchEvent(
      new StorageEvent("storage", { key: "traycer-gui-app:settings" }),
    );
    // The listener's rehydrate is fire-and-forget (`void ... rehydrate()`).
    await Promise.resolve();
    await Promise.resolve();

    expect(useSettingsStore.getState().showGreeting).toBe(false);
  });

  it("treats a storage event with a null key (localStorage.clear()) as a rehydrate signal too", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({ state: { showRecentHistory: false }, version: 1 }),
    );

    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useSettingsStore.getState().showRecentHistory).toBe(false);
  });

  it("ignores a storage event for an unrelated key", async () => {
    useSettingsStore.getState().setShowGreeting(false);
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({ state: { showGreeting: true }, version: 1 }),
    );

    window.dispatchEvent(
      new StorageEvent("storage", { key: "some-other-app:settings" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Still false: the mismatched-key event must not have triggered a rehydrate.
    expect(useSettingsStore.getState().showGreeting).toBe(false);
  });
});
