import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliLogger } from "../logger";

describe("createCliLogger with an unusable data location record", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-logger-lazy-root-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const bootstrap = join(home, ".traycer-bootstrap");
    mkdirSync(bootstrap, { mode: 0o700 });
    writeFileSync(join(bootstrap, "location.json"), "{ not valid json");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("does not throw at construction", () => {
    expect(() => createCliLogger("dev")).not.toThrow();
  });

  it("does not throw when logging at any level, and writes no log under a default folder", () => {
    const logger = createCliLogger("dev");
    expect(() => {
      logger.info("info line", { key: "value" });
      logger.warn("warn line", {});
      logger.error("error line", {}, new Error("boom"));
    }).not.toThrow();
    expect(existsSync(join(home, ".traycer"))).toBe(false);
  });
});
