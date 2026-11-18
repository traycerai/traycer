import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

// The list of commands carrying `--lifecycle-origin` must be
// ONE list, shared by the desktop and the CLI - `LIFECYCLE_ORIGIN_COMMANDS`
// (`protocol/src/config/lifecycle-origin-commands.ts`). The CLI's own
// `assertLifecycleOriginCommands` (`index.ts`) already checks its
// registrations against that list on every `buildProgramWithAgentRoles`
// call, including the plain `buildProgram()` this suite (and
// `cli-lifecycle-origin-flag.test.ts`) uses. This file pins the SAME
// invariant independently: walking the built program directly and comparing
// the set of `--lifecycle-origin` command paths to the shared list, so a
// drift is caught even if the production assert's own wiring were the thing
// that broke.
//
// HOME is redirected to a private temp dir before anything reads it. Building
// the program should touch nothing under `~/.traycer` - `readFeatureSettingsSync`
// is the one call in `buildProgram()` that resolves a path off `homedir()` -
// but this suite proves that rather than assuming it.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-cli-lifecycle-origin-commands-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

import { buildProgram } from "../index";
import { LIFECYCLE_ORIGIN_COMMANDS } from "@traycer/protocol/config/lifecycle-origin-commands";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

function commandPathsWithLifecycleOrigin(program: Command): Set<string> {
  const registered = new Set<string>();
  const visit = (command: Command, path: readonly string[]): void => {
    for (const child of command.commands) {
      const childPath = [...path, child.name()];
      if (
        child.options.some((option) => option.long === "--lifecycle-origin")
      ) {
        registered.add(childPath.join(" "));
      }
      visit(child, childPath);
    }
  };
  visit(program, []);
  return registered;
}

describe("the built program's --lifecycle-origin registrations match LIFECYCLE_ORIGIN_COMMANDS", () => {
  it("registers --lifecycle-origin on exactly the shared list's command paths", () => {
    const program = buildProgram();

    const registered = [...commandPathsWithLifecycleOrigin(program)].sort();
    const expected = [...LIFECYCLE_ORIGIN_COMMANDS]
      .map((path) => path.join(" "))
      .sort();

    expect(registered).toEqual(expected);
  });

  it("builds without throwing (the production assert passes)", () => {
    expect(() => buildProgram()).not.toThrow();
  });
});
