import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  OwnerWorkspaceMetadataContent,
  WorktreePrPills,
} from "@/components/worktree/worktree-pr-metadata";
import {
  ownerWorkspaceMetadataItems,
  worktreePrReferences,
} from "@/components/worktree/worktree-pr-metadata-model";
import {
  compositeOverBackground,
  contrastRatio,
  DARK_THEME_SURFACES,
  FOREGROUND_DARK,
  FOREGROUND_LIGHT,
  LIGHT_THEME_SURFACES,
} from "../../../../__tests__/contrast";

function worktree(
  overrides: Partial<WorktreeHostEntryV12>,
): WorktreeHostEntryV12 {
  return {
    worktreePath: "/worktrees/app/feature-login",
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: "feature/login",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [],
    branchStatus: { ahead: 1, behind: 0, mergedIntoDefault: false },
    createdAt: null,
    prState: "open",
    prNumber: 42,
    prUrl: "https://github.com/acme/app/pull/42",
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    ...overrides,
  };
}

const BINDING: WorktreeBinding = {
  entries: [
    {
      workspacePath: "/repos/app",
      mode: "worktree",
      repoIdentifier: { owner: "acme", repo: "app" },
      worktreePath: "/worktrees/app/feature-login",
      branch: "feature/login",
      isPrimary: true,
      isImported: false,
      setupState: "succeeded",
      setupTerminalSessionId: null,
      setupExitCode: 0,
      setupFailedAt: null,
      createdAt: 1,
      ownedSubmodules: [],
    },
  ],
};

