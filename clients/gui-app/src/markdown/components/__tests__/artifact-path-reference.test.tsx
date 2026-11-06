/**
 * `ArtifactPathReference` renders the chip `rehypeTraycerArtifactReferences`
 * claims for a whole `epics/<id>/artifacts/...` path: a folder-name label for
 * an `index.md`/`index.html` leaf (the basename otherwise), opened through
 * `MarkdownLinkContext` with the untouched path - never the chipped label.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ArtifactPathReference } from "@/markdown/components/artifact-path-reference";
import {
  MarkdownLinkContext,
  type MarkdownLinkPolicy,
} from "@/markdown/links/markdown-link-context";

vi.mock("sonner", () => ({ toast: vi.fn() }));

afterEach(cleanup);

const EPIC_ID = "4f14b1e2-9c3a-4b7d-8e21-7a2c5d6f9b10";
const SCREENSHOT_PATH = `/Users/tgill/.traycer/epics/${EPIC_ID}/artifacts/md-objects-t2-degraded-strip/screenshots/index.html`;

function stubPolicy(
  openFileLink: MarkdownLinkPolicy["openFileLink"],
): MarkdownLinkPolicy {
  return { openFileLink, supersedePendingFileLink: () => undefined };
}

function renderChip(
  props: Record<string, unknown>,
  policy: MarkdownLinkPolicy | null,
) {
  return render(
    <MarkdownLinkContext.Provider value={policy}>
      <ArtifactPathReference {...props} />
    </MarkdownLinkContext.Provider>,
  );
}

describe("ArtifactPathReference label", () => {
  it("labels an index.md/index.html leaf by its containing folder, not the file name", () => {
    renderChip(
      { "data-artifact-path": SCREENSHOT_PATH, children: SCREENSHOT_PATH },
      stubPolicy(() => true),
    );

    expect(screen.getByRole("button").textContent).toBe("screenshots");
  });

  it("labels a non-index leaf by its basename", () => {
    const path = `/Users/tgill/.traycer/epics/${EPIC_ID}/artifacts/notes/bar.ts`;
    renderChip(
      { "data-artifact-path": path, children: path },
      stubPolicy(() => true),
    );

    expect(screen.getByRole("button").textContent).toBe("bar.ts");
  });

  it("preserves an authored markdown-link label instead of abbreviating it", () => {
    renderChip(
      { "data-artifact-path": SCREENSHOT_PATH, children: "the screenshot" },
      stubPolicy(() => true),
    );

    expect(screen.getByRole("button").textContent).toBe("the screenshot");
  });
});

describe("ArtifactPathReference click", () => {
  it("opens the untouched full path, carrying the parsed line/col through", () => {
    const openFileLink = vi
      .fn<MarkdownLinkPolicy["openFileLink"]>()
      .mockReturnValue(true);
    renderChip(
      {
        "data-artifact-path": SCREENSHOT_PATH,
        "data-line": 12,
        "data-col": 3,
        children: SCREENSHOT_PATH,
      },
      stubPolicy(openFileLink),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(openFileLink).toHaveBeenCalledTimes(1);
    expect(openFileLink).toHaveBeenCalledWith({
      path: SCREENSHOT_PATH,
      line: 12,
      col: 3,
      isDirectory: false,
    });
  });

  it("treats a trailing-slash path as a directory reference with no line/col", () => {
    const openFileLink = vi
      .fn<MarkdownLinkPolicy["openFileLink"]>()
      .mockReturnValue(true);
    const folderPath = `/Users/tgill/.traycer/epics/${EPIC_ID}/artifacts/notes/`;
    renderChip(
      { "data-artifact-path": folderPath, children: folderPath },
      stubPolicy(openFileLink),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(openFileLink).toHaveBeenCalledWith({
      path: folderPath,
      line: null,
      col: null,
      isDirectory: true,
    });
  });

  it("toasts when the policy refuses to open the link", () => {
    renderChip(
      { "data-artifact-path": SCREENSHOT_PATH, children: SCREENSHOT_PATH },
      stubPolicy(() => false),
    );

    fireEvent.click(screen.getByRole("button"));

    expect(toast).toHaveBeenCalledWith("Couldn’t open link");
  });
});

describe("ArtifactPathReference with no link policy in context", () => {
  it("falls back to plain text - no button, no dead click", () => {
    render(
      <ArtifactPathReference data-artifact-path={SCREENSHOT_PATH}>
        {SCREENSHOT_PATH}
      </ArtifactPathReference>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(SCREENSHOT_PATH)).toBeTruthy();
  });
});
