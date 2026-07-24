/**
 * Drives the Files opener result rows through the REAL `<Command>` filtering
 * pipeline (`filter={paletteFilter}`) to prove the fixup: when cmdk filtering is
 * disabled for a Files host-result sub-page, a non-subsequence/typo live query
 * neither hides the host-ranked rows (host Fuse order is preserved) nor the
 * typed notice/truncation rows. The companion `shouldFilter` case shows cmdk
 * WOULD hide them, i.e. why the fix is needed. `isFilesResultSubpageId` (which
 * `pane-opener` uses to compute `shouldFilter`) is unit-checked alongside.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
import { paletteFilter } from "@/components/command-palette/palette-cmdk-controller";
import { SubpageView } from "@/components/command-palette/palette-cmdk";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import {
  filesArtifactsResultSubpageId,
  filesCodeRootResultSubpageId,
  isFilesResultSubpageId,
} from "@/lib/commands/sources/open/files-result-subpage";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    navigateNestedFocus: vi.fn(),
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

function actionRow(id: string, label: string): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [label],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
  };
}

function noticeRow(id: string, label: string): CommandItem {
  return { ...actionRow(id, label), keywords: [] };
}

function renderPipeline(args: {
  readonly shouldFilter: boolean;
  readonly query: string;
  readonly items: ReadonlyArray<CommandItem>;
}) {
  const subpage: CommandSubpage = {
    id: filesArtifactsResultSubpageId(),
    title: "Artifacts",
    useItems: () => args.items,
  };
  return render(
    <Command filter={paletteFilter} shouldFilter={args.shouldFilter}>
      <CommandInput
        value={args.query}
        onValueChange={() => undefined}
        placeholder="q"
      />
      <CommandList>
        <PaletteQueryProvider value={args.query}>
          <SubpageView subpage={subpage} ctx={CTX} onSelect={() => undefined} />
        </PaletteQueryProvider>
      </CommandList>
    </Command>,
  );
}

afterEach(() => cleanup());

describe("isFilesResultSubpageId", () => {
  it("matches step-2 result sub-pages, not the step-1 source picker", () => {
    expect(isFilesResultSubpageId(filesArtifactsResultSubpageId())).toBe(true);
    expect(
      isFilesResultSubpageId(filesCodeRootResultSubpageId("host-1", "/ws/a")),
    ).toBe(true);
    // Windows root: encoded, still recognized.
    expect(
      isFilesResultSubpageId(filesCodeRootResultSubpageId("host-1", "C:\\r")),
    ).toBe(true);
    // Step-1 source picker + unrelated pages keep cmdk filtering.
    expect(isFilesResultSubpageId("open:category:files")).toBe(false);
    expect(isFilesResultSubpageId("open:category:diff")).toBe(false);
    expect(isFilesResultSubpageId("open:search:run:artifact")).toBe(false);
  });
});

describe("Files result rows through the real cmdk pipeline", () => {
  const TYPO_QUERY = "flie"; // not an in-order subsequence of "file.ts"

  it("with filtering disabled, a typo query keeps host rows visible AND in host order", () => {
    renderPipeline({
      shouldFilter: false,
      query: TYPO_QUERY,
      items: [
        actionRow("open:files:artifacts:a1", "file.ts"),
        actionRow("open:files:artifacts:a2", "second.ts"),
      ],
    });
    // Both survive the non-subsequence query...
    expect(screen.getByText("file.ts")).toBeTruthy();
    expect(screen.getByText("second.ts")).toBeTruthy();
    // ...and render in the host-provided order (cmdk did not re-rank).
    const rendered = screen.getAllByRole("option").map((el) => el.textContent);
    expect(rendered).toEqual(["file.ts", "second.ts"]);
  });

  it("with filtering disabled, a non-matching query still shows the notice and truncation rows", () => {
    renderPipeline({
      shouldFilter: false,
      query: "zzz",
      items: [
        noticeRow(
          "open:files:artifacts:unavailable",
          "Artifacts are unavailable",
        ),
        noticeRow(
          "open:files-artifacts:truncated",
          "Showing first 50 - type to filter",
        ),
      ],
    });
    expect(screen.getByText("Artifacts are unavailable")).toBeTruthy();
    expect(screen.getByText("Showing first 50 - type to filter")).toBeTruthy();
  });

  it("proves the bug the fix avoids: with filtering ENABLED, the same query hides both", () => {
    renderPipeline({
      shouldFilter: true,
      query: "zzz",
      items: [
        actionRow("open:files:artifacts:a1", "file.ts"),
        noticeRow(
          "open:files:artifacts:unavailable",
          "Artifacts are unavailable",
        ),
      ],
    });
    expect(screen.queryByText("file.ts")).toBeNull();
    expect(screen.queryByText("Artifacts are unavailable")).toBeNull();
  });

  it("ready-empty stays distinct: an empty result list shows the sub-page empty copy, no notice", () => {
    renderPipeline({ shouldFilter: false, query: "zzz", items: [] });
    expect(screen.getByText("Nothing available.")).toBeTruthy();
    expect(screen.queryByText("Artifacts are unavailable")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });
});
