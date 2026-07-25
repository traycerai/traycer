import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  DiskWorktreeEntry,
  WorktreeBinding,
  WorktreeHostEntryV12,
  WorktreeWorkspaceSummaryV13,
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
import { WorktreePrStateIcons } from "@/components/worktree/worktree-pr-state-icons";
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

/** An owner running directly in a folder - no managed worktree behind it. */
const PLAIN_FOLDER_BINDING: WorktreeBinding = {
  entries: [
    {
      workspacePath: "/repos/infra",
      mode: "local",
      repoIdentifier: { owner: "acme", repo: "infra" },
      worktreePath: null,
      branch: null,
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

function diskEntry(
  worktreePath: string,
  isMain: boolean,
  branch: string,
): DiskWorktreeEntry {
  return { worktreePath, branch, head: null, isMain, isLocked: false };
}

function workspaceSummary(
  workspacePath: string,
  worktrees: readonly DiskWorktreeEntry[],
): WorktreeWorkspaceSummaryV13 {
  return {
    workspacePath,
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "infra" },
    mainBranch: "main",
    worktrees: [...worktrees],
    scripts: null,
    resolvedAt: 1_000,
  };
}

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

    // The visible label carries no state word - the glyph encodes it. The ARIA
    // label still spells it out, because the glyph is `aria-hidden` and is
    // therefore the one thing a screen reader cannot read.
    expect(references).toMatchObject([
      {
        label: "#42",
        ariaLabel: "Open PR #42 Open",
        branch: "feature/login",
        worktreePath: "/worktrees/app/feature-login",
      },
      {
        label: "shared #7",
        ariaLabel: "Open shared PR #7 Merged",
        branch: "feature/shared-login",
        worktreePath: "/worktrees/app/feature-login",
      },
    ]);
  });

  it("emits one reference per PR when two of an owner's directories report the same one", () => {
    // Two distinct running directories of the same repo, both sitting on the
    // same PR. The reference key is built from the PR number and URL, not the
    // directory, so before dedup both rows carried an identical `key` - a
    // duplicate React key wherever they render as a list, and a repeated icon
    // for a single pull request.
    const references = worktreePrReferences([
      worktree({ worktreePath: "/worktrees/app/feature-login" }),
      worktree({ worktreePath: "/worktrees/app/feature-login-copy" }),
    ]);

    expect(references).toHaveLength(1);
    expect(references[0].url).toBe("https://github.com/acme/app/pull/42");
    expect(new Set(references.map((reference) => reference.key)).size).toBe(
      references.length,
    );
  });

  it("keeps genuinely distinct PRs apart", () => {
    const references = worktreePrReferences([
      worktree({ worktreePath: "/worktrees/app/a" }),
      worktree({
        worktreePath: "/worktrees/app/b",
        prNumber: 43,
        prUrl: "https://github.com/acme/app/pull/43",
      }),
    ]);

    expect(references.map((reference) => reference.prNumber)).toEqual([42, 43]);
  });

  it("merges the binding with enriched worktree truth for navigator hover", () => {
    const items = ownerWorkspaceMetadataItems(
      BINDING,
      [worktree({ branch: "feature/login-renamed" })],
      [],
    );

    expect(items).toMatchObject([
      {
        name: "app",
        branch: "feature/login-renamed",
        runPath: "/worktrees/app/feature-login",
      },
    ]);
  });

  it("reads a plain folder's branch off its workspace summary, not the worktree walk", () => {
    // `worktree.listAllForHost` walks MANAGED WORKTREES, so a folder the owner
    // runs in directly is never in it, and a workspace entry's own `branch` is
    // null (that field records the branch a WORKTREE binding was created on).
    // With only those two sources the row read "No branch" however many times
    // it was refreshed - no amount of re-deriving turns a null into a branch.
    const items = ownerWorkspaceMetadataItems(
      PLAIN_FOLDER_BINDING,
      [],
      [
        workspaceSummary("/repos/infra", [
          diskEntry("/repos/infra", true, "main"),
        ]),
      ],
    );

    expect(items).toMatchObject([
      { name: "infra", branch: "main", runPath: "/repos/infra" },
    ]);
  });

  it("prefers the folder's own disk row over the repo's main one", () => {
    // When the folder the owner runs in is ITSELF a worktree of some other
    // checkout, the `isMain` row names a different directory on a different
    // branch. Falling back to it would confidently report the wrong branch,
    // which is worse than the "No branch" it replaced.
    const items = ownerWorkspaceMetadataItems(
      PLAIN_FOLDER_BINDING,
      [],
      [
        workspaceSummary("/repos/infra", [
          diskEntry("/repos/checkout", true, "main"),
          diskEntry("/repos/infra", false, "feature/split"),
        ]),
      ],
    );

    expect(items[0].branch).toBe("feature/split");
  });

  it("leaves a plain folder branchless when no summary covers it", () => {
    const items = ownerWorkspaceMetadataItems(PLAIN_FOLDER_BINDING, [], []);

    expect(items[0].branch).toBeNull();
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
          workspaces={[]}
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
      // Two glyphs: the leading state icon (the pill's only state signal) and
      // the trailing external-link affordance, which is mounted at all times
      // and revealed by opacity so hovering a row of pills cannot reflow it.
      expect(link.querySelectorAll("svg")).toHaveLength(2);
      const external = link.querySelector(".lucide-external-link");
      expect(external).not.toBeNull();
      expect(external?.getAttribute("class")).toContain("opacity-0");
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
        workspaces={[]}
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
    expect(within(ownerContent).getByText("#42")).toBeTruthy();
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
            workspaces={[]}
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
      lightGlyph: "#166534" /* green-800 */,
      darkGlyph: "#86efac" /* green-300 */,
      bgClass: "bg-green-500/10",
      lightGlyphClass: "text-green-800",
      darkGlyphClass: "dark:text-green-300",
    },
    {
      state: "closed" as const,
      tint: "#ef4444" /* red-500 */,
      lightGlyph: "#991b1b" /* red-800 */,
      darkGlyph: "#fca5a5" /* red-300 */,
      bgClass: "bg-red-500/10",
      lightGlyphClass: "text-red-800",
      darkGlyphClass: "dark:text-red-300",
    },
    {
      state: "merged" as const,
      tint: "#a855f7" /* purple-500 */,
      lightGlyph: "#6b21a8" /* purple-800 */,
      darkGlyph: "#d8b4fe" /* purple-300 */,
      bgClass: "bg-purple-500/10",
      lightGlyphClass: "text-purple-800",
      darkGlyphClass: "dark:text-purple-300",
    },
  ])(
    "keeps the owner-preview $state pill's state glyph legible over its own tint on every preset's hover-preview card",
    ({
      state,
      tint,
      lightGlyph,
      darkGlyph,
      bgClass,
      lightGlyphClass,
      darkGlyphClass,
    }) => {
      const entry = worktree({ prState: state });
      renderWithProviders(
        <OwnerWorkspaceMetadataContent
          binding={BINDING}
          worktrees={[entry]}
          workspaces={[]}
          pending={false}
          error={false}
        />,
      );
      // The owner preview is a hover-preview card on the normal `bg-popover`
      // surface (see hover-preview-surface.ts), not the inverted tooltip chip,
      // so there is exactly one pill palette - no inverse variant to drift.
      const pill = screen.getByTestId("worktree-context-pr-pill");
      const pillTokens = pill.className.split(/\s+/);
      expect(pillTokens).toContain(bgClass);
      // The LABEL is plain body text. It carries no state - the word "Open" is
      // gone from it - so it needs no per-state ramp, and `text-foreground` is
      // already contrast-checked against every preset by the theme itself.
      expect(pillTokens).toContain("text-foreground");
      expect(
        pillTokens.filter((token) => /^text-(green|red|purple)-/.test(token)),
      ).toEqual([]);

      // The GLYPH is where the state went, which makes it a graphical object
      // required to understand the content: WCAG 1.4.11's 3:1 floor, not the
      // 4.5:1 body-text one the coloured label used to be held to. It carries
      // the same `-800`/`-300` tokens the sidebar's icon variant does, from the
      // shared palette - the ramp did not become moot when the label lost its
      // colour, it moved.
      const glyphTokens = (
        within(pill)
          .getByTestId("worktree-pr-pill-state-glyph")
          .getAttribute("class") ?? ""
      ).split(/\s+/);
      expect(glyphTokens).toContain(lightGlyphClass);
      expect(glyphTokens).toContain(darkGlyphClass);

      // Resolve the real ratio per preset: the glyph sits on the pill's own 10%
      // state tint composited over the card's `--popover`, which several
      // presets tint away from the default white/near-black (Catppuccin,
      // Gruvbox, Tokyo Night, Everforest, …).
      const failures: string[] = [];
      for (const [preset, surfaces] of Object.entries(LIGHT_THEME_SURFACES)) {
        const ratio = contrastRatio(
          lightGlyph,
          compositeOverBackground(tint, 0.1, surfaces.popover),
        );
        if (ratio < 3) failures.push(`${preset} light: ${ratio.toFixed(2)}`);
      }
      for (const [preset, surfaces] of Object.entries(DARK_THEME_SURFACES)) {
        const ratio = contrastRatio(
          darkGlyph,
          compositeOverBackground(tint, 0.1, surfaces.popover),
        );
        if (ratio < 3) failures.push(`${preset} dark: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    },
  );

  it("holds both PR-state surfaces to one palette so neither can drift", () => {
    // The two variants are separate components (the hover card's tinted pill
    // and the sidebar row's icon-only span) that had already diverged once: the
    // icon variant documented itself as carrying "the same validated tokens as
    // the pill" while the pill had since moved to an unchecked `-600`/`-400`.
    // They now read the same map, and this fails if either stops.
    for (const state of ["open", "closed", "merged"] as const) {
      const reference = worktreePrReferences([worktree({ prState: state })])[0];
      renderWithProviders(
        <>
          <WorktreePrPills
            worktrees={[worktree({ prState: state })]}
            detailOnHover={false}
            maximumVisible={null}
            className={undefined}
            testId="history-prs"
          />
          <WorktreePrStateIcons references={[reference]} testId="row-prs" />
        </>,
      );
      const glyphTokens = (
        screen
          .getByTestId("worktree-pr-pill-state-glyph")
          .getAttribute("class") ?? ""
      ).split(/\s+/);
      const iconTokens = screen
        .getByTestId("worktree-pr-state-icon")
        .className.split(/\s+/);
      const stateTokens = (tokens: readonly string[]): readonly string[] =>
        tokens.filter((token) =>
          /^(dark:)?text-(green|red|purple)-/.test(token),
        );
      expect(stateTokens(glyphTokens)).toEqual(stateTokens(iconTokens));
      expect(stateTokens(glyphTokens)).toHaveLength(2);
      cleanup();
    }
  });
});
