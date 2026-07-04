import "../../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { MentionPreview } from "@/lib/composer/types";

import { MentionPreviewPanel } from "../mention-preview-panel";
import { panelFitFor } from "../mention-preview-panel-fit";

afterEach(() => {
  cleanup();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function makeListRef(activeRow: HTMLElement | null): {
  current: HTMLDivElement | null;
} {
  const list = document.createElement("div");
  document.body.appendChild(list);
  if (activeRow !== null) list.appendChild(activeRow);
  return { current: list };
}

function makeActiveRow(): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-active", "true");
  return row;
}

describe("panelFitFor", () => {
  it("shows the panel unconstrained when there's ample room on the chosen side", () => {
    const fit = panelFitFor(500, 400);
    expect(fit.fits).toBe(true);
    expect(fit.maxWidthPx).toBe(500);
    expect(fit.maxHeightPx).toBe(400);
  });

  it("shrinks the panel to the available space instead of letting it overflow", () => {
    // Regression: the panel's CSS width can request up to 22rem (352px). At
    // 220px available, that used to still report `fits: true` with nothing
    // capping the rendered width, so the panel rendered past the viewport
    // edge. It must now report a maxWidthPx that clamps it to what's there.
    const fit = panelFitFor(220, 300);
    expect(fit.fits).toBe(true);
    expect(fit.maxWidthPx).toBe(220);
    expect(fit.maxHeightPx).toBe(300);
  });

  it("hides the panel once available width drops below the readable minimum", () => {
    const fit = panelFitFor(100, 300);
    expect(fit.fits).toBe(false);
  });

  it("hides the panel once available height drops below the readable minimum", () => {
    const fit = panelFitFor(300, 30);
    expect(fit.fits).toBe(false);
  });

  it("clamps negative available space to 0 instead of an invalid CSS length", () => {
    // The reference can already overflow the boundary before `size` runs,
    // so floating-ui's available space can go negative. A negative
    // max-width/max-height is invalid and silently dropped by the CSSOM,
    // which would leave the panel unconstrained - clamp to 0 so it's always
    // a settable value, and `fits` (0 < 160) still hides the panel.
    const fit = panelFitFor(-16, -16);
    expect(fit.fits).toBe(false);
    expect(fit.maxWidthPx).toBe(0);
    expect(fit.maxHeightPx).toBe(0);
  });
});

describe("MentionPreviewPanel", () => {
  it("renders nothing when the active preview is null", async () => {
    const listRef = makeListRef(makeActiveRow());
    render(
      <MentionPreviewPanel listRef={listRef} activeIndex={0} preview={null} />,
    );
    await flush();
    expect(
      document.querySelector('[data-slot="mention-preview-panel"]'),
    ).toBeNull();
  });

  it("renders the primary and secondary preview content for a text kind", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "Fix login redirect bug",
      secondary: "Epic: Auth revamp",
      mono: false,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    expect(screen.getByText("Fix login redirect bug")).toBeTruthy();
    expect(screen.getByText("Epic: Auth revamp")).toBeTruthy();
  });

  it("omits the secondary line when null", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "some-branch",
      secondary: null,
      mono: true,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const panel = document.querySelector('[data-slot="mention-preview-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toBe("some-branch");
  });

  it("renders monospace only when the text preview says so, driven by `mono`", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "/Users/anurag/project/src/index.ts",
      secondary: null,
      mono: true,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const pathEl = screen.getByText("/Users/anurag/project/src/index.ts");
    expect(pathEl.className).toContain("font-mono");

    cleanup();

    const titleListRef = makeListRef(makeActiveRow());
    const titlePreview: MentionPreview = {
      kind: "text",
      primary: "Add the follow-selection side preview panel",
      secondary: null,
      mono: false,
    };
    render(
      <MentionPreviewPanel
        listRef={titleListRef}
        activeIndex={0}
        preview={titlePreview}
      />,
    );
    await flush();
    const titleEl = screen.getByText(
      "Add the follow-selection side preview panel",
    );
    expect(titleEl.className).not.toContain("font-mono");
  });

  it("never renders monospace for a slash-bearing title with mono: false", async () => {
    // Regression: monospace must come from the explicit `mono` flag, not a
    // heuristic on `primary`'s content - a title like "UI/UX" or
    // "client/server" contains a slash but is not a path.
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "Redesign the client/server handshake for UI/UX consistency",
      secondary: null,
      mono: false,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const titleEl = screen.getByText(
      "Redesign the client/server handshake for UI/UX consistency",
    );
    expect(titleEl.className).not.toContain("font-mono");
  });

  it("is pointer-events-none and aria-hidden so it never intercepts input", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "a1b2c3d",
      secondary: "Fix bug",
      mono: true,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const panel = document.querySelector('[data-slot="mention-preview-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(panel?.className).toContain("pointer-events-none");
  });

  it("follows content updates instantly across activeIndex changes", async () => {
    const listRef = makeListRef(makeActiveRow());
    const { rerender } = render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={{
          kind: "text",
          primary: "row-one",
          secondary: null,
          mono: false,
        }}
      />,
    );
    await flush();
    expect(screen.getByText("row-one")).toBeTruthy();

    rerender(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={1}
        preview={{
          kind: "text",
          primary: "row-two",
          secondary: "second row detail",
          mono: false,
        }}
      />,
    );
    await flush();
    expect(screen.queryByText("row-one")).toBeNull();
    expect(screen.getByText("row-two")).toBeTruthy();
    expect(screen.getByText("second row detail")).toBeTruthy();
  });

  it("wires the size middleware's available space into inline max-width/max-height", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "text",
      primary: "wired up",
      secondary: null,
      mono: false,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const panel = document.querySelector<HTMLElement>(
      '[data-slot="mention-preview-panel"]',
    );
    expect(panel).not.toBeNull();
    // jsdom has no real layout, so the exact px values just reflect its
    // fixed viewport - `panelFitFor` above covers the interesting
    // shrink-vs-hide thresholds. This only proves the `apply` callback ran
    // and constrained the element, per the fix.
    expect(panel?.style.maxWidth.endsWith("px")).toBe(true);
    expect(panel?.style.maxHeight.endsWith("px")).toBe(true);
  });

  it("renders a path kind as a breadcrumb tree with an absolute-path footer", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: "trayer/clients/gui-app/src/components",
        midDirs: ["home", "toolbar"],
        leaf: "composer-toolbar.tsx",
        leafIsFile: true,
      },
      footer: {
        text: "/Users/anurag/traycer-staging/trayer/clients/gui-app/src/components/home/toolbar/composer-toolbar.tsx",
        mono: true,
      },
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    expect(
      screen.getByText("trayer/clients/gui-app/src/components"),
    ).toBeTruthy();
    expect(screen.getByText("home")).toBeTruthy();
    expect(screen.getByText("toolbar")).toBeTruthy();
    expect(screen.getByText("composer-toolbar.tsx")).toBeTruthy();
    const footerEl = screen.getByText(
      "/Users/anurag/traycer-staging/trayer/clients/gui-app/src/components/home/toolbar/composer-toolbar.tsx",
    );
    expect(footerEl.className).toContain("font-mono");
  });

  it("collapses a deep path to the root row + at most 2 mid dirs + leaf", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: "a/b/c/d/e/f",
        midDirs: ["g", "h"],
        leaf: "deep-file.ts",
        leafIsFile: true,
      },
      footer: { text: "/repo/a/b/c/d/e/f/g/h/deep-file.ts", mono: true },
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const panel = document.querySelector('[data-slot="mention-preview-panel"]');
    expect(panel).not.toBeNull();
    // Root row + 2 mid dirs + leaf = 4 rows max, never more regardless of
    // how many segments `rootLabel` represents.
    expect(screen.getByText("a/b/c/d/e/f")).toBeTruthy();
    expect(screen.getByText("g")).toBeTruthy();
    expect(screen.getByText("h")).toBeTruthy();
    expect(screen.getByText("deep-file.ts")).toBeTruthy();
  });

  it("middle-elides an overlong root label, keeping the first segment and deepest dir", async () => {
    const listRef = makeListRef(makeActiveRow());
    const longRoot =
      "workspace-root/packages/some-service/src/very/deeply/nested/module/tree";
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: longRoot,
        midDirs: [],
        leaf: "index.ts",
        leafIsFile: true,
      },
      footer: { text: `/repo/${longRoot}/index.ts`, mono: true },
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    expect(screen.queryByText(longRoot)).toBeNull();
    expect(screen.getByText("workspace-root/…/tree")).toBeTruthy();
  });

  it("renders a folder-leaf path with a folder icon instead of a file-type icon", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: "src",
        midDirs: [],
        leaf: "auth",
        leafIsFile: false,
      },
      footer: { text: "/repo/src/auth", mono: true },
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    expect(screen.getByText("auth")).toBeTruthy();
  });

  it("renders a worktree path with a branch footer instead of a duplicated absolute path", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: "/home/u/.traycer/worktrees",
        midDirs: ["o", "r"],
        leaf: "feature-worktree",
        leafIsFile: false,
      },
      footer: { text: "feature", mono: false },
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    expect(screen.getByText("/home/u/.traycer/worktrees")).toBeTruthy();
    expect(screen.getByText("feature-worktree")).toBeTruthy();
    const footerEl = screen.getByText("feature");
    expect(footerEl.className).not.toContain("font-mono");
  });

  it("renders no footer line when the path preview's footer is null", async () => {
    const listRef = makeListRef(makeActiveRow());
    const preview: MentionPreview = {
      kind: "path",
      tree: {
        rootLabel: "/home/u/.traycer/worktrees",
        midDirs: ["o", "r"],
        leaf: "feature",
        leafIsFile: false,
      },
      footer: null,
    };
    render(
      <MentionPreviewPanel
        listRef={listRef}
        activeIndex={0}
        preview={preview}
      />,
    );
    await flush();

    const panel = document.querySelector('[data-slot="mention-preview-panel"]');
    expect(panel?.textContent).toBe("/home/u/.traycer/worktreesorfeature");
  });
});
