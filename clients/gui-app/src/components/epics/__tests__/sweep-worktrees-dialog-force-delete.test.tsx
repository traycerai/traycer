import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";
import { formatUnknownHolderConsequence } from "@/lib/worktree/teardown-holder-copy";

const HOLDERS: readonly WorktreeBusyHolder[] = [
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "terminal-agent",
      ownerId: "tui-1",
    },
    holdKind: "terminal-agent-pty",
    activity: "working",
    label: "Claude Code agent polite-ocelot is working",
    holderId: "epic-1:terminal-agent:tui-1",
  },
];

type SweepKickoff = {
  worktrees: Array<{
    readonly worktreePath: string;
    readonly stopOwners: boolean;
    readonly expectedHoldersRevision: string | undefined;
  }>;
};

const REV_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type TestRow = {
  entry: WorktreeHostEntryV14;
  tier: "merged" | "at-base-commit" | "in-use" | "review";
  defaultChecked: boolean;
  disabled: boolean;
  note: "in-use" | "not-landed" | "shared" | null;
  holders: readonly WorktreeBusyHolder[];
  holdersStatus: "none" | "loading" | "ready" | "unknown";
  holdersRevision?: string | undefined;
};

const testState = vi.hoisted(() => {
  const parseSweepVariables = (value: unknown): SweepKickoff => {
    if (value === null || typeof value !== "object") {
      return { worktrees: [] };
    }
    if (!("worktrees" in value) || !Array.isArray(value.worktrees)) {
      return { worktrees: [] };
    }
    return {
      worktrees: value.worktrees.map((target: unknown) => {
        if (target === null || typeof target !== "object") {
          return {
            worktreePath: "",
            stopOwners: false,
            expectedHoldersRevision: undefined,
          };
        }
        const worktreePath =
          "worktreePath" in target && typeof target.worktreePath === "string"
            ? target.worktreePath
            : "";
        const stopOwners = "stopOwners" in target && target.stopOwners === true;
        const expectedHoldersRevision =
          "expectedHoldersRevision" in target &&
          typeof target.expectedHoldersRevision === "string"
            ? target.expectedHoldersRevision
            : undefined;
        return { worktreePath, stopOwners, expectedHoldersRevision };
      }),
    };
  };
  return {
    mutate: vi.fn(),
    parseSweepVariables,
    lastVariables: {
      worktrees: [] as SweepKickoff["worktrees"],
    },
    holdersChanged: [] as Array<{
      worktreePath: string;
      holders: readonly WorktreeBusyHolder[];
      holdersRevision: string | undefined;
    }>,
    removed: [] as string[],
    failed: [] as string[],
    uncertain: [] as string[],
    rows: [] as TestRow[],
    hostId: "host-1",
    agentNames: new Map<string, string>(),
    taskTitles: new Map<string, string>(),
    refresh: vi.fn(() => Promise.resolve(testState.rows)),
  };
});

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: testState.hostId,
    rows: testState.rows,
    isPending: false,
    isError: false,
    checkedAt: Date.now(),
    canRefresh: true,
    refresh: testState.refresh,
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: false,
    mutate: (
      variables: unknown,
      options: { onSuccess?: (result: unknown) => void } | undefined,
    ) => {
      testState.lastVariables = testState.parseSweepVariables(variables);
      testState.mutate(variables);
      options?.onSuccess?.({
        hostId: "host-1",
        removed: testState.removed,
        failed: testState.failed,
        uncertain: testState.uncertain,
        holdersChanged: testState.holdersChanged,
      });
    },
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

vi.mock("@/lib/worktree/teardown-agent-names", () => ({
  useTeardownAgentNames: () => testState.agentNames,
}));

vi.mock("@/components/settings/panels/use-worktree-task-titles", () => ({
  useWorktreeTaskTitles: () => testState.taskTitles,
}));

import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";

