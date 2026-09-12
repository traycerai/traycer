import { beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_USAGE_ROW_KEYS } from "@/components/chat/context-usage";
import {
  applyLayoutPreset,
  LAYOUT_PRESET_IDS,
  LAYOUT_PRESETS,
  matchLayoutPreset,
  resetLayoutToDefaults,
  type LayoutPresetBundle,
  type LayoutPresetId,
} from "@/lib/layout-presets";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_MINIMAP_SIDE,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
  useSettingsStore,
} from "@/stores/settings/settings-store";

/** What the page currently holds, read the way the group reads it. */
function currentSnapshot(): LayoutPresetBundle {
  const layout = useLayoutStore.getState();
  const settings = useSettingsStore.getState();
  return {
    // Placement is not a value a bundle carries, so it is not one the snapshot
    // offers either - see `LayoutPresetStatusBarValues`.
    statusBar: {
      rateLimits: layout.statusBar.rateLimits,
      resources: layout.statusBar.resources,
    },
    // Nor is the picker footer's reasoning CONTROL - see
    // `LayoutPresetComposerValues` - so the snapshot names the eight detail
    // rows a bundle does carry.
    composer: {
      filesChanged: layout.composer.filesChanged,
      activeAgents: layout.composer.activeAgents,
      background: layout.composer.background,
      attachImage: layout.composer.attachImage,
      access: layout.composer.access,
      mic: layout.composer.mic,
      compactButton: layout.composer.compactButton,
      reasoningIndicator: layout.composer.reasoningIndicator,
    },
    chat: {
      pinContextUsageBreakdown: settings.pinContextUsageBreakdown,
      pinnedContextBreakdownFields: settings.pinnedContextBreakdownFields,
      contextIndicatorStyle: settings.contextIndicatorStyle,
      chatTurnMinimapSide: settings.chatTurnMinimapSide,
    },
    sidebar: {
      navigatorResourceMetrics: settings.navigatorResourceMetrics,
    },
  };
}

function resetStores(): void {
  useLayoutStore.setState({
    statusBar: DEFAULT_STATUS_BAR_LAYOUT,
    composer: DEFAULT_COMPOSER_LAYOUT,
  });
  useSettingsStore.setState({
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
    navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  });
  useLeftPanelStore.getState().applyPanelGroups(DEFAULT_LEFT_PANEL_GROUPS);
  useLeftPanelStore.getState().clearPanelVisibilityOverrides();
}

beforeEach(resetStores);

