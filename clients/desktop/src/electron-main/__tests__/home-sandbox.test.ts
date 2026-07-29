import { mkdtempSync, rmSync } from "node:fs";
import os, { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxHome } from "./sandbox-home";

// Pins the contract of vitest.setup.ts + sandboxHome(): the suite's notion
// of "home" must be impossible to point at the real `~` - on ANY runtime.
// The escape this closes wrote the `cli-bytes-v2` fixture into the real
// `~/.traycer/cli/bin/traycer` (a dead CLI in the field on v1.1.9-rc.3)
// and "Studio Mac" into the real `~/.traycer/host/host-name.json`, because
// Bun's `os.homedir()` ignores a mid-process `process.env.HOME` mutation
// while Node's follows it.

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
});

describe("home sandbox (vitest.setup.ts + sandboxHome)", () => {
  it("baselines homedir() into a temp sandbox before any test runs", () => {
    // The setup file must have redirected home before this file loaded, so
    // even a suite that never touches HOME (or writes through electron-log)
    // resolves a sandbox, never the real user home.
    expect(homedir()).toContain("traycer-desktop-tests-home-");
  });

  it("homedir() follows a mid-test sandboxHome() redirect on every runtime", () => {
    // Node re-reads $HOME per call; Bun caches home at startup and needs
    // the setup's homedir re-point for this to hold. Either way, the suite
    // contract is the same: after sandboxHome(dir), homedir() IS dir.
    const dir = mkdtempSync(join(tmpdir(), "home-sandbox-contract-"));
    try {
      sandboxHome(dir);
      expect(homedir()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sandboxHome throws before the subject runs when homedir() does not follow", () => {
    // Simulates the escape: a runtime whose homedir() ignores the env
    // redirect (Bun without the setup re-point). The tripwire must refuse
    // to hand control to a test body that would write home-relative paths.
    const patched = os.homedir;
    (os as { homedir: () => string }).homedir = () =>
      "/definitely/not/the/sandbox";
    try {
      expect(() => sandboxHome("/tmp/some-sandbox")).toThrowError(
        /refusing to run a suite that writes home-relative paths/,
      );
    } finally {
      (os as { homedir: () => string }).homedir = patched;
    }
  });

  it("electron-log's file transport resolves under the sandbox, not the real user log", async () => {
    // The Jul 2026 pollution vector: suites importing the real electron-log
    // appended their error stacks to the REAL ~/Library/Logs/Traycer/
    // main.log, because its file transport finds "home" via require("os")
    // .homedir(). With the setup baseline in place it must land in the
    // sandbox.
    const log = (await import("electron-log")).default;
    const file = log.transports.file.getFile();
    expect(file.path).toContain("traycer-desktop-tests-home-");
  });
});
