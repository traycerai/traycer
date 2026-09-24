import { describe, expect, it } from "vitest";
import {
  DESKTOP_LIFECYCLE_ORIGIN_COMMANDS,
  withDesktopLifecycleOrigin,
} from "../lifecycle-origin-args";

const STARTING_COMMANDS: readonly (readonly string[])[] = [
  ["host", "ensure"],
  ["host", "install"],
  ["host", "apply"],
  ["host", "service", "install"],
  ["host", "service", "start"],
  ["host", "restart"],
  ["host", "free-port-and-restart"],
  ["host", "stop"],
];

const UNTOUCHED_COMMANDS: readonly (readonly string[])[] = [
  ["host", "download"],
  ["host", "uninstall"],
  ["host", "service", "uninstall"],
  ["host", "update-verify"],
  ["host", "stamp-runtime"],
  ["host", "purge-stage"],
  ["host", "available"],
  ["host", "doctor"],
  ["host", "status"],
];

describe("DESKTOP_LIFECYCLE_ORIGIN_COMMANDS", () => {
  it("names exactly the eight start-capable commands", () => {
    expect(DESKTOP_LIFECYCLE_ORIGIN_COMMANDS.length).toBe(8);
    expect(DESKTOP_LIFECYCLE_ORIGIN_COMMANDS).toEqual(STARTING_COMMANDS);
  });
});

describe("withDesktopLifecycleOrigin", () => {
  for (const command of STARTING_COMMANDS) {
    it(`appends the origin flag to ${command.join(" ")}`, () => {
      expect(withDesktopLifecycleOrigin(command)).toEqual([
        ...command,
        "--lifecycle-origin",
        "desktop",
      ]);
    });

    it(`preserves extra args for ${command.join(" ")}`, () => {
      const args = [...command, "--json", "--keep-installed"];
      expect(withDesktopLifecycleOrigin(args)).toEqual([
        ...args,
        "--lifecycle-origin",
        "desktop",
      ]);
    });
  }

  for (const command of UNTOUCHED_COMMANDS) {
    it(`leaves ${command.join(" ")} unchanged`, () => {
      const args = [...command, "--json"];
      expect(withDesktopLifecycleOrigin(args)).toEqual(args);
    });
  }

  it("does not add a second flag when one is already present", () => {
    const args = ["host", "ensure", "--lifecycle-origin", "desktop"];
    const result = withDesktopLifecycleOrigin(args);
    expect(result).toEqual(args);
    expect(result.filter((arg) => arg === "--lifecycle-origin").length).toBe(1);
  });

  it("does not match a command that merely shares a prefix word", () => {
    expect(withDesktopLifecycleOrigin(["host", "service"])).toEqual([
      "host",
      "service",
    ]);
    expect(withDesktopLifecycleOrigin([])).toEqual([]);
  });
});
