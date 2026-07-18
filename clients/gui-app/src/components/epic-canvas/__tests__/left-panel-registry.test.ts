import { describe, expect, it } from "vitest";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { DEFAULT_LEFT_PANEL_ID } from "@/stores/epics/left-panel-store";

describe("epic left panel registry", () => {
  it("keeps chats as the default first panel", () => {
    expect(LEFT_PANEL_DEFINITIONS.map((definition) => definition.id)).toEqual([
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
    const context = {
      commentsPanelRevealed: false,
      hasActiveCommentableArtifact: false,
    };
    // `git-diff` and `file-tree` stay in the registry so persisted
    // layouts keep resolving to a valid definition, but they are gated
    // until a real backend RPC lands. They are intentionally excluded
    // from the always-visible set.
    const alwaysVisiblePanelIds = [
      "chats",
      "terminals",
      "artifacts",
      "sharing",
    ];
    expect(
      alwaysVisiblePanelIds.every(
        (panelId) =>
          LEFT_PANEL_DEFINITIONS.find(
            (definition) => definition.id === panelId,
          )?.isVisible(context) === true,
      ),
    ).toBe(true);
  });

  it("shows comments only after reveal with a commentable active artifact", () => {
    const commentsDefinition = LEFT_PANEL_DEFINITIONS.find(
      (definition) => definition.id === "comments",
    );

    expect(
      commentsDefinition?.isVisible({
        commentsPanelRevealed: false,
        hasActiveCommentableArtifact: true,
      }),
    ).toBe(false);
    expect(
      commentsDefinition?.isVisible({
        commentsPanelRevealed: true,
        hasActiveCommentableArtifact: false,
      }),
    ).toBe(false);
    expect(
      commentsDefinition?.isVisible({
        commentsPanelRevealed: true,
        hasActiveCommentableArtifact: true,
      }),
    ).toBe(true);
  });
});
