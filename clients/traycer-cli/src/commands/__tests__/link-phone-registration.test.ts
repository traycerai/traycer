import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../index";

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

describe("link-phone registration", () => {
  it("registers `link-phone` alongside the other auth commands", () => {
    const program = buildProgram();
    const cmd = findSubcommand(program, "link-phone");
    expect(cmd, "expected `link-phone` to be registered").not.toBeNull();
  });

  it("carries --no-qr and the shared runner flags", () => {
    const program = buildProgram();
    const cmd = findSubcommand(program, "link-phone");
    if (cmd === null) {
      throw new Error("unreachable: `link-phone` not found");
    }
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--no-qr");
    expect(flags).toContain("--json");
    expect(flags).toContain("--quiet");
  });

  it("stays visible in the top-level help", () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain("link-phone");
  });
});
