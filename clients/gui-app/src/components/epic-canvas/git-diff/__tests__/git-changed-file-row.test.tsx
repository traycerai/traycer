import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitChangedFile } from "@traycer/protocol/host";
import { GitChangedFileRow } from "@/components/epic-canvas/git-diff/git-changed-file-row";
import { NO_HIGHLIGHT, type HighlightRanges } from "@/lib/git/path-highlight";

afterEach(() => {
  cleanup();
});

function makeFile(args: {
  readonly path: string;
  readonly previousPath: string | null;
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: args.previousPath,
    status: "modified",
    stage: "unstaged",
    insertions: 3,
    deletions: 1,
    isBinary: false,
    sizeBytes: 0,
    stagedOid: null,
    worktreeOid: null,
  };
}

function renderRow(args: {
  readonly file: GitChangedFile;
  readonly density: "panel" | "tile";
  readonly active: boolean;
  readonly pathRanges: HighlightRanges;
}) {
  return render(
    <GitChangedFileRow
      file={args.file}
      density={args.density}
      active={args.active}
      leading={null}
      trailing={null}
      pathRanges={args.pathRanges}
      onClick={() => {}}
      onDoubleClick={undefined}
      ariaExpanded={undefined}
      className={undefined}
    />,
  );
}

describe("GitChangedFileRow panel density", () => {
  it("shows the basename with the dimmed directory and counts", () => {
    renderRow({
      file: makeFile({ path: "src/routes/epic/index.ts", previousPath: null }),
      density: "panel",
      active: false,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", {
      name: "Modified index.ts in src/routes/epic",
    });
    expect(row.textContent).toContain("index.ts");
    expect(row.textContent).toContain("src/routes/epic");
    expect(row.textContent).toContain("+3");
    expect(row.textContent).toContain("-1");
  });

  it("omits the directory for repository-root files", () => {
    renderRow({
      file: makeFile({ path: "README.md", previousPath: null }),
      density: "panel",
      active: false,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", { name: "Modified README.md" });
    expect(row.textContent).not.toContain("Repository root");
  });

  it("emphasizes matched characters across the filename and directory", () => {
    // "src/routes/epic/index.ts": match "routes" (dir, 4-9) and "index" (file,
    // 16-20) so both displayed spans get highlight <mark>s.
    const ranges: HighlightRanges = [
      [4, 9],
      [16, 20],
    ];
    const { container } = renderRow({
      file: makeFile({ path: "src/routes/epic/index.ts", previousPath: null }),
      density: "panel",
      active: false,
      pathRanges: ranges,
    });

    const marks = Array.from(container.querySelectorAll("mark"));
    const marked = marks.map((mark) => mark.textContent);
    expect(marked).toContain("routes");
    expect(marked).toContain("index");
  });

  it("uses no native title - the Radix path tooltip owns row hover", () => {
    renderRow({
      file: makeFile({ path: "src/app.tsx", previousPath: null }),
      density: "panel",
      active: false,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", {
      name: "Modified app.tsx in src",
    });
    expect(row.getAttribute("title")).toBeNull();
  });

  it("marks the active row with aria-current and accent styling", () => {
    renderRow({
      file: makeFile({ path: "src/app.tsx", previousPath: null }),
      density: "panel",
      active: true,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", {
      name: "Modified app.tsx in src",
    });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("bg-accent");
    // Regression: tailwind-merge used to misread text-ui-sm as a color and
    // drop it once text-accent-foreground joined the merge, so the active
    // row rendered at the larger inherited font size.
    expect(row.className).toContain("text-ui-sm");
    expect(row.className).toContain("text-accent-foreground");
  });

  it("leaves inactive rows without aria-current", () => {
    renderRow({
      file: makeFile({ path: "src/app.tsx", previousPath: null }),
      density: "panel",
      active: false,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", {
      name: "Modified app.tsx in src",
    });
    expect(row.getAttribute("aria-current")).toBeNull();
  });
});

describe("GitChangedFileRow tile density", () => {
  it("keeps the native title tooltip", () => {
    renderRow({
      file: makeFile({ path: "src/app.tsx", previousPath: null }),
      density: "tile",
      active: false,
      pathRanges: NO_HIGHLIGHT,
    });

    const row = screen.getByRole("button", { name: "Modified app.tsx" });
    expect(row.getAttribute("title")).toBe("src/app.tsx");
  });
});
