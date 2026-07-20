import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { TooltipProvider } from "@/components/ui/tooltip";
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
          maximumVisible={null}
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

    // Both the standalone history pill and the owner hover preview render the
    // PR as a real link (the owner preview is an interactive HoverCard).
    const links = screen.getAllByRole("link", { name: "Open PR #42 Open" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(
        "https://github.com/acme/app/pull/42",
      );
      expect(link.className).toContain("inline-flex");
      expect(link.querySelectorAll("svg")).toHaveLength(1);
    }
    expect(screen.getByText("feature/login")).toBeDefined();
    expect(screen.getByText("/worktrees/app/feature-login")).toBeDefined();
  });

  it("collapses excess PR pills behind an accessible overflow control", () => {
    const entry = worktree({
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
        {
          repoIdentifier: { owner: "acme", repo: "design-system" },
          branch: "feature/design-login",
          prState: "open",
          prNumber: 9,
          prUrl: "https://github.com/acme/design-system/pull/9",
          mergedHeadShaMatches: false,
          mergedIntoDefault: false,
          atPinnedCommit: false,
          unmergedCommitCount: null,
          unmergedCommitSubjects: null,
        },
      ],
    });
    renderWithProviders(
      <WorktreePrPills
        worktrees={[entry]}
        detailOnHover
        maximumVisible={2}
        className={undefined}
        testId="history-prs"
      />,
    );

    expect(screen.getAllByRole("link")).toHaveLength(2);
    const overflow = screen.getByRole("button", {
      name: "Show 1 more pull request",
    });
    expect(overflow.textContent).toBe("+1");

    fireEvent.click(overflow);

    const content = screen.getByTestId("worktree-pr-overflow-content");
    expect(screen.getByRole("dialog", { name: "More pull requests" })).toBe(
      content,
    );
    expect(
      within(content).getByRole("link", {
        name: "Open design-system PR #9 Open",
      }),
    ).toBeDefined();
  });

  it("renders the owner hover's embedded PR pill as a real link", () => {
    const entry = worktree({});
    renderWithProviders(
      <OwnerWorkspaceMetadataContent
        binding={BINDING}
        worktrees={[entry]}
        pending={false}
        error={false}
      />,
    );

    // The owner preview is an interactive HoverCard (no visually-hidden a11y
    // clone), so the embedded PR pill is a genuine, reachable link again.
    const ownerContent = screen.getByTestId("owner-workspace-prs-/repos/app");
    const link = within(ownerContent).getByRole("link", {
      name: "Open PR #42 Open",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/42",
    );
    expect(link.getAttribute("data-pr-state")).toBe("open");
    expect(within(ownerContent).getByText("#42 Open")).toBeTruthy();
    // jsdom can't reproduce Chromium making an overflowing scroll container an
    // implicit tab stop - assert the explicit opt-out is present instead
    // (verified against real Chromium separately; see the ticket notes).
    expect(
      screen
        .getByTestId("owner-workspace-metadata-content")
        .getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("keeps the owner-preview scroll root out of sequential focus inside a HoverCard", () => {
    const entry = worktree({});
    renderWithProviders(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Owner trigger</button>
        </HoverCardTrigger>
        <HoverCardContent side="bottom">
          <OwnerWorkspaceMetadataContent
            binding={BINDING}
            worktrees={[entry]}
            pending={false}
            error={false}
          />
        </HoverCardContent>
      </HoverCard>,
    );
    // HoverCard renders a single copy (no hidden a11y clone), and its scroll
    // root carries the explicit tab-stop opt-out.
    const copies = screen.getAllByTestId("owner-workspace-metadata-content");
    expect(copies).toHaveLength(1);
    expect(copies[0].getAttribute("tabindex")).toBe("-1");
  });

  it.each([
    {
      state: "open" as const,
      tint: "#22c55e" /* green-500 */,
      lightText: "#166534" /* green-800 */,
      darkText: "#86efac" /* green-300 */,
      borderClass: "border-green-600/30",
      bgClass: "bg-green-500/10",
      lightTextClass: "text-green-800",
      darkTextClass: "dark:text-green-300",
    },
    {
      state: "closed" as const,
      tint: "#ef4444" /* red-500 */,
      lightText: "#991b1b" /* red-800 */,
      darkText: "#fca5a5" /* red-300 */,
      borderClass: "border-red-600/25",
      bgClass: "bg-red-500/10",
      lightTextClass: "text-red-800",
      darkTextClass: "dark:text-red-300",
    },
    {
      state: "merged" as const,
      tint: "#a855f7" /* purple-500 */,
      lightText: "#6b21a8" /* purple-800 */,
      darkText: "#d8b4fe" /* purple-300 */,
      borderClass: "border-purple-600/30",
      bgClass: "bg-purple-500/10",
      lightTextClass: "text-purple-800",
      darkTextClass: "dark:text-purple-300",
    },
  ])(
    "renders the owner-preview $state pill on the theme-aware normal-surface palette, >=4.5:1 against every preset's hover-preview card",
    ({
      state,
      tint,
      lightText,
      darkText,
      borderClass,
      bgClass,
      lightTextClass,
      darkTextClass,
    }) => {
      const entry = worktree({ prState: state });
      renderWithProviders(
        <OwnerWorkspaceMetadataContent
          binding={BINDING}
          worktrees={[entry]}
          pending={false}
          error={false}
        />,
      );
      // The owner preview is a hover-preview card on the normal `bg-popover`
      // surface (see hover-preview-surface.ts), not the inverted tooltip chip,
      // so there is exactly one pill palette - no inverse variant to drift.
      const tokens = screen
        .getByTestId("worktree-context-pr-pill")
        .className.split(/\s+/);
      expect(tokens).toContain(lightTextClass);
      expect(tokens).toContain(darkTextClass);
      expect(tokens).toContain(borderClass);
      expect(tokens).toContain(bgClass);

      // Resolve the real ratio per preset: the pill text sits on its own 10%
      // state tint composited over the card's `--popover`, which several
      // presets tint away from the default white/near-black (Catppuccin,
      // Gruvbox, Tokyo Night, Everforest, …).
      const failures: string[] = [];
      for (const [preset, surfaces] of Object.entries(LIGHT_THEME_SURFACES)) {
        const ratio = contrastRatio(
          lightText,
          compositeOverBackground(tint, 0.1, surfaces.popover),
        );
        if (ratio < 4.5) failures.push(`${preset} light: ${ratio.toFixed(2)}`);
      }
      for (const [preset, surfaces] of Object.entries(DARK_THEME_SURFACES)) {
        const ratio = contrastRatio(
          darkText,
          compositeOverBackground(tint, 0.1, surfaces.popover),
        );
        if (ratio < 4.5) failures.push(`${preset} dark: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    },
  );
});
