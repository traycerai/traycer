import { describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeSetupState,
} from "@traycer/protocol/host/worktree-schemas";
import { buildTuiAgentSetupCardModel } from "../tui-agent-setup-card-model";

const OWNER = { epicId: "epic-1", ownerId: "agent-1" };

function entry(
  overrides: Partial<WorktreeBindingEntry> &
    Pick<WorktreeBindingEntry, "workspacePath">,
): WorktreeBindingEntry {
  return {
    workspacePath: overrides.workspacePath,
    mode: overrides.mode ?? "worktree",
    repoIdentifier: overrides.repoIdentifier ?? null,
    worktreePath: overrides.worktreePath ?? null,
    branch: overrides.branch ?? null,
    isPrimary: overrides.isPrimary ?? true,
    isImported: overrides.isImported ?? false,
    setupState: overrides.setupState ?? "succeeded",
    setupTerminalSessionId: overrides.setupTerminalSessionId ?? null,
    setupExitCode: overrides.setupExitCode ?? null,
    setupFailedAt: overrides.setupFailedAt ?? null,
    createdAt: overrides.createdAt ?? 0,
  };
}

function binding(
  entries: ReadonlyArray<WorktreeBindingEntry>,
): WorktreeBinding {
  return { entries: [...entries] };
}

describe("buildTuiAgentSetupCardModel", () => {
  it("returns null for a null binding", () => {
    expect(buildTuiAgentSetupCardModel(null, OWNER)).toBeNull();
  });

  it("returns null when no entry is a created worktree", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([
        entry({ workspacePath: "/repo", mode: "local" }),
        // Imported (adopted, pre-existing) worktrees ran no create step, so the
        // agent shows no creation notice for them - same as the chat deriver.
        entry({ workspacePath: "/repo2", isImported: true }),
      ]),
      OWNER,
    );
    expect(model).toBeNull();
  });

  it("projects a created worktree's fields onto one workspace", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([
        entry({
          workspacePath: "/home/me/repo",
          worktreePath: "/home/me/repo-wt",
          branch: "feat/x",
          setupState: "succeeded",
          setupTerminalSessionId: "setup-term-1",
          createdAt: 42,
        }),
      ]),
      OWNER,
    );
    expect(model).not.toBeNull();
    expect(model?.aggregate).toEqual({
      epicId: "epic-1",
      ownerId: "agent-1",
      ownerKind: "terminal-agent",
      state: "ready",
    });
    expect(model?.createdAt).toBe(42);
    expect(model?.isActive).toBe(false);
    expect(model?.workspaces).toHaveLength(1);
    expect(model?.workspaces[0]).toEqual({
      workspacePath: "/home/me/repo",
      label: "repo",
      state: "ready",
      setupExitCode: null,
      terminalSessionId: "setup-term-1",
      worktreePath: "/home/me/repo-wt",
      branch: "feat/x",
    });
  });

  it("marks a running setup active (spinner + live elapsed)", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([entry({ workspacePath: "/repo", setupState: "running" })]),
      OWNER,
    );
    expect(model?.isActive).toBe(true);
    expect(model?.workspaces[0].state).toBe("setting-up");
    expect(model?.aggregate.state).toBe("setting-up");
  });

  it("surfaces the exit code only for a failed setup", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([
        entry({
          workspacePath: "/repo",
          setupState: "failed",
          setupExitCode: 1,
        }),
      ]),
      OWNER,
    );
    expect(model?.workspaces[0].state).toBe("failed");
    expect(model?.workspaces[0].setupExitCode).toBe(1);
    expect(model?.aggregate.state).toBe("failed");
    // A settled failure is not in flight.
    expect(model?.isActive).toBe(false);
  });

  it.each<[WorktreeSetupState, string]>([
    ["not_required", "ready"],
    ["pending", "setting-up"],
    ["running", "setting-up"],
    ["succeeded", "ready"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ])("maps setup state %s to %s", (setupState, expected) => {
    const model = buildTuiAgentSetupCardModel(
      binding([entry({ workspacePath: "/repo", setupState })]),
      OWNER,
    );
    expect(model?.workspaces[0].state).toBe(expected);
  });

  it("rolls a failed sibling up over a running one and seeds createdAt from the earliest", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([
        entry({
          workspacePath: "/a",
          setupState: "running",
          createdAt: 100,
        }),
        entry({
          workspacePath: "/b",
          setupState: "failed",
          setupExitCode: 2,
          createdAt: 50,
        }),
      ]),
      OWNER,
    );
    expect(model?.workspaces).toHaveLength(2);
    // failed dominates the rollup even while a sibling is still setting up.
    expect(model?.aggregate.state).toBe("failed");
    // still in flight because a sibling is setting up.
    expect(model?.isActive).toBe(true);
    expect(model?.createdAt).toBe(50);
  });

  it("excludes Local and imported entries, keeping only created worktrees", () => {
    const model = buildTuiAgentSetupCardModel(
      binding([
        entry({ workspacePath: "/local", mode: "local" }),
        entry({ workspacePath: "/imported", isImported: true }),
        entry({ workspacePath: "/created", isImported: false }),
      ]),
      OWNER,
    );
    expect(model?.workspaces.map((w) => w.workspacePath)).toEqual(["/created"]);
  });
});
