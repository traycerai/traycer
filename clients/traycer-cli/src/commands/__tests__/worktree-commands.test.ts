import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../index";

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

function expectCommand(program: Command, path: readonly string[]): Command {
  let cursor: Command = program;
  for (const segment of path) {
    const next = findSubcommand(cursor, segment);
    expect(
      next,
      `expected command '${path.join(" ")}' to be registered`,
    ).not.toBeNull();
    if (next === null) {
      throw new Error(`unreachable: command '${path.join(" ")}' not found`);
    }
    cursor = next;
  }
  return cursor;
}

describe("worktree list / delete registration", () => {
  it("registers `worktree list` with --include-activity and the runner flags", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["worktree", "list"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--include-activity");
    expect(flags).toContain("--json");
    expect(flags).toContain("--no-progress");
  });

  it("registers `worktree delete` with a required --path and the runner flags", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["worktree", "delete"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--path");
    expect(flags).toContain("--json");
    expect(flags).toContain("--no-progress");
  });

  it("keeps both worktree read/create commands visible and delete visible in the full surface", () => {
    const program = buildProgram();
    const worktree = expectCommand(program, ["worktree"]);
    const help = worktree.helpInformation();
    expect(help).toContain("list");
    expect(help).toContain("delete");
    expect(help).toContain("create");
  });
});

describe("worktree delete readonly-surface hiding", () => {
  function withReadonlySurface(run: () => void): void {
    const original = process.env.TRAYCER_AGENT_CLI_SURFACE;
    process.env.TRAYCER_AGENT_CLI_SURFACE = "readonly";
    try {
      run();
    } finally {
      if (original === undefined) {
        delete process.env.TRAYCER_AGENT_CLI_SURFACE;
      } else {
        process.env.TRAYCER_AGENT_CLI_SURFACE = original;
      }
    }
  }

  it("hides `worktree delete` but keeps `worktree list` in the readonly surface", () => {
    withReadonlySurface(() => {
      const program = buildProgram();
      const worktree = expectCommand(program, ["worktree"]);
      const help = worktree.helpInformation();
      // The read command stays available for report-only housekeeping.
      expect(help).toContain("list");
      // Delete is hidden from help ...
      expect(help).not.toContain("delete [options]");
      // ... but still registered (Desktop/host may invoke it directly, and the
      // command itself guards the readonly surface at runtime).
      expectCommand(program, ["worktree", "delete"]);
    });
  });
});
