/**
 * The build without sandboxes (`unreleased-features.ts`): a terminal in the
 * task's own directory is named by that directory, as every other terminal
 * is. Naming it by its host was how an empty sandbox's shell read.
 */
import { describe, expect, it, vi } from "vitest";
import { terminalSessionTitle } from "../terminal-title";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

describe("terminalSessionTitle without sandboxes", () => {
  it("names a task-home terminal by its directory, not by its host", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: null,
        currentCwd: "/home/traycer/.traycer/epics/epic-7",
        taskHome: { epicId: "epic-7", hostName: "e2e-sbx-p1" },
      }),
    ).toBe("epic-7 · New Terminal");
  });
});
