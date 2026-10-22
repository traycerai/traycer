import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { buildProgramWithAgentRoles } from "../../index";
import { addRunnerFlags } from "../../runner/commander-flags";

// The published CLI reference, read as shipped. A person scheduling a Task
// from cron reads this page, not `--help`, so every option the command
// accepts has to be on it.
const COMMANDS_MDX = readFileSync(
  join(import.meta.dirname, "../../../../../mintlify/cli/commands.mdx"),
  "utf8",
);

// The runner's own switches, documented once under Global Flags.
const RUNNER_FLAGS: ReadonlySet<string | undefined> = new Set(
  addRunnerFlags(new Command("probe")).options.map((option) => option.long),
);

beforeEach(() => {
  vi.stubEnv("TRAYCER_AGENT_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cli/commands.mdx: traycer task create", () => {
  it("has a command row and names every option the command registers", () => {
    expect(COMMANDS_MDX).toMatch(/^\| `traycer task create[^|]*` \|/m);

    const program = buildProgramWithAgentRoles(true);
    const task = program.commands.find((child) => child.name() === "task");
    const create = task?.commands.find((child) => child.name() === "create");
    if (create === undefined)
      throw new Error("traycer task create is not registered");
    const own = create.options
      .map((option) => option.long)
      .filter(
        (long): long is string => long !== undefined && !RUNNER_FLAGS.has(long),
      );
    expect(own.length).toBeGreaterThan(0);
    const missing = own.filter((long) => !COMMANDS_MDX.includes(`\`${long}`));
    expect(
      missing,
      `undocumented task create options: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists task create among the commands a read-only agent is refused", () => {
    const readOnly = /### Read-Only Agents\n\n([^\n]+)/.exec(COMMANDS_MDX);
    expect(readOnly?.[1]).toContain("`task create`");
  });
});
