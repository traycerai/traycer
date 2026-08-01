import { describe, expect, it } from "vitest";
import { terminalSessionTitle } from "../terminal-title";

describe("terminalSessionTitle", () => {
  it("prefers a user title over the active process name", () => {
    expect(
      terminalSessionTitle({
        title: "Manual name",
        activeProcessName: "vim",
        currentCwd: "/work/very-long-directory-name",
      }),
    ).toBe("Manual name");
  });

  it("prefixes an active process with the directory basename", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "vim",
        currentCwd: "/work/repo",
      }),
    ).toBe("repo · vim");
  });

  it("uses the process name alone when no directory is available", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "vim",
        currentCwd: null,
      }),
    ).toBe("vim");
  });

  it("adds the directory name for an idle shell", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "  ",
        currentCwd: "/work/repo/",
      }),
    ).toBe("repo · New Terminal");
  });

  it("falls back to the plain default when no directory is available", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: null,
        currentCwd: null,
      }),
    ).toBe("New Terminal");
  });
});
