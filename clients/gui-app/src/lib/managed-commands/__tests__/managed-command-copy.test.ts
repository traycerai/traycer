import { describe, expect, it } from "vitest";
import {
  MANAGED_COMMAND_NOUN,
  managedCommandNoun,
  managedCommandRestartDeltaPhrase,
  managedCommandRestartTitle,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";

describe("managed command naming", () => {
  it("titles a watching shell Monitor and a quiet one Shell", () => {
    expect(
      managedCommandTitle({ description: "deploy watcher", monitoring: true }),
    ).toBe("Monitor · deploy watcher");
    expect(
      managedCommandTitle({ description: "db migration", monitoring: false }),
    ).toBe("Shell · db migration");
  });

  it("drops the separator when a shell carries no description", () => {
    // The " · " promises a name after it. One guard, here, so no surface has
    // to remember to write its own - which is how the resource monitor ended
    // up with a second spelling of this title.
    expect(managedCommandTitle({ description: "", monitoring: true })).toBe(
      "Monitor",
    );
    expect(managedCommandTitle({ description: "", monitoring: false })).toBe(
      MANAGED_COMMAND_NOUN,
    );
  });

  it("keeps the umbrella noun for copy that names no particular shell", () => {
    // The container ("Shells"), the resource monitor's kind column and the
    // output window's own name all speak about shells in general, where there
    // is no flag to follow.
    expect(MANAGED_COMMAND_NOUN).toBe("Shell");
    expect(managedCommandNoun(false)).toBe(MANAGED_COMMAND_NOUN);
    expect(managedCommandNoun(true)).toBe("Monitor");
  });
});

describe("restart card copy", () => {
  it("titles a restart in the shell's own noun, same guard for an empty description", () => {
    expect(
      managedCommandRestartTitle({
        description: "deploy watcher",
        monitoring: true,
      }),
    ).toBe("Restarted Monitor · deploy watcher");
    expect(
      managedCommandRestartTitle({
        description: "db migration",
        monitoring: false,
      }),
    ).toBe("Restarted Shell · db migration");
    // No dangling "· " when there is no name to follow it.
    expect(
      managedCommandRestartTitle({ description: "", monitoring: true }),
    ).toBe("Restarted Monitor");
    expect(
      managedCommandRestartTitle({ description: "", monitoring: false }),
    ).toBe("Restarted Shell");
  });

  it("phrases the delta against the spec the shell ran under before the call", () => {
    expect(
      managedCommandRestartDeltaPhrase({
        commandChanged: false,
        cwdChanged: false,
      }),
    ).toBe("same command and cwd");
    expect(
      managedCommandRestartDeltaPhrase({
        commandChanged: true,
        cwdChanged: false,
      }),
    ).toBe("command changed");
    expect(
      managedCommandRestartDeltaPhrase({
        commandChanged: false,
        cwdChanged: true,
      }),
    ).toBe("cwd changed");
    expect(
      managedCommandRestartDeltaPhrase({
        commandChanged: true,
        cwdChanged: true,
      }),
    ).toBe("command and cwd changed");
  });
});
