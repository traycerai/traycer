import { describe, expect, it } from "vitest";
import {
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  resolveActiveVisibleGroupIndex,
  type LeftPanelAvailabilityContext,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  DEFAULT_LEFT_PANEL_ID,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";

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

  describe("resolveActiveVisibleGroupIndex", () => {
    it("picks the group holding the active panel", () => {
      expect(
        resolveActiveVisibleGroupIndex(
          [["chats"], ["terminals", "artifacts"], ["sharing"]],
          "artifacts",
        ),
      ).toBe(1);
    });

    it("falls back to the default panel's group when the active one is hidden", () => {
      expect(
        resolveActiveVisibleGroupIndex([["terminals"], ["chats"]], "sharing"),
      ).toBe(1);
    });

    it("falls back to the first visible group when the default is hidden too", () => {
      // Hiding Agents must not resurrect it: the body renders whatever is
      // still in the rail, and the rail highlights that same group.
      expect(
        resolveActiveVisibleGroupIndex([["terminals"], ["sharing"]], "chats"),
      ).toBe(0);
    });

    it("reports nothing visible", () => {
      expect(resolveActiveVisibleGroupIndex([], "chats")).toBeNull();
    });
  });
});
