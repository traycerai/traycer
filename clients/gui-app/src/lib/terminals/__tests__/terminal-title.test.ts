import { describe, expect, it } from "vitest";
import { terminalSessionTitle } from "../terminal-title";

describe("terminalSessionTitle", () => {
  it("prefers a user title over the active process name", () => {
    expect(
      terminalSessionTitle({
        title: "Manual name",
        activeProcessName: "vim",
        currentCwd: "/work/very-long-directory-name",
        taskHome: null,
      }),
    ).toBe("Manual name");
  });

  it("prefixes an active process with the directory basename", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "vim",
        currentCwd: "/work/repo",
        taskHome: null,
      }),
    ).toBe("repo · vim");
  });

  it("uses the process name alone when no directory is available", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "vim",
        currentCwd: null,
        taskHome: null,
      }),
    ).toBe("vim");
  });

  it("adds the directory name for an idle shell", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "  ",
        currentCwd: "/work/repo/",
        taskHome: null,
      }),
    ).toBe("repo · New Terminal");
  });

  it("falls back to the plain default when no directory is available", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: null,
        currentCwd: null,
        taskHome: null,
      }),
    ).toBe("New Terminal");
  });

  it("treats an empty directory as unavailable", () => {
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: "vim",
        currentCwd: "",
        taskHome: null,
      }),
    ).toBe("vim");
    expect(
      terminalSessionTitle({
        title: null,
        activeProcessName: null,
        currentCwd: "",
        taskHome: null,
      }),
    ).toBe("New Terminal");
  });

  it.each(["/", "C:\\", "C:/"])(
    "preserves the root directory label for %s",
    (currentCwd) => {
      expect(
        terminalSessionTitle({
          title: null,
          activeProcessName: "vim",
          currentCwd,
          taskHome: null,
        }),
      ).toBe(`${currentCwd} · vim`);
      expect(
        terminalSessionTitle({
          title: null,
          activeProcessName: null,
          currentCwd,
          taskHome: null,
        }),
      ).toBe(`${currentCwd} · New Terminal`);
    },
  );

  describe("in the task's own directory", () => {
    const taskHome = { epicId: "epic-7", hostName: "e2e-sbx-p1" };
    const cwd = "/home/traycer/.traycer/epics/epic-7";

    it("names an idle terminal by its host, never the task id", () => {
      expect(
        terminalSessionTitle({
          title: null,
          activeProcessName: null,
          currentCwd: cwd,
          taskHome,
        }),
      ).toBe("e2e-sbx-p1");
    });

    it("prefixes a running process with the host's name", () => {
      expect(
        terminalSessionTitle({
          title: null,
          activeProcessName: "vim",
          currentCwd: cwd,
          taskHome,
        }),
      ).toBe("e2e-sbx-p1 · vim");
    });

    it("keeps another directory's name beside New Terminal", () => {
      expect(
        terminalSessionTitle({
          title: null,
          activeProcessName: null,
          currentCwd: "/work/repo",
          taskHome,
        }),
      ).toBe("repo · New Terminal");
    });
  });
});