function worktreeEntry(
  over: Partial<WorktreeHostEntryV14> & { readonly worktreePath: string },
): WorktreeHostEntryV14 {
  return {
    worktreePath: over.worktreePath,
    branch: over.branch ?? "feat-busy",
    repoLabel: "traycerai/traycer",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    inUse: over.inUse ?? false,
    uncommittedCount: over.uncommittedCount ?? 0,
    gitRemovable: true,
    scripts: null,
    owners: over.owners ?? [],
    lastActivityAt: null,
    branchStatus: over.branchStatus ?? null,
    createdAt: null,
    prState: over.prState ?? "merged",
    prNumber: 1,
    prUrl: "https://example.test/pr/1",
    mergedHeadShaMatches: true,
    submodules: [],
    atBaseCommit: over.atBaseCommit ?? false,
    resolvedAt: Date.now(),
  };
}

function renderDialog(): void {
  render(
    <SweepWorktreesDialog
      epicIds={["epic-1"]}
      hostClient={null}
      taskTitle="Task"
      onOpenChange={vi.fn()}
    />,
  );
}

describe("SweepWorktreesDialog ergonomics", () => {
  afterEach(() => {
    cleanup();
    testState.mutate.mockReset();
    testState.lastVariables = { worktrees: [] };
    testState.holdersChanged = [];
    testState.removed = [];
    testState.failed = [];
    testState.uncertain = [];
    testState.agentNames = new Map();
    testState.taskTitles = new Map();
    testState.hostId = "host-1";
    testState.refresh.mockReset();
    testState.refresh.mockImplementation(() => Promise.resolve(testState.rows));
    testState.rows = [];
  });

  it("executes a safe-only selection from step 1 without opening review", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          inUse: false,
        }),
        tier: "merged",
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [],
        holdersStatus: "none",
      },
    ];
    renderDialog();
    expect(screen.queryByText("Review this sweep")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sweep selected" }));
    expect(testState.mutate).toHaveBeenCalledTimes(1);
    expect(testState.lastVariables.worktrees[0]?.stopOwners).toBe(false);
  });

  it("opens review for in-use, unproven, and shared selections; typing only for unproven", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    expect(screen.queryByTestId("sweep-typed-confirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Stop work & sweep" }),
    ).toBeTruthy();
  });

  it("requires typing sweep only when an unproven row is selected", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          inUse: false,
          uncommittedCount: 2,
          prState: "none",
          branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
        }),
        tier: "review",
        defaultChecked: false,
        disabled: false,
        note: "not-landed",
        holders: [],
        holdersStatus: "none",
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-review" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-typed-confirm")).toBeTruthy();
    });
    const confirm = screen.getByRole("button", { name: "Sweep anyway" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("sweep-typed-confirm"), {
      target: { value: "sweep" },
    });
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("renders known holders inside the owning row, not a pooled footer", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    expect(
      screen.getByTestId("teardown-disclosure-inline").textContent,
    ).toContain(
      "Terminal agent “Claude Code agent polite-ocelot” is working — will be stopped",
    );
    expect(screen.queryByText("Run directory")).toBeNull();
  });

  it("attributes unknown holders per worktree and discloses stopping", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/octopus",
          branch: "feat-octopus",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
        holdersStatus: "unknown",
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-octopus" }),
    );
    expect(
      screen.getByTestId("teardown-disclosure-inline").textContent,
    ).toContain(formatUnknownHolderConsequence("feat-octopus"));
  });

  it("does not treat a loading holder inventory as unknown", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: true,
        note: "in-use",
        holders: [],
        holdersStatus: "loading",
      },
    ];
    renderDialog();
    expect(screen.queryByText(/cannot identify it/i)).toBeNull();
    expect(screen.queryByTestId("teardown-disclosure-inline")).toBeNull();
    expect(screen.getByTestId("sweep-worktrees-hint").textContent).toBe(
      "In use",
    );
  });

  it("select-all includes unproven and in-use rows, expands disclosures, and deselect-all clears in-use", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          inUse: false,
        }),
        tier: "merged",
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [],
        holdersStatus: "none",
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          inUse: false,
          uncommittedCount: 1,
          prState: "none",
        }),
        tier: "review",
        defaultChecked: false,
        disabled: false,
        note: "not-landed",
        holders: [],
        holdersStatus: "none",
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/octopus",
          branch: "feat-octopus",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
        holdersStatus: "unknown",
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/loading",
          branch: "feat-loading",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: true,
        note: "in-use",
        holders: [],
        holdersStatus: "loading",
      },
    ];
    renderDialog();
    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toBe(
      "1 of 5 selected",
    );
    expect(screen.getByTestId("sweep-worktrees-count").textContent).not.toMatch(
      /require individual selection/,
    );
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-busy" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByTestId("teardown-disclosure-inline")).toBeNull();
    expect(screen.getAllByText(/Check to review/).length).toBeGreaterThan(0);
    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Deselect all" })).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-busy" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-octopus" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-loading" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    const disclosures = screen.getAllByTestId("teardown-disclosure-inline");
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]?.textContent).toContain(
      "Terminal agent “Claude Code agent polite-ocelot” is working — will be stopped",
    );
    expect(disclosures[1]?.textContent).toContain(
      formatUnknownHolderConsequence("feat-octopus"),
    );
    expect(screen.getByTestId("sweep-worktrees-count").textContent).toBe(
      "4 of 5 selected",
    );
    expect(
      screen.getByRole("button", { name: "Review consequences" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Deselect all" }));
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-busy" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByTestId("teardown-disclosure-inline")).toBeNull();
  });

  it("bulk-selected in-use rows produce the same review entries and request consent as individually selected ones", async () => {
    const mixed = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          inUse: false,
        }),
        tier: "merged" as const,
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [] as const,
        holdersStatus: "none" as const,
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use" as const,
        defaultChecked: false,
        disabled: false,
        note: "in-use" as const,
        holders: HOLDERS,
        holdersStatus: "ready" as const,
        holdersRevision: REV_A,
      },
    ];
    testState.rows = mixed;
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    const individualStops =
      screen.getByTestId("sweep-review-stops").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    const individualRequest = testState.lastVariables;

    cleanup();
    testState.mutate.mockReset();
    testState.lastVariables = { worktrees: [] };
    testState.rows = mixed;
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    expect(screen.getByTestId("sweep-review-stops").textContent).toBe(
      individualStops,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.lastVariables).toEqual(individualRequest);
    expect(testState.lastVariables.worktrees).toEqual(
      expect.arrayContaining([
        {
          worktreePath: "/wt/busy",
          stopOwners: true,
          expectedHoldersRevision: REV_A,
        },
      ]),
    );
  });

  it("drops a checked override when an idle row refreshes to in-use", async () => {
    const idle = {
      entry: worktreeEntry({
        worktreePath: "/wt/flip",
        branch: "feat-flip",
        inUse: false,
      }),
      tier: "merged" as const,
      defaultChecked: false,
      disabled: false,
      note: null,
      holders: [] as const,
      holdersStatus: "none" as const,
    };
    testState.rows = [idle];
    const { rerender } = render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    const checkbox = () =>
      screen.getByRole("checkbox", { name: "Sweep worktree feat-flip" });
    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    testState.rows = [
      {
        ...idle,
        entry: worktreeEntry({
          worktreePath: "/wt/flip",
          branch: "feat-flip",
          inUse: true,
        }),
        tier: "in-use",
        note: "in-use",
        holdersStatus: "unknown",
      },
    ];
    rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(checkbox().getAttribute("aria-checked")).toBe("false");
    });
  });

  it("clears consent when a path vanishes from a completed snapshot then reappears in-use", async () => {
    const idle = {
      entry: worktreeEntry({
        worktreePath: "/wt/flip",
        branch: "feat-flip",
        inUse: false,
      }),
      tier: "merged" as const,
      defaultChecked: false,
      disabled: false,
      note: null,
      holders: [] as const,
      holdersStatus: "none" as const,
    };
    testState.rows = [idle];
    const { rerender } = render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-flip" }),
    );
    testState.rows = [];
    rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    testState.rows = [
      {
        ...idle,
        entry: worktreeEntry({
          worktreePath: "/wt/flip",
          branch: "feat-flip",
          inUse: true,
        }),
        tier: "in-use",
        note: "in-use",
        holdersStatus: "unknown",
      },
    ];
    rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("checkbox", { name: "Sweep worktree feat-flip" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
  });

  it("returns to review with What is running changed when holders change", async () => {
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("sweep-inventory-changed").textContent,
      ).toContain("What is running changed");
    });
    expect(screen.getByText("Review this sweep")).toBeTruthy();
  });

  it("Back from review preserves selection; Escape is owned by the dialog", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-worktrees-back")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("sweep-worktrees-back"));
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-busy" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("echoes expectedHoldersRevision on the in-use kickoff", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop work & sweep" }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.mutate).toHaveBeenCalledTimes(1);
    expect(testState.lastVariables.worktrees[0]?.expectedHoldersRevision).toBe(
      REV_A,
    );
  });

  it("shows the safe-summary copy for a proven-idle selection", () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          inUse: false,
        }),
        tier: "merged",
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [],
        holdersStatus: "none",
      },
    ];
    renderDialog();
    expect(screen.getByTestId("sweep-worktrees-safe-summary").textContent).toBe(
      "1 worktree and 1 local branch will be removed. Nothing is running in them, and no unmerged work was found.",
    );
  });

  it("snapshots review from the refresh result, not the pre-refresh closure", async () => {
    const first = {
      ...HOLDERS[0],
      label: "old command",
    };
    const nextHolders = [
      {
        ...HOLDERS[0],
        label: "bun run dev",
        holdKind: "supervised-shell" as const,
      },
    ];
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [first],
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    testState.refresh.mockImplementation(() => {
      testState.rows = [
        {
          ...testState.rows[0],
          holders: nextHolders,
          holdersRevision: REV_B,
        },
      ];
      return Promise.resolve(testState.rows);
    });
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
      "bun run dev",
    );
    expect(screen.getByTestId("sweep-review-stops").textContent).not.toContain(
      "old command",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.lastVariables.worktrees[0]?.expectedHoldersRevision).toBe(
      REV_B,
    );
  });

  it("drops a removed force path from re-review and keeps idle unsubmitted", async () => {
    const idle = {
      entry: worktreeEntry({
        worktreePath: "/wt/idle",
        branch: "feat-idle",
        inUse: false,
      }),
      tier: "merged" as const,
      defaultChecked: true,
      disabled: false,
      note: null,
      holders: [] as const,
      holdersStatus: "none" as const,
    };
    const okBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/ok",
        branch: "feat-ok",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [idle, okBusy, refuseBusy];
    testState.removed = ["/wt/ok"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-ok" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(screen.getByTestId("sweep-inventory-changed")).toBeTruthy();
    });
    expect(screen.queryByText("feat-ok")).toBeNull();
    expect(screen.getByText("feat-busy")).toBeTruthy();
    expect(screen.getByTestId("sweep-review-removal").textContent).toContain(
      "2 worktrees will be removed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.mutate).toHaveBeenCalledTimes(2);
    const firstKickoff = testState.parseSweepVariables(
      testState.mutate.mock.calls[0]?.[0],
    );
    expect(
      firstKickoff.worktrees.map((target) => target.worktreePath).sort(),
    ).toEqual(["/wt/busy", "/wt/idle", "/wt/ok"]);
    expect(
      testState.lastVariables.worktrees.map((target) => target.worktreePath),
    ).toEqual(["/wt/idle", "/wt/busy"]);
    expect(
      testState.lastVariables.worktrees.find(
        (target) => target.worktreePath === "/wt/busy",
      )?.expectedHoldersRevision,
    ).toBe(REV_B);
  });

  it("activates select-all with A, Space, and Enter, and does not claim A on step 2", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          inUse: false,
        }),
        tier: "merged",
        defaultChecked: false,
        disabled: false,
        note: null,
        holders: [],
        holdersStatus: "none",
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/review",
          branch: "feat-review",
          inUse: false,
          uncommittedCount: 1,
          prState: "none",
        }),
        tier: "review",
        defaultChecked: false,
        disabled: false,
        note: "not-landed",
        holders: [],
        holdersStatus: "none",
      },
    ];
    renderDialog();
    const typingField = document.createElement("input");
    document.body.appendChild(typingField);
    fireEvent.keyDown(typingField, { key: "a" });
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    typingField.remove();
    fireEvent.keyDown(window, { key: "a" });
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const user = userEvent.setup();
    const toggle = screen.getByTestId("sweep-worktrees-select-all");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    toggle.focus();
    await user.keyboard(" ");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-review" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-review" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-typed-confirm")).toBeTruthy();
    });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.change(screen.getByTestId("sweep-typed-confirm"), {
      target: { value: "a" },
    });
    expect(
      screen.getByTestId<HTMLInputElement>("sweep-typed-confirm").value,
    ).toBe("a");
  });

  it("names full shell commands in the review receipt", async () => {
    testState.agentNames = new Map([
      ["terminal-agent:tui-1", "Fixing persistent busyness"],
    ]);
    const shell = {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat" as const,
        ownerId: "chat-1",
      },
      holdKind: "supervised-shell" as const,
      activity: "working" as const,
      label: "bun run --filter gui-app test",
      holderId: "shell:cmd-1",
    };
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [HOLDERS[0], shell],
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
        "bun run --filter gui-app test",
      );
    });
    expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
      "Fixing persistent busyness",
    );
  });

  it("counts mixed known and unknown stops without an exact process number", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/unknown",
          branch: "feat-unknown",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
        holdersStatus: "unknown",
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-unknown" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
        "unidentified background work",
      );
    });
  });

  it("names one external Task once when it binds two selected worktrees", async () => {
    testState.taskTitles = new Map([["epic-ext", "Other task"]]);
    const sharedOwners = [
      {
        epicId: "epic-1",
        ownerKind: "chat" as const,
        ownerId: "c1",
        updatedAt: 1,
      },
      {
        epicId: "epic-ext",
        ownerKind: "chat" as const,
        ownerId: "c2",
        updatedAt: 1,
      },
    ];
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/a",
          branch: "feat-a",
          inUse: false,
          owners: sharedOwners,
        }),
        tier: "merged",
        defaultChecked: false,
        disabled: false,
        note: "shared",
        holders: [],
        holdersStatus: "none",
      },
      {
        entry: worktreeEntry({
          worktreePath: "/wt/b",
          branch: "feat-b",
          inUse: false,
          owners: sharedOwners,
        }),
        tier: "merged",
        defaultChecked: false,
        disabled: false,
        note: "shared",
        holders: [],
        holdersStatus: "none",
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-a" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-b" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-shared").textContent).toContain(
        "1 other Task is affected",
      );
    });
    expect(screen.getByTestId("sweep-review-shared").textContent).toContain(
      "Other task",
    );
  });

  it("names an unnamed active-run-cwd holder This agent, never Run directory", async () => {
    const runCwd = {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat" as const,
        ownerId: "chat-1",
      },
      holdKind: "active-run-cwd" as const,
      activity: "working" as const,
      label: "Run directory",
      holderId: "epic-1:chat:chat-1",
    };
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [runCwd],
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
        "Agent “This agent” is still running from this worktree — will be stopped",
      );
    });
    expect(screen.getByTestId("sweep-review-stops").textContent).not.toMatch(
      /Run directory/i,
    );
  });

  it("shows one actor with extra evidence and submits that path once", async () => {
    const idleChat = {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat" as const,
        ownerId: "chat-1",
      },
      holdKind: "chat-turn" as const,
      activity: "idle" as const,
      label: "idle session",
      holderId: "epic-1:chat:chat-1",
    };
    const workingRun = {
      ...idleChat,
      holdKind: "active-run-cwd" as const,
      activity: "working" as const,
      label: "Run directory",
    };
    testState.agentNames = new Map([["chat:chat-1", "Planner"]]);
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [idleChat, workingRun],
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
        "still running from this worktree",
      );
    });
    expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
      "idle session",
    );
    expect(screen.getByTestId("sweep-review-stops").textContent).toContain(
      "Planner",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.lastVariables.worktrees).toEqual([
      {
        worktreePath: "/wt/busy",
        stopOwners: true,
        expectedHoldersRevision: REV_A,
      },
    ]);
  });

  it("resubmits only the refused path after uncertain + HOLDERS_CHANGED", async () => {
    const uncertainBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/maybe",
        branch: "feat-maybe",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [uncertainBusy, refuseBusy];
    testState.uncertain = ["/wt/maybe"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("sweep-review-uncertain").textContent,
      ).toContain("feat-maybe");
    });
    expect(screen.getByTestId("sweep-review-removal").textContent).toContain(
      "1 worktree will be removed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    expect(testState.mutate).toHaveBeenCalledTimes(2);
    expect(
      testState.lastVariables.worktrees.map((target) => target.worktreePath),
    ).toEqual(["/wt/busy"]);
    expect(testState.lastVariables.worktrees[0]?.expectedHoldersRevision).toBe(
      REV_B,
    );
  });

  it("stays on choose when pre-review refresh rejects", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    testState.refresh.mockImplementation(() =>
      Promise.reject(new Error("refresh failed")),
    );
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(testState.refresh).toHaveBeenCalled();
    });
    expect(screen.queryByText("Review this sweep")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review consequences" }),
    ).toBeTruthy();
    expect(testState.mutate).not.toHaveBeenCalled();
  });

  it("ignores a second review click while refresh is in flight", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    let release: ((rows: TestRow[]) => void) | undefined;
    testState.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    expect(testState.refresh).toHaveBeenCalledTimes(1);
    release?.(testState.rows);
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
  });

  it("keeps uncertain disabled and failed unchecked-with-status after Back", async () => {
    const uncertainBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/maybe",
        branch: "feat-maybe",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const failedBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/fail",
        branch: "feat-fail",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [uncertainBusy, failedBusy, refuseBusy];
    testState.uncertain = ["/wt/maybe"];
    testState.failed = ["/wt/fail"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-fail" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-uncertain")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("sweep-worktrees-back"));
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
      ).toBeTruthy();
    });
    const uncertainBox = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-maybe",
    });
    const failedBox = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-fail",
    });
    expect(uncertainBox.hasAttribute("disabled")).toBe(true);
    expect(uncertainBox.getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getAllByTestId("sweep-worktrees-row-outcome")
        .map((node) => node.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unconfirmed/i),
        expect.stringMatching(/couldn't be removed/i),
      ]),
    );
    expect(failedBox.hasAttribute("disabled")).toBe(false);
    expect(failedBox.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps an earlier uncertain banner when a later refusal rebuilds the receipt", async () => {
    const uncertainBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/maybe",
        branch: "feat-maybe",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [uncertainBusy, refuseBusy];
    testState.uncertain = ["/wt/maybe"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("sweep-review-uncertain").textContent,
      ).toContain("feat-maybe");
    });
    testState.uncertain = [];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("sweep-review-uncertain").textContent,
      ).toContain("feat-maybe");
    });
    expect(testState.mutate).toHaveBeenCalledTimes(2);
    expect(
      testState.lastVariables.worktrees.map((target) => target.worktreePath),
    ).toEqual(["/wt/busy"]);
    expect(testState.lastVariables.worktrees[0]?.expectedHoldersRevision).toBe(
      REV_B,
    );
  });

  it("drops an uncertain path that vanishes on refresh", async () => {
    const uncertainBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/maybe",
        branch: "feat-maybe",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [uncertainBusy, refuseBusy];
    testState.uncertain = ["/wt/maybe"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    const { rerender } = render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-uncertain")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("sweep-worktrees-back"));
    testState.rows = [refuseBusy];
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));
    rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
      ).toBeNull();
    });
  });

  it("re-enables an uncertain path that still lists after refresh", async () => {
    const uncertainBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/maybe",
        branch: "feat-maybe",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const refuseBusy = {
      entry: worktreeEntry({
        worktreePath: "/wt/busy",
        branch: "feat-busy",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.rows = [uncertainBusy, refuseBusy];
    testState.uncertain = ["/wt/maybe"];
    testState.holdersChanged = [
      {
        worktreePath: "/wt/busy",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-maybe" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-uncertain")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("sweep-worktrees-back"));
    const locked = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-maybe",
    });
    expect(locked.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("sweep-worktrees-refresh"));
    await waitFor(() => {
      expect(
        screen
          .getByRole("checkbox", { name: "Sweep worktree feat-maybe" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.queryByTestId("sweep-worktrees-row-outcome")).toBeNull();
  });

  it("does not inherit host A's uncertain outcome onto host B's same path", async () => {
    // A host switch is a retarget (session identity is hostId + epic set,
    // matching sweepWorktreeCandidates). Switching back to A does not restore
    // A's session — it is gone.
    const path = "/repo/wt";
    const onA = {
      entry: worktreeEntry({
        worktreePath: path,
        branch: "feat-wt",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    const sibling = {
      entry: worktreeEntry({
        worktreePath: "/repo/other",
        branch: "feat-other",
        inUse: true,
      }),
      tier: "in-use" as const,
      defaultChecked: false,
      disabled: false,
      note: "in-use" as const,
      holders: HOLDERS,
      holdersStatus: "ready" as const,
      holdersRevision: REV_A,
    };
    testState.hostId = "host-a";
    testState.rows = [onA, sibling];
    testState.uncertain = [path];
    testState.holdersChanged = [
      {
        worktreePath: "/repo/other",
        holders: HOLDERS,
        holdersRevision: REV_B,
      },
    ];
    const view = render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-wt" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-other" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop work & sweep" }));
    await waitFor(() => {
      expect(screen.getByTestId("sweep-review-uncertain")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("sweep-worktrees-back"));
    expect(
      screen
        .getByRole("checkbox", { name: "Sweep worktree feat-wt" })
        .hasAttribute("disabled"),
    ).toBe(true);
    testState.hostId = "host-b";
    testState.rows = [onA];
    testState.uncertain = [];
    testState.holdersChanged = [];
    view.rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    const onB = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-wt",
    });
    expect(onB.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("sweep-worktrees-row-outcome")).toBeNull();
    testState.hostId = "host-a";
    testState.rows = [onA];
    view.rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    const backOnA = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-wt",
    });
    expect(backOnA.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("sweep-worktrees-row-outcome")).toBeNull();
  });

  it("sweeps on the Review click when pre-review refresh makes the selection safe", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    testState.refresh.mockImplementation(() => {
      testState.rows = [
        {
          entry: worktreeEntry({
            worktreePath: "/wt/busy",
            branch: "feat-busy",
            inUse: false,
          }),
          tier: "merged",
          defaultChecked: true,
          disabled: false,
          note: null,
          holders: [],
          holdersStatus: "none",
        },
      ];
      return Promise.resolve(testState.rows);
    });
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(testState.mutate).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Review this sweep")).toBeNull();
    expect(testState.lastVariables.worktrees).toEqual([
      {
        worktreePath: "/wt/busy",
        stopOwners: false,
        expectedHoldersRevision: undefined,
      },
    ]);
  });

  it("opens review when pre-review refresh leaves the selection elevated", async () => {
    testState.rows = [
      {
        entry: worktreeEntry({
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          inUse: true,
        }),
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
        holdersStatus: "ready",
        holdersRevision: REV_A,
      },
    ];
    renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review consequences" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Review this sweep")).toBeTruthy();
    });
    expect(testState.mutate).not.toHaveBeenCalled();
  });
});
