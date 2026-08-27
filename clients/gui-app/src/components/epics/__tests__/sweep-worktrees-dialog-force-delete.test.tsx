import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";

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
  },
];

const testState = vi.hoisted(() => ({
  mutate: vi.fn(),
  rows: [] as Array<{
    entry: WorktreeHostEntryV14;
    tier: "merged" | "at-base-commit" | "in-use";
    defaultChecked: boolean;
    disabled: boolean;
    note: "in-use" | null;
    holders: readonly WorktreeBusyHolder[];
  }>,
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktree-candidates-query", () => ({
  useEpicSweepWorktreeCandidatesForClient: () => ({
    hostId: "host-1",
    rows: testState.rows,
    isPending: false,
    isError: false,
    checkedAt: Date.now(),
    canRefresh: true,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@/hooks/epic/use-epic-sweep-worktrees-mutation", () => ({
  useEpicSweepWorktrees: () => ({
    isPending: false,
    mutate: testState.mutate,
  }),
  useSweepingWorktreePaths: () => new Set<string>(),
}));

vi.mock("@/components/worktree/worktree-pr-metadata", () => ({
  WorktreePrPills: () => null,
}));

import { SweepWorktreesDialog } from "@/components/epics/sweep-worktrees-dialog";

function unknownInUseStopLabel(worktreeIdentity: string): string {
  return `Background work in ${worktreeIdentity} will be stopped (details unavailable on this host)`;
}

function worktreeEntry(
  over: Partial<WorktreeHostEntryV14> & { readonly worktreePath: string },
): WorktreeHostEntryV14 {
  return {
    worktreePath: over.worktreePath,
    branch: over.branch ?? "feat-busy",
    repoLabel: "traycerai/traycer",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    inUse: over.inUse ?? false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: "merged",
    prNumber: 1,
    prUrl: "https://example.test/pr/1",
    mergedHeadShaMatches: true,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: Date.now(),
  };
}

describe("SweepWorktreesDialog in-use force-delete", () => {
  afterEach(() => {
    cleanup();
    testState.mutate.mockReset();
  });

  it("never pre-selects in-use rows, surfaces disclosure on deliberate select, and confirms with stopOwners", () => {
    const idle = worktreeEntry({
      worktreePath: "/wt/idle",
      branch: "feat-idle",
      inUse: false,
    });
    const busy = worktreeEntry({
      worktreePath: "/wt/busy",
      branch: "feat-busy",
      inUse: true,
    });
    testState.rows = [
      {
        entry: idle,
        tier: "merged",
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [],
      },
      {
        entry: busy,
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
      },
    ];

    render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );

    const idleBox = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-idle",
    });
    const busyBox = screen.getByRole("checkbox", {
      name: "Sweep worktree feat-busy",
    });
    expect(idleBox.getAttribute("aria-checked")).toBe("true");
    expect(busyBox.getAttribute("aria-checked")).toBe("false");
    expect(busyBox.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();

    fireEvent.click(busyBox);
    expect(
      screen.getByTestId("teardown-disclosure-working").textContent,
    ).toContain("Claude Code agent polite-ocelot is working");
    expect(screen.getByTestId("teardown-disclosure").textContent).not.toMatch(
      /\bbusy\b/i,
    );

    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(testState.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      worktrees: [
        {
          worktreePath: "/wt/idle",
          branch: "feat-idle",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          stopOwners: false,
        },
        {
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          stopOwners: true,
        },
      ],
    });
  });

  it("discloses a generic stop line when an in-use row has no holder inventory, then still force-sweeps", () => {
    const busy = worktreeEntry({
      worktreePath: "/wt/busy",
      branch: "feat-busy",
      inUse: true,
    });
    testState.rows = [
      {
        entry: busy,
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
      },
    ];

    render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-busy" }),
    );
    expect(
      screen.getByTestId("teardown-disclosure-working").textContent,
    ).toContain(unknownInUseStopLabel("feat-busy"));
    fireEvent.click(screen.getByTestId("sweep-worktrees-confirm"));
    expect(testState.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      worktrees: [
        {
          worktreePath: "/wt/busy",
          branch: "feat-busy",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          stopOwners: true,
        },
      ],
    });
  });

  it("drops a checked override when an idle row refreshes to in-use, then re-select discloses", async () => {
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
      holders: [],
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
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();

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
        holders: [],
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
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();

    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByTestId("teardown-disclosure-working").textContent,
    ).toContain(unknownInUseStopLabel("feat-flip"));
  });

  it("drops a checked override when an idle path vanishes from a completed snapshot then reappears in-use", async () => {
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
      holders: [],
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
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();

    // Completed empty/error snapshot: isPending stays false, rows gone.
    testState.rows = [];
    rerender(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("checkbox", { name: "Sweep worktree feat-flip" }),
    ).toBeNull();

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
        holders: [],
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
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();

    fireEvent.click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByTestId("teardown-disclosure-working").textContent,
    ).toContain(unknownInUseStopLabel("feat-flip"));
  });

  it("attributes each unknown in-use stop line and does not synthesize over named holders or idle rows", () => {
    const idle = worktreeEntry({
      worktreePath: "/wt/idle",
      branch: "feat-idle",
      inUse: false,
    });
    const octopus = worktreeEntry({
      worktreePath: "/wt/octopus",
      branch: "feat-octopus",
      inUse: true,
    });
    const narwhal = worktreeEntry({
      worktreePath: "/wt/narwhal",
      branch: "feat-narwhal",
      inUse: true,
    });
    const named = worktreeEntry({
      worktreePath: "/wt/named",
      branch: "feat-named",
      inUse: true,
    });
    testState.rows = [
      {
        entry: idle,
        tier: "merged",
        defaultChecked: true,
        disabled: false,
        note: null,
        holders: [],
      },
      {
        entry: octopus,
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
      },
      {
        entry: narwhal,
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: [],
      },
      {
        entry: named,
        tier: "in-use",
        defaultChecked: false,
        disabled: false,
        note: "in-use",
        holders: HOLDERS,
      },
    ];

    render(
      <SweepWorktreesDialog
        epicIds={["epic-1"]}
        hostClient={null}
        taskTitle="Task"
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-octopus" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-narwhal" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Sweep worktree feat-named" }),
    );

    const disclosure = screen.getByTestId(
      "teardown-disclosure-working",
    ).textContent;
    expect(disclosure).toContain(unknownInUseStopLabel("feat-octopus"));
    expect(disclosure).toContain(unknownInUseStopLabel("feat-narwhal"));
    expect(disclosure).toContain("Claude Code agent polite-ocelot is working");
    expect(disclosure).not.toMatch(/this worktree/i);
    expect(disclosure).not.toContain("feat-idle");
    expect(disclosure).not.toContain("feat-named will be stopped");
  });
});
