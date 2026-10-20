import { describe, expect, it } from "vitest";
import {
  TRAYCER_DATA_DIR_ENV,
  parseSetupDataRootInput,
} from "../data-root-setup-input";

describe("parseSetupDataRootInput", () => {
  it("lets an explicit --to win over a valid environment value", () => {
    expect(
      parseSetupDataRootInput({
        explicitTo: "/flag/root",
        env: { [TRAYCER_DATA_DIR_ENV]: "/env/root" },
        platform: "posix",
      }),
    ).toEqual({
      kind: "selected",
      source: "flag",
      requested: "/flag/root",
      root: "/flag/root",
    });
  });

  it("uses the environment when no explicit destination was given", () => {
    expect(
      parseSetupDataRootInput({
        explicitTo: null,
        env: { [TRAYCER_DATA_DIR_ENV]: "/env/root" },
        platform: "posix",
      }),
    ).toEqual({
      kind: "selected",
      source: "environment",
      requested: "/env/root",
      root: "/env/root",
    });
  });

  it("returns none when neither is given", () => {
    expect(
      parseSetupDataRootInput({ explicitTo: null, env: {}, platform: "posix" }),
    ).toEqual({ kind: "none" });
    expect(
      parseSetupDataRootInput({
        explicitTo: null,
        env: { [TRAYCER_DATA_DIR_ENV]: undefined },
        platform: "posix",
      }),
    ).toEqual({ kind: "none" });
  });

  it("treats an empty environment value as invalid, not as unset", () => {
    const parsed = parseSetupDataRootInput({
      explicitTo: null,
      env: { [TRAYCER_DATA_DIR_ENV]: "" },
      platform: "posix",
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.source).toBe("environment");
      expect(parsed.requested).toBe("");
    }
  });

  it("reports an invalid flag with source flag even when the environment is valid", () => {
    const parsed = parseSetupDataRootInput({
      explicitTo: "relative/path",
      env: { [TRAYCER_DATA_DIR_ENV]: "/env/root" },
      platform: "posix",
    });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.source).toBe("flag");
      expect(parsed.requested).toBe("relative/path");
      expect(parsed.reason.length).toBeGreaterThan(0);
    }
  });

  it("looks the variable up case-insensitively on win32", () => {
    expect(
      parseSetupDataRootInput({
        explicitTo: null,
        env: { traycer_data_dir: "D:\\x" },
        platform: "win32",
      }),
    ).toEqual({
      kind: "selected",
      source: "environment",
      requested: "D:\\x",
      root: "D:\\x",
    });
  });

  it("looks the variable up by exact case on posix", () => {
    expect(
      parseSetupDataRootInput({
        explicitTo: null,
        env: { traycer_data_dir: "/x/y" },
        platform: "posix",
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns the normalized root and the original requested spelling", () => {
    expect(
      parseSetupDataRootInput({
        explicitTo: "d:/Traycer Data/",
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      kind: "selected",
      source: "flag",
      requested: "d:/Traycer Data/",
      root: "D:\\Traycer Data",
    });
  });
});
