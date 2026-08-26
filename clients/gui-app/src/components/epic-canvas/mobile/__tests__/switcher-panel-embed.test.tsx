import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitcherPanelEmbed } from "@/components/epic-canvas/mobile/switcher-panel-embed";

// Embed, don't fork: the desktop bodies pull host queries + Pierre + the epic
// session, so stub them at the module boundary and assert the embed routes each
// category to the right body.
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar", () => ({
  FileTreePanelBody: () => <div data-testid="file-tree-body" />,
}));
vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-body-live", () => ({
  GitDiffPanelBodyLive: () => <div data-testid="git-diff-body" />,
}));
vi.mock("@/components/epic-canvas/pr/pr-panel-body", () => ({
  PrPanelBody: () => <div data-testid="pr-panel-body" />,
}));
vi.mock("@/components/epic-canvas/panels/epic-sharing/panel", () => ({
  SharingPanel: (props: { readonly epicId: string }) => (
    <div data-testid="sharing-panel-body" data-epic-id={props.epicId} />
  ),
}));

describe("<SwitcherPanelEmbed />", () => {
  afterEach(cleanup);

  it("embeds the file-tree body for the file-tree category", () => {
    render(<SwitcherPanelEmbed category="file-tree" epicId="e" tabId="t" />);
    expect(screen.getByTestId("file-tree-body")).toBeTruthy();
    expect(screen.queryByTestId("git-diff-body")).toBeNull();
  });

  it("embeds the git-diff body for the git-diff category", () => {
    render(<SwitcherPanelEmbed category="git-diff" epicId="e" tabId="t" />);
    expect(screen.getByTestId("git-diff-body")).toBeTruthy();
    expect(screen.queryByTestId("file-tree-body")).toBeNull();
  });

  it("embeds the desktop PR panel body for the pull-requests category", () => {
    render(
      <SwitcherPanelEmbed category="pull-requests" epicId="e" tabId="t" />,
    );
    expect(screen.getByTestId("pr-panel-body")).toBeTruthy();
    expect(screen.queryByTestId("file-tree-body")).toBeNull();
    expect(screen.queryByTestId("git-diff-body")).toBeNull();
  });

  it("embeds the desktop sharing panel for the sharing category", () => {
    render(<SwitcherPanelEmbed category="sharing" epicId="e" tabId="t" />);
    const body = screen.getByTestId("sharing-panel-body");
    expect(body.dataset.epicId).toBe("e");
    expect(screen.queryByTestId("pr-panel-body")).toBeNull();
  });

  // The sharing panel is the one embedded body with no scroller of its own - on
  // desktop the sidebar's scroll region supplies it - so the embed must.
  it("gives the sharing panel a scroll region the other embeds own themselves", () => {
    const { container } = render(
      <SwitcherPanelEmbed category="sharing" epicId="e" tabId="t" />,
    );
    expect(container.querySelector(".overflow-y-auto")).toBeTruthy();
  });
});
