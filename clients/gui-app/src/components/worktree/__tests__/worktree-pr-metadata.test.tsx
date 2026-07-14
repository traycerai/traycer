import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  WorktreeBinding,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  OwnerWorkspaceMetadataContent,
  WorktreePrPills,
} from "@/components/worktree/worktree-pr-metadata";
import {
  ownerWorkspaceMetadataItems,
  worktreePrReferences,
} from "@/components/worktree/worktree-pr-metadata-model";

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

    const links = screen.getAllByRole("link", { name: "Open PR #42 Open" });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/42",
    );
    expect(links[0].className).toContain("inline-flex");
    expect(links[0].querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByText("feature/login")).toBeDefined();
    expect(screen.getByText("/worktrees/app/feature-login")).toBeDefined();
  });
});
