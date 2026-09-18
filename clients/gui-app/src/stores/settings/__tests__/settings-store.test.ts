import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMISSION } from "@/components/home/data/landing-options";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { DEFAULT_NOTIFICATION_CHIME_SOUNDS } from "@/lib/notifications/notification-chime";
import { CONTEXT_USAGE_ROW_KEYS } from "@/components/chat/context-usage";
import {
  DEFAULT_AGENT_OFFICE_VIEW,
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_LINK_OPEN_SETTINGS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
  DEFAULT_TILE_PLACEMENT_SETTINGS,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  isVisualLayoutEditorEnabled,
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
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    pinnedContextBreakdownOrder: DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: "right",
    agentOfficeDefaultView: DEFAULT_AGENT_OFFICE_VIEW,
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
    visualLayoutEditorEnabled: false,
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

  it("defaults the agent office default view to auto", () => {
    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("auto");
  });

  it("persists and rehydrates the agent office default view for auto", async () => {
    useSettingsStore.getState().setAgentOfficeDefaultView("auto");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"agentOfficeDefaultView":"auto"');

    useSettingsStore.setState({ agentOfficeDefaultView: "towers" });
    if (persisted === null) throw new Error("expected persisted settings");
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("auto");
  });

  it("persists and rehydrates the agent office default view for a real view id", async () => {
    useSettingsStore.getState().setAgentOfficeDefaultView("towers");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"agentOfficeDefaultView":"towers"');

    useSettingsStore.setState({ agentOfficeDefaultView: "auto" });
    if (persisted === null) throw new Error("expected persisted settings");
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("towers");
  });

  it("repairs a non-string persisted agent office default view to auto", async () => {
    useSettingsStore.setState({ agentOfficeDefaultView: "towers" });
    await rehydrateFrom({ agentOfficeDefaultView: 42 });

    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("auto");
  });

  it("repairs a persisted agent office default view naming an unregistered view to auto", async () => {
    useSettingsStore.setState({ agentOfficeDefaultView: "towers" });
    // Not in OFFICE_VIEW_IDS at any build - a value a newer one wrote and this
    // one cannot plan.
    await rehydrateFrom({ agentOfficeDefaultView: "atrium" });

    expect(useSettingsStore.getState().agentOfficeDefaultView).toBe("auto");
  });

  it("keeps a valid persisted agent office default generation", async () => {
    useSettingsStore.setState({ agentOfficeDefaultViewGeneration: 0 });
    await rehydrateFrom({ agentOfficeDefaultViewGeneration: 7 });

    expect(useSettingsStore.getState().agentOfficeDefaultViewGeneration).toBe(
      7,
    );
  });

  it.each([
    ["a string", "5"],
    ["a negative number", -1],
    ["a fractional number", 1.5],
    ["NaN", Number.NaN],
  ])(
    "repairs a persisted agent office default generation that is %s to 0",
    async (_label, value) => {
      useSettingsStore.setState({ agentOfficeDefaultViewGeneration: 9 });
      await rehydrateFrom({ agentOfficeDefaultViewGeneration: value });

      expect(useSettingsStore.getState().agentOfficeDefaultViewGeneration).toBe(
        0,
      );
    },
  );

  it("rolls the agent office default view generation to a collision-free random stamp on a real change, not a per-window +1 counter (Finding 37)", () => {
    // Codex: the generation is compared by EQUALITY and rehydrates across
    // windows via storage events, so a per-window `+1` counter let two
    // windows land on the SAME next value for two DIFFERENT changes. The
    // fix rolls to `Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)`
    // instead - stubbed here to a fixed draw so the new generation is an
    // exact, deterministic number to assert on rather than merely "some
    // number that isn't G+1".
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      useSettingsStore.setState({
        agentOfficeDefaultView: "auto",
        agentOfficeDefaultViewGeneration: 5,
      });

      useSettingsStore.getState().setAgentOfficeDefaultView("towers");

      const generation =
        useSettingsStore.getState().agentOfficeDefaultViewGeneration;
      expect(generation).toBe(Math.floor(0.25 * Number.MAX_SAFE_INTEGER));
      // The distinguishing assertion: not the old `+1` counter's answer.
      expect(generation).not.toBe(6);
    } finally {
      random.mockRestore();
    }
  });

  it("does not roll the agent office default view generation when the value does not actually change (Finding 37)", () => {
    // The setter's own no-op guard (`s.agentOfficeDefaultView === value ? s
    // : {...}`) - setting the SAME value is not a "real change" and must not
    // burn a fresh stamp, collision-free or not.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      useSettingsStore.setState({
        agentOfficeDefaultView: "towers",
        agentOfficeDefaultViewGeneration: 42,
      });

      useSettingsStore.getState().setAgentOfficeDefaultView("towers");

      expect(useSettingsStore.getState().agentOfficeDefaultViewGeneration).toBe(
        42,
      );
    } finally {
      random.mockRestore();
    }
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

  it("defaults the pinned context breakdown to every field in strip order", () => {
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
      "used",
      "fresh",
      "cacheRead",
      "cacheWrite",
      "output",
    ]);
  });

  it("toggles pinned context breakdown fields off and back on in canonical order", () => {
    const { togglePinnedContextBreakdownField } = useSettingsStore.getState();

    togglePinnedContextBreakdownField("used");
    togglePinnedContextBreakdownField("cacheRead");
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
      "fresh",
      "cacheWrite",
      "output",
    ]);

    // Re-inserted where the strip draws it, not appended.
    togglePinnedContextBreakdownField("used");
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
      "used",
      "fresh",
      "cacheWrite",
      "output",
    ]);
  });

  it("refuses to toggle off the last pinned context breakdown field", () => {
    useSettingsStore.setState({ pinnedContextBreakdownFields: ["output"] });
    const before = useSettingsStore.getState().pinnedContextBreakdownFields;

    useSettingsStore.getState().togglePinnedContextBreakdownField("output");

    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toBe(
      before,
    );
  });

  it("persists the pinned context breakdown fields", () => {
    useSettingsStore.getState().togglePinnedContextBreakdownField("fresh");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");

    expect(persisted ?? "").toContain(
      '"pinnedContextBreakdownFields":["used","cacheRead","cacheWrite","output"]',
    );
  });

  it("drops unknown pinned context breakdown fields and restores canonical order on rehydrate", async () => {
    await rehydrateFrom({
      pinnedContextBreakdownFields: ["output", "baseline", "used", "used", 42],
    });

    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
      "used",
      "output",
    ]);
  });

  it("falls back to every pinned context breakdown field when the persisted list is empty or not a list", async () => {
    await rehydrateFrom({ pinnedContextBreakdownFields: ["baseline"] });
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    );

    await rehydrateFrom({ pinnedContextBreakdownFields: "used" });
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    );
  });

  it("defaults the context indicator style to text", () => {
    expect(useSettingsStore.getState().contextIndicatorStyle).toBe("text");
  });

  it("persists and rehydrates the context indicator style", async () => {
    useSettingsStore.getState().setContextIndicatorStyle("ring-only");
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    expect(persisted ?? "").toContain('"contextIndicatorStyle":"ring-only"');
    if (persisted === null) throw new Error("expected persisted settings");

    resetSettingsStore();
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().contextIndicatorStyle).toBe("ring-only");
  });

  it("repairs an invalid persisted context indicator style to text", async () => {
    await rehydrateFrom({ contextIndicatorStyle: "donut" });

    expect(useSettingsStore.getState().contextIndicatorStyle).toBe("text");
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

  it("defaults the browser search engine to google", () => {
    expect(useSettingsStore.getState().browserSearchEngine).toBe("google");
  });

  it("falls back an invalid persisted browser search engine to google", async () => {
    useSettingsStore.setState({ browserSearchEngine: "kagi" });
    await rehydrateFrom({ browserSearchEngine: "altavista" });

    expect(useSettingsStore.getState().browserSearchEngine).toBe("google");
  });

  it("falls back a missing persisted browser search engine to google", async () => {
    useSettingsStore.setState({ browserSearchEngine: "bing" });
    await rehydrateFrom({});

    expect(useSettingsStore.getState().browserSearchEngine).toBe("google");
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

  it("starts the pinned breakdown order on the canonical order", () => {
    expect(useSettingsStore.getState().pinnedContextBreakdownOrder).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_ORDER,
    );
  });

  it("keeps the pinned breakdown order complete through a partial write", () => {
    const [first, second] = CONTEXT_USAGE_ROW_KEYS;

    // A caller naming two fields is not narrowing the order to two - the order
    // is complete by construction, so the rest merge back in beside their
    // canonical neighbours. The swap the caller DID ask for survives; where
    // the unnamed rows land is `mergeOrder`'s neighbour rule, not this field's
    // business.
    useSettingsStore.getState().setPinnedContextBreakdownOrder([second, first]);

    const order = useSettingsStore.getState().pinnedContextBreakdownOrder;
    expect(order.length).toBe(CONTEXT_USAGE_ROW_KEYS.length);
    expect(new Set(order)).toEqual(new Set(CONTEXT_USAGE_ROW_KEYS));
    expect(order.indexOf(second)).toBeLessThan(order.indexOf(first));
  });

  it("repairs a hand-edited pinned breakdown order on rehydrate", async () => {
    const [first] = CONTEXT_USAGE_ROW_KEYS;

    await rehydrateFrom({
      pinnedContextBreakdownOrder: ["not-a-row", first, first],
    });

    const order = useSettingsStore.getState().pinnedContextBreakdownOrder;
    expect(order.length).toBe(CONTEXT_USAGE_ROW_KEYS.length);
    expect(order[0]).toBe(first);
    // The SELECTED set is untouched by any of this: it is a different field.
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    );
  });

  it("starts with the Customize switch off and persists a flip", async () => {
    expect(useSettingsStore.getState().visualLayoutEditorEnabled).toBe(false);
    expect(isVisualLayoutEditorEnabled()).toBe(false);

    useSettingsStore.getState().setVisualLayoutEditorEnabled(true);
    expect(isVisualLayoutEditorEnabled()).toBe(true);

    const persisted: unknown = JSON.parse(
      window.localStorage.getItem("traycer-gui-app:settings") ?? "{}",
    );
    expect(persisted).toMatchObject({
      state: { visualLayoutEditorEnabled: true },
    });

    await rehydrateFrom({ visualLayoutEditorEnabled: true });
    expect(useSettingsStore.getState().visualLayoutEditorEnabled).toBe(true);
  });

  it("rehydrates a non-boolean Customize switch as off", async () => {
    // Same narrowing `homeTabEnabled` gets: this flag swaps a whole settings
    // page, so a truthy string must not turn the editor on.
    await rehydrateFrom({ visualLayoutEditorEnabled: "yes" });

    expect(useSettingsStore.getState().visualLayoutEditorEnabled).toBe(false);
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