function renderWithProviders(node: React.ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("worktree PR metadata", () => {
  afterEach(() => {
    cleanup();
  });

  it("carries branch and worktree path onto superproject and submodule PRs", () => {
    const references = worktreePrReferences([
      worktree({
        submodules: [
          {
            repoIdentifier: { owner: "acme", repo: "shared" },
            branch: "feature/shared-login",
            prState: "merged",
            prNumber: 7,
            prUrl: "https://github.com/acme/shared/pull/7",
            mergedHeadShaMatches: true,
            mergedIntoDefault: true,
            atPinnedCommit: true,
            unmergedCommitCount: null,
            unmergedCommitSubjects: null,
          },
        ],
      }),
    ]);

    expect(references).toMatchObject([
      {
        label: "#42 Open",
        branch: "feature/login",
        worktreePath: "/worktrees/app/feature-login",
      },
      {
        label: "shared #7 Merged",
        branch: "feature/shared-login",
        worktreePath: "/worktrees/app/feature-login",
      },
    ]);
  });

  it("merges the binding with enriched worktree truth for navigator hover", () => {
    const items = ownerWorkspaceMetadataItems(BINDING, [
      worktree({ branch: "feature/login-renamed" }),
    ]);

    expect(items).toMatchObject([
      {
        name: "app",
        branch: "feature/login-renamed",
        runPath: "/worktrees/app/feature-login",
      },
    ]);
  });

  it("renders linked PR pills and the owner hover's branch and run path", () => {
    const entry = worktree({});
    renderWithProviders(
      <>
        <WorktreePrPills
          worktrees={[entry]}
          detailOnHover
          interactive
          className={undefined}
          testId="history-prs"
        />
        <OwnerWorkspaceMetadataContent
          binding={BINDING}
          worktrees={[entry]}
          pending={false}
          error={false}
        />
      </>,
    );

    // Only the standalone, interactive WorktreePrPills usage renders a real
    // link - the owner hover preview below embeds the same PR pill
    // informationally (see the next assertions).
    const links = screen.getAllByRole("link", { name: "Open PR #42 Open" });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/42",
    );
    expect(links[0].className).toContain("inline-flex");
    expect(links[0].querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByText("feature/login")).toBeDefined();
    expect(screen.getByText("/worktrees/app/feature-login")).toBeDefined();
  });

  it("renders the owner hover's embedded PR pill informationally, with no interactive descendant", () => {
    const entry = worktree({});
    renderWithProviders(
      <OwnerWorkspaceMetadataContent
        binding={BINDING}
        worktrees={[entry]}
        pending={false}
        error={false}
      />,
    );

    // This content is rendered as Radix Tooltip content elsewhere in the app
    // (WorktreeOwnerMetadataTooltip), which mounts an always-present
    // visually-hidden accessible clone of its children - any focusable
    // descendant here (like the PR pill's anchor) would exist twice in the
    // a11y/tab order. The pill still shows the same label/state text.
    const ownerContent = screen.getByTestId("owner-workspace-prs-/repos/app");
    expect(within(ownerContent).queryByRole("link")).toBeNull();
    expect(within(ownerContent).queryAllByRole("button")).toHaveLength(0);
    expect(within(ownerContent).getByText("#42 Open")).toBeTruthy();
    expect(
      within(ownerContent)
        .getByTestId("worktree-context-pr-pill")
        .getAttribute("data-pr-state"),
    ).toBe("open");
    // jsdom only enumerates explicit tabIndex/buttons/links for focus order,
    // so it can't reproduce Chromium making an overflowing scroll container
    // an implicit tab stop - assert the explicit opt-out is present instead
    // (verified against real Chromium separately; see the ticket notes).
    // `HTMLElement.tabIndex` (the IDL property) already reads -1 for a plain
    // span with NO tabindex attribute at all, so asserting on it would pass
    // before the fix too - read the content attribute explicitly instead.
    expect(
      screen
        .getByTestId("owner-workspace-metadata-content")
        .getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("keeps every rendered copy of the owner-preview scroll root - including Radix's hidden accessible clone - out of sequential focus", () => {
    const entry = worktree({});
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button type="button">Owner trigger</button>
          </TooltipTrigger>
          <TooltipContent side="bottom" richContent>
            <OwnerWorkspaceMetadataContent
              binding={BINDING}
              worktrees={[entry]}
              pending={false}
              error={false}
            />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const copies = screen.getAllByTestId("owner-workspace-metadata-content");
    // Radix mounts the visible popper content AND an always-present
    // visually-hidden accessible clone - both must carry the explicit
    // opt-out, since Chromium doesn't respect visual hiding for implicit
    // scroll-container focusability.
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const copy of copies) {
      expect(copy.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("keeps the interactive history pill on the normal-surface palette (unswapped light/dark text tone)", () => {
    const entry = worktree({});
    renderWithProviders(
      <WorktreePrPills
        worktrees={[entry]}
        detailOnHover={false}
        interactive
        className={undefined}
        testId="history-prs"
      />,
    );
    const tokens = screen
      .getByTestId("worktree-context-pr-pill")
      .className.split(/\s+/);
    expect(tokens).toContain("text-green-700");
    expect(tokens).toContain("dark:text-green-300");
    expect(tokens).not.toContain("text-green-300");
    expect(tokens).not.toContain("dark:text-green-700");
  });

  it.each([
    {
      state: "open" as const,
      tint: "#22c55e" /* green-500 */,
      borderClass: "border-green-500/30",
      bgClass: "bg-green-500/6",
    },
    {
      state: "closed" as const,
      tint: "#ef4444" /* red-500 */,
      borderClass: "border-red-500/25",
      bgClass: "bg-red-500/6",
    },
    {
      state: "merged" as const,
      tint: "#a855f7" /* purple-500 */,
      borderClass: "border-purple-500/30",
      bgClass: "bg-purple-500/6",
    },
  ])(
    "gives the owner-preview $state pill a guaranteed-inverse text color plus a state tint/border, resolving >=4.5:1 against every preset's real bg-foreground Tooltip surface",
    ({ state, tint, borderClass, bgClass }) => {
      const entry = worktree({ prState: state });
      renderWithProviders(
        <OwnerWorkspaceMetadataContent
          binding={BINDING}
          worktrees={[entry]}
          pending={false}
          error={false}
        />,
      );
      const pill = screen.getByTestId("worktree-context-pr-pill");
      const tokens = pill.className.split(/\s+/);
      // No preset gives `--foreground` a reliable near-black/near-white
      // extreme (Ayu/Everforest/Tokyo Night are mid-lightness), so the text
      // uses the tooltip's own always-safe `text-background` token; state
      // lives in the tint/border hue and the label text instead.
      expect(tokens).toContain("text-background");
      expect(tokens).toContain(borderClass);
      expect(tokens).toContain(bgClass);

      // Tooltip content sits on `bg-foreground` (components/ui/tooltip.tsx).
      // Verify against every supported preset's ACTUAL `--foreground` value,
      // not just the default theme's near-black/near-white extremes - this
      // is what the previous, default-only matrix missed. Tint alpha (6%)
      // must match `PR_PILL_INVERSE_CLASS`'s `/6` opacity.
      const failures: string[] = [];
      for (const [preset, foreground] of Object.entries(FOREGROUND_LIGHT)) {
        const surfaces = LIGHT_THEME_SURFACES[preset];
        const ratio = contrastRatio(
          surfaces.background,
          compositeOverBackground(tint, 0.06, foreground),
        );
        if (ratio < 4.5) failures.push(`${preset} light: ${ratio.toFixed(2)}`);
      }
      for (const [preset, foreground] of Object.entries(FOREGROUND_DARK)) {
        const surfaces = DARK_THEME_SURFACES[preset];
        const ratio = contrastRatio(
          surfaces.background,
          compositeOverBackground(tint, 0.06, foreground),
        );
        if (ratio < 4.5) failures.push(`${preset} dark: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    },
  );
});
