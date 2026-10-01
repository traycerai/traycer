import { describe, expect, it } from "vitest";
import {
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  retainDisplayedPrPanel,
  resolveDisplayedPanelId,
  type LeftPanelAvailabilityContext,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { DEFAULT_LEFT_PANEL_ID } from "@/stores/epics/left-panel-store";
import { type LeftPanelId } from "@/lib/left-panel-ids";
import { RAIL_REGION_BY_PANEL, type RailEntry } from "@/lib/layout/rail";

/** A rail holding exactly these panels, in this order. */
function railOf(
  panelIds: ReadonlyArray<LeftPanelId>,
): ReadonlyArray<RailEntry> {
  return panelIds.map((panelId): RailEntry => ({
    kind: "panel",
    id: RAIL_REGION_BY_PANEL[panelId],
  }));
}

const BASE_CONTEXT: LeftPanelAvailabilityContext = {
  commentsPanelRevealed: false,
  hasActiveCommentableArtifact: false,
  hasPullRequests: false,
  visibilityOverrideById: {},
};

function context(
  overrides: Partial<LeftPanelAvailabilityContext>,
): LeftPanelAvailabilityContext {
  return { ...BASE_CONTEXT, ...overrides };
}

function definition(panelId: LeftPanelId): LeftPanelMetadataDefinition {
  const found = LEFT_PANEL_DEFINITIONS.find(
    (candidate) => candidate.id === panelId,
  );
  if (found === undefined) throw new Error(`No definition for "${panelId}"`);
  return found;
}

function isVisible(
  panelId: LeftPanelId,
  overrides: Partial<LeftPanelAvailabilityContext>,
): boolean {
  return isLeftPanelVisible(definition(panelId), context(overrides));
}

describe("epic left panel registry", () => {
  it("keeps chats as the default first panel", () => {
    expect(LEFT_PANEL_DEFINITIONS.map((entry) => entry.id)).toEqual([
      "chats",
      "terminals",
      "browsers",
      "artifacts",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
    expect(LEFT_PANEL_DEFINITIONS[0]?.id).toBe(DEFAULT_LEFT_PANEL_ID);
  });

  it("always exposes non-contextual panels", () => {
    // `git-diff` and `file-tree` stay in the registry so persisted
    // layouts keep resolving to a valid definition, but they are gated
    // until a real backend RPC lands. They are intentionally excluded
    // from the always-visible set.
    const alwaysVisiblePanelIds: ReadonlyArray<LeftPanelId> = [
      "chats",
      "terminals",
      "browsers",
      "artifacts",
      "sharing",
    ];
    expect(
      alwaysVisiblePanelIds.every((panelId) => isVisible(panelId, {})),
    ).toBe(true);
  });

  it("shows comments only after reveal with a commentable active artifact", () => {
    expect(isVisible("comments", { hasActiveCommentableArtifact: true })).toBe(
      false,
    );
    expect(isVisible("comments", { commentsPanelRevealed: true })).toBe(false);
    expect(
      isVisible("comments", {
        commentsPanelRevealed: true,
        hasActiveCommentableArtifact: true,
      }),
    ).toBe(true);
  });

  it("hides pull requests until the epic has one", () => {
    expect(isVisible("pull-requests", {})).toBe(false);
    expect(isVisible("pull-requests", { hasPullRequests: true })).toBe(true);
  });

  describe("visibility overrides", () => {
    it("reveals a presence-gated panel the user checked", () => {
      expect(
        isVisible("pull-requests", {
          visibilityOverrideById: { "pull-requests": true },
        }),
      ).toBe(true);
      expect(
        isVisible("comments", { visibilityOverrideById: { comments: true } }),
      ).toBe(true);
    });

    it("hides a panel the user unchecked, whatever its own rule says", () => {
      expect(
        isVisible("chats", { visibilityOverrideById: { chats: false } }),
      ).toBe(false);
      expect(
        isVisible("pull-requests", {
          hasPullRequests: true,
          visibilityOverrideById: { "pull-requests": false },
        }),
      ).toBe(false);
    });

    it("leaves unlisted panels on their own rule", () => {
      const overrides: Partial<LeftPanelAvailabilityContext> = {
        visibilityOverrideById: { chats: false },
      };
      expect(isVisible("terminals", overrides)).toBe(true);
      expect(isVisible("pull-requests", overrides)).toBe(false);
    });

    it("carries a hint for every panel that can be forced on", () => {
      // A forced-on panel can legitimately be empty, and the menu explains why.
      // Any panel that is ever auto-hidden therefore owes the user a reason.
      const contexts = [
        context({}),
        context({ hasPullRequests: true }),
        context({
          commentsPanelRevealed: true,
          hasActiveCommentableArtifact: true,
        }),
      ];
      for (const entry of LEFT_PANEL_DEFINITIONS) {
        const alwaysAutoVisible = contexts.every((candidate) =>
          entry.isAutoVisible(candidate),
        );
        expect(entry.forcedOnHint === null).toBe(alwaysAutoVisible);
      }
    });
  });

  describe("resolveDisplayedPanelId", () => {
    it("draws the active panel when it is visible", () => {
      expect(
        resolveDisplayedPanelId(
          ["chats", "terminals", "artifacts", "sharing"],
          "artifacts",
        ),
      ).toBe("artifacts");
    });

    it("falls back to the default panel when the active one is hidden", () => {
      expect(resolveDisplayedPanelId(["terminals", "chats"], "sharing")).toBe(
        DEFAULT_LEFT_PANEL_ID,
      );
    });

    it("falls back to the first visible panel when the default is hidden too", () => {
      // Hiding Agents must not resurrect it: the body renders whatever is
      // still in the rail, and the rail highlights that same icon.
      expect(resolveDisplayedPanelId(["terminals", "sharing"], "chats")).toBe(
        "terminals",
      );
    });

    it("reports nothing visible", () => {
      expect(resolveDisplayedPanelId([], "chats")).toBeNull();
    });
  });

  describe("retainDisplayedPrPanel", () => {
    it("retains PRs while the user is looking at them", () => {
      const retained = retainDisplayedPrPanel(
        railOf(["chats", "pull-requests", "terminals"]),
        "pull-requests",
        context({}),
      );

      expect(retained.hasPullRequests).toBe(true);
    });

    it("retains PRs when they are the panel the body falls back to", () => {
      // Every panel before Pull Requests is hidden, including Agents, so the
      // body lands on PRs even though nothing selected it.
      const retained = retainDisplayedPrPanel(
        railOf(["chats", "pull-requests"]),
        "terminals",
        context({
          visibilityOverrideById: { chats: false, terminals: false },
        }),
      );

      expect(retained.hasPullRequests).toBe(true);
    });

    it("does not retain PRs behind a panel the body is actually drawing", () => {
      const retained = retainDisplayedPrPanel(
        railOf(["chats", "pull-requests"]),
        "chats",
        context({}),
      );

      expect(retained.hasPullRequests).toBe(false);
    });

    it("does not bypass an explicit Pull Requests hide", () => {
      const retained = retainDisplayedPrPanel(
        railOf(["chats", "pull-requests"]),
        "pull-requests",
        context({
          visibilityOverrideById: { "pull-requests": false },
        }),
      );

      expect(retained.hasPullRequests).toBe(false);
    });
  });
});