describe("layout presets", () => {
  it("applies each bundle and then matches itself", () => {
    for (const id of LAYOUT_PRESET_IDS) {
      resetStores();
      applyLayoutPreset(id);
      expect(currentSnapshot()).toEqual(LAYOUT_PRESETS[id]);
      expect(matchLayoutPreset(currentSnapshot())).toBe(id);
    }
  });

  it("keeps Compact's attach-image button, and hides the mic and the compaction one", () => {
    // The three composer buttons Compact treats differently, asserted through
    // the STORE after an apply rather than off the bundle literal, because
    // that is the state the composer actually draws from. Attach image is the
    // odd one out on purpose (user ruling, 2026-09-12): paste and drag-drop
    // both need the image already in hand and neither opens a file picker,
    // while dictation has its chord and compaction has the palette and
    // `/compact`. A future tidy-up that "restores symmetry" here is the
    // regression this guards.
    applyLayoutPreset("compact");

    const composer = useLayoutStore.getState().composer;
    expect(composer.attachImage).toBe("visible");
    expect(composer.mic).toBe("hidden");
    expect(composer.compactButton).toBe("hidden");
    expect(matchLayoutPreset(currentSnapshot())).toBe("compact");
  });

  it("reports Default for the stores' own defaults, read from the DEFAULT_ constants", () => {
    // Not a copy of the values: a default that changes carries the preset with
    // it, and this fails the moment the two drift.
    expect(LAYOUT_PRESETS.default).toEqual({
      statusBar: {
        rateLimits: DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
        resources: DEFAULT_STATUS_BAR_LAYOUT.resources,
      },
      // Every value read from the constant, minus the one field no bundle
      // carries.
      composer: {
        filesChanged: DEFAULT_COMPOSER_LAYOUT.filesChanged,
        activeAgents: DEFAULT_COMPOSER_LAYOUT.activeAgents,
        background: DEFAULT_COMPOSER_LAYOUT.background,
        attachImage: DEFAULT_COMPOSER_LAYOUT.attachImage,
        access: DEFAULT_COMPOSER_LAYOUT.access,
        mic: DEFAULT_COMPOSER_LAYOUT.mic,
        compactButton: DEFAULT_COMPOSER_LAYOUT.compactButton,
        reasoningIndicator: DEFAULT_COMPOSER_LAYOUT.reasoningIndicator,
      },
      chat: {
        pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
        pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
        contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
        chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
      },
      sidebar: { navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS },
    });
    expect(matchLayoutPreset(currentSnapshot())).toBe("default");
  });

  it("is three distinct bundles", () => {
    // Two presets that matched the same values would make the pressed segment
    // a coin toss.
    for (const id of LAYOUT_PRESET_IDS) {
      const others = LAYOUT_PRESET_IDS.filter((candidate) => candidate !== id);
      for (const other of others) {
        expect(matchLayoutPreset(LAYOUT_PRESETS[other])).not.toBe(id);
      }
    }
  });

  describe("any single deviation reads as custom", () => {
    // Every scoped key, one mutation each, through the setter the row itself
    // uses. One per key rather than one per surface: a match that quietly
    // stopped comparing `percentMode` would still pass a test that only ever
    // flips `showBar`, and the whole promise of the control is that a page
    // which differs anywhere says so.
    const deviations: ReadonlyArray<{
      readonly name: string;
      readonly deviate: () => void;
    }> = [
      {
        name: "status bar: usage limits off",
        deviate: () =>
          useLayoutStore.getState().setStatusBarRateLimitsEnabled(false),
      },
      {
        name: "status bar: percent mode",
        deviate: () =>
          useLayoutStore.getState().setStatusBarPercentMode("remaining"),
      },
      {
        name: "status bar: the countdown",
        deviate: () => useLayoutStore.getState().setStatusBarShowTimer(false),
      },
      {
        name: "status bar: the mini bar",
        deviate: () => useLayoutStore.getState().setStatusBarShowBar(false),
      },
      {
        name: "status bar: the mode word",
        deviate: () =>
          useLayoutStore.getState().setStatusBarShowModeWord(false),
      },
      {
        name: "status bar: resource monitor off",
        deviate: () =>
          useLayoutStore.getState().setStatusBarResourcesEnabled(false),
      },
      {
        name: "status bar: resource scope",
        deviate: () =>
          useLayoutStore.getState().setStatusBarResourceScope("desktop-app"),
      },
      {
        name: "status bar: one resource metric",
        deviate: () =>
          useLayoutStore.getState().toggleStatusBarResourceMetric("cpu"),
      },
      {
        name: "status bar: one provider hidden",
        deviate: () =>
          useLayoutStore.getState().toggleStatusBarProvider("codex"),
      },
      {
        // Automatic ALONE cannot be switched off - the setter refuses to leave
        // a provider drawing nothing - so the isolated provider deviation is
        // one explicit pick added beside it. Automatic stays on here, which is
        // what makes this independent of the case below.
        name: "status bar: one explicit limit pick, automatic still on",
        deviate: () =>
          useLayoutStore
            .getState()
            .toggleStatusBarProviderLimit("codex", "codex:primary"),
      },
      {
        name: "composer: files changed",
        deviate: () =>
          useLayoutStore.getState().setComposerFilesChanged("compact"),
      },
      {
        name: "composer: active agents",
        deviate: () =>
          useLayoutStore.getState().setComposerActiveAgents("compact"),
      },
      {
        name: "composer: background",
        deviate: () =>
          useLayoutStore.getState().setComposerBackground("compact"),
      },
      {
        // `hidden` is no longer any bundle's value for this row - Compact
        // keeps the button - so it is a deviation from Detailed AND from the
        // only other preset that could have absorbed it.
        name: "composer: attach image",
        deviate: () =>
          useLayoutStore.getState().setComposerAttachImage("hidden"),
      },
      {
        name: "composer: access",
        deviate: () => useLayoutStore.getState().setComposerAccess("compact"),
      },
      {
        name: "composer: mic",
        deviate: () => useLayoutStore.getState().setComposerMic("hidden"),
      },
      {
        name: "composer: compact button",
        deviate: () =>
          useLayoutStore.getState().setComposerCompactButton("hidden"),
      },
      {
        name: "composer: reasoning indicator",
        deviate: () =>
          useLayoutStore.getState().setComposerReasoningIndicator("text"),
      },
      {
        name: "chat: the pin",
        deviate: () =>
          useSettingsStore.getState().setPinContextUsageBreakdown(false),
      },
      {
        name: "chat: one pinned field",
        deviate: () =>
          useSettingsStore.getState().togglePinnedContextBreakdownField("used"),
      },
      {
        name: "chat: the indicator",
        deviate: () =>
          useSettingsStore.getState().setContextIndicatorStyle("ring"),
      },
      {
        name: "chat: the minimap side",
        deviate: () => useSettingsStore.getState().setMinimapSide("hide"),
      },
      {
        name: "sidebar: one resource chip",
        deviate: () =>
          useSettingsStore.getState().toggleNavigatorResourceMetric("cpu"),
      },
    ];

    it.each(deviations)("$name", ({ deviate }) => {
      // Detailed rather than Default, so every deviation above is a real change
      // in the store rather than a no-op against a value that already held.
      applyLayoutPreset("detailed");
      expect(matchLayoutPreset(currentSnapshot())).toBe("detailed");

      deviate();

      expect(matchLayoutPreset(currentSnapshot())).toBe("custom");
    });
  });

  it.each(LAYOUT_PRESET_IDS)(
    "clears explicit limit picks and hidden providers when %s is applied",
    (id) => {
      // Seeded BEFORE the preset, which is the half the apply tests cannot
      // reach: starting from defaults, an implementation that preserved prior
      // picks would look identical to one that assigns the bundle's own empty
      // map.
      const layout = useLayoutStore.getState();
      layout.toggleStatusBarProvider("codex");
      layout.toggleStatusBarProviderLimit(
        "claude-code",
        "claude-code:fiveHour",
      );
      layout.setStatusBarProviderAutomatic("claude-code", false);
      expect(matchLayoutPreset(currentSnapshot())).toBe("custom");

      applyLayoutPreset(id);

      const rateLimits = useLayoutStore.getState().statusBar.rateLimits;
      expect(rateLimits.hiddenProviders).toEqual([]);
      expect(rateLimits.providers).toEqual({});
      expect(matchLayoutPreset(currentSnapshot())).toBe(id);
    },
  );

  it("treats a provider put back on automatic as the default selection again", () => {
    // An absent entry and an explicit automatic-only entry draw the same
    // strip, so a round trip through the per-provider rows must not leave the
    // page reading Custom with nothing on screen to undo.
    applyLayoutPreset("compact");
    const layout = useLayoutStore.getState();
    layout.toggleStatusBarProviderLimit("codex", "codex:primary");
    layout.setStatusBarProviderAutomatic("codex", false);
    expect(matchLayoutPreset(currentSnapshot())).toBe("custom");

    layout.setStatusBarProviderAutomatic("codex", true);
    layout.toggleStatusBarProviderLimit("codex", "codex:primary");

    expect(
      useLayoutStore.getState().statusBar.rateLimits.providers,
    ).not.toEqual({});
    expect(matchLayoutPreset(currentSnapshot())).toBe("compact");
  });

  it("applies the Default bundle without touching placement or the rail", () => {
    // The Default SEGMENT is the third density bundle, not a reset: a reader
    // asking for default densities has not asked to have their surfaces moved.
    // Moved OFF the default placement, so a bundle that wrote one would show
    // up here rather than coincide with it.
    useLayoutStore.getState().setStatusBarPlacement("header");
    useLeftPanelStore.getState().setPanelVisibilityOverride("terminals", false);
    applyLayoutPreset("compact");

    applyLayoutPreset("default");

    expect(matchLayoutPreset(currentSnapshot())).toBe("default");
    expect(currentSnapshot()).toEqual(LAYOUT_PRESETS.default);
    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    expect(
      useLeftPanelStore.getState().panelVisibilityOverrideById.terminals,
    ).toBe(false);
  });

  it("resets back to Default from Compact, placement and panels included", () => {
    useLayoutStore.getState().setStatusBarPlacement("header");
    useLeftPanelStore.getState().setPanelVisibilityOverride("terminals", false);
    useLeftPanelStore
      .getState()
      .applyPanelGroups([{ panelIds: ["terminals"] }, { panelIds: ["chats"] }]);
    applyLayoutPreset("compact");
    expect(matchLayoutPreset(currentSnapshot())).toBe("compact");

    // The BUTTON is the whole page: the Default bundle plus the two structural
    // settings no bundle carries.
    resetLayoutToDefaults();

    expect(matchLayoutPreset(currentSnapshot())).toBe("default");
    expect(currentSnapshot()).toEqual(LAYOUT_PRESETS.default);
    expect(useLayoutStore.getState().statusBar.placement).toBe(
      DEFAULT_STATUS_BAR_LAYOUT.placement,
    );
    expect(useLeftPanelStore.getState().panelGroups).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
    expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
      {},
    );
  });

  // The one place the literal is pinned outside the store's own suite: every
  // other read here goes through `DEFAULT_STATUS_BAR_LAYOUT`, so without this
  // the whole file would follow the constant wherever it moved.
  it("lands the strip in the FOOTER on reset, from either placement", () => {
    for (const placement of ["header", "status-bar"] as const) {
      resetStores();
      useLayoutStore.getState().setStatusBarPlacement(placement);

      resetLayoutToDefaults();

      expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
    }
  });

  it("leaves placement and the rail alone for every preset, and matches on neither", () => {
    // Both are STRUCTURAL - which surface hosts the strip, how the rail is
    // arranged - rather than levels of detail, so no bundle has anything to
    // say about them, and a Compact install with the strip in the header and a
    // reordered rail is still Compact.
    useLayoutStore.getState().setStatusBarPlacement("header");
    const arranged = [{ panelIds: ["terminals" as const] }];
    useLeftPanelStore.getState().applyPanelGroups(arranged);
    useLeftPanelStore.getState().setPanelVisibilityOverride("chats", false);

    applyLayoutPreset("compact");

    expect(matchLayoutPreset(currentSnapshot())).toBe("compact");
    expect(useLayoutStore.getState().statusBar.placement).toBe("header");
    expect(useLeftPanelStore.getState().panelGroups[0].panelIds).toContain(
      "terminals",
    );
    expect(useLeftPanelStore.getState().panelVisibilityOverrideById.chats).toBe(
      false,
    );
  });

  it("leaves the picker footer's reasoning control alone for every preset, and matches on neither", () => {
    // Structural in exactly the sense placement is: which CONTROL offers the
    // thinking levels, not how much of them shows. A reader who switched the
    // footer back to its list and then asks for a density keeps the list.
    for (const id of LAYOUT_PRESET_IDS) {
      resetStores();
      useLayoutStore.getState().setComposerReasoningFooterControl("list");

      applyLayoutPreset(id);

      expect(useLayoutStore.getState().composer.reasoningFooterControl).toBe(
        "list",
      );
      expect(matchLayoutPreset(currentSnapshot())).toBe(id);
    }
  });

  it("restores the picker footer's reasoning control on Reset, since no bundle carries it", () => {
    useLayoutStore.getState().setComposerReasoningFooterControl("list");
    applyLayoutPreset("compact");

    resetLayoutToDefaults();

    expect(useLayoutStore.getState().composer.reasoningFooterControl).toBe(
      DEFAULT_COMPOSER_LAYOUT.reasoningFooterControl,
    );
  });

  it("matches a preset wherever the strip lives, and leaves it there", () => {
    // The rule this encodes: a reader on header placement who picks a preset
    // must read that preset, not Custom - and must keep their header.
    for (const placement of ["header", "status-bar"] as const) {
      for (const id of LAYOUT_PRESET_IDS) {
        resetStores();
        useLayoutStore.getState().setStatusBarPlacement(placement);
        applyLayoutPreset(id);
        expect(useLayoutStore.getState().statusBar.placement).toBe(placement);
        expect(matchLayoutPreset(currentSnapshot())).toBe(id);
      }
    }
  });

  it("keeps each preset's own shape", () => {
    // All three bundles asserted where a reader can see them next to each
    // other rather than one field at a time.
    const compact = LAYOUT_PRESETS.compact;
    expect(compact.statusBar.rateLimits).toMatchObject({
      showModeWord: false,
      showBar: false,
      showTimer: false,
      percentMode: "used",
    });
    expect(compact.statusBar.resources).toMatchObject({
      enabled: true,
      metrics: ["cpu"],
    });
    expect(compact.composer).toMatchObject({
      filesChanged: "compact",
      activeAgents: "compact",
      background: "compact",
      access: "compact",
      attachImage: "visible",
      mic: "hidden",
      compactButton: "hidden",
      reasoningIndicator: "bars",
    });
    expect(compact.chat.pinContextUsageBreakdown).toBe(false);
    expect(compact.chat.contextIndicatorStyle).toBe("ring-only");
    expect(compact.sidebar.navigatorResourceMetrics).toEqual([]);

    const detailed = LAYOUT_PRESETS.detailed;
    expect(detailed.statusBar.rateLimits).toMatchObject({
      showModeWord: true,
      showBar: true,
      showTimer: true,
      percentMode: "used",
    });
    expect(detailed.statusBar.resources.metrics).toEqual([
      "cpu",
      "memory",
      "processes",
      "ramShare",
    ]);
    expect(
      Object.values(detailed.composer).every((mode) => mode !== "compact"),
    ).toBe(true);
    expect(detailed.composer.reasoningIndicator).toBe("bars-text");
    expect(detailed.chat.pinContextUsageBreakdown).toBe(true);
    expect(detailed.chat.pinnedContextBreakdownFields).toEqual(
      CONTEXT_USAGE_ROW_KEYS,
    );
    expect(detailed.chat.contextIndicatorStyle).toBe("text");
    expect(detailed.sidebar.navigatorResourceMetrics).toEqual([
      "cpu",
      "memory",
      "processes",
    ]);
  });

  // Home's row density was this file's `home` surface, and removing the
  // setting removed the surface. A bundle that grew the key back would make
  // `matchLayoutPreset` compare a value no store holds, which reads as
  // `Custom` on a page with nothing on it to change.
  it("carries no home surface, on any bundle", () => {
    for (const id of LAYOUT_PRESET_IDS) {
      expect(LAYOUT_PRESETS[id]).not.toHaveProperty("home");
    }
    expect(currentSnapshot()).not.toHaveProperty("home");
  });

  it("applies through the stores' setters, so every writer normalizes the same way", () => {
    // The list setters keep canonical order and the never-empty guard, which
    // is what stops a preset writing a shape the rows below it could not.
    const ids: ReadonlyArray<LayoutPresetId> = LAYOUT_PRESET_IDS;
    expect(ids.length).toBe(3);

    useSettingsStore
      .getState()
      .setNavigatorResourceMetrics(["processes", "cpu"]);
    expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
      "cpu",
      "processes",
    ]);

    useSettingsStore.getState().setPinnedContextBreakdownFields([]);
    expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual(
      DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    );
  });
});
