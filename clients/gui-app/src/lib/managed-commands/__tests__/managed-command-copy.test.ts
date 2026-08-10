import { describe, expect, it } from "vitest";
import {
  MANAGED_COMMAND_NOUN,
  managedCommandNoun,
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

  it("keeps the umbrella noun for copy that names no particular shell", () => {
    // The container ("Shells"), the resource monitor's kind column and the
    // output window's own name all speak about shells in general, where there
    // is no flag to follow.
    expect(MANAGED_COMMAND_NOUN).toBe("Shell");
    expect(managedCommandNoun(false)).toBe(MANAGED_COMMAND_NOUN);
    expect(managedCommandNoun(true)).toBe("Monitor");
  });
});
