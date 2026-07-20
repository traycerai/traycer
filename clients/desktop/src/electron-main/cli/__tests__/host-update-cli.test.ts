import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Host exact-update safety (RC update-channel review findings 4/6/7 host half):
// Desktop always pins `host update --release <version>` and never falls back
// to bare `host update`. Capability probing decides whether the authoritative
// discoverCli binary can do that, otherwise a distinct capable bundled CLI is
// used. Non-RC prereleases are not consented channel targets.

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info", resolvePathFn: vi.fn() },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  transports: {
    file: { level: "info", resolvePathFn: vi.fn() },
    console: { level: "info" },
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

const discoveryState = vi.hoisted(() => ({
  discover: null as null | (() => Promise<unknown>),
  bundled: null as null | (() => Promise<string | null>),
}));

vi.mock("../cli-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-discovery")>();
  return {
    ...actual,
    discoverCli: async () => {
      if (discoveryState.discover === null) {
        throw new Error("discoverCli not configured for this test");
      }
      return discoveryState.discover();
    },
    resolveBundledCliPath: async () => {
      if (discoveryState.bundled === null) {
        throw new Error("resolveBundledCliPath not configured for this test");
      }
      return discoveryState.bundled();
    },
  };
});

type ExecFileCallback = (
  err: Error | null,
  stdout: string,
  stderr: string,
) => void;

const execFileState = vi.hoisted(() => ({
  impl: null as
    | null
    | ((
        cmd: string,
        args: readonly string[],
        opts: unknown,
        cb: ExecFileCallback,
      ) => void),
}));

vi.mock("node:child_process", () => {
  const execFile = (
    cmd: string,
    args: readonly string[],
    opts: unknown,
    cb: ExecFileCallback,
  ) => {
    if (execFileState.impl === null) {
      throw new Error("execFile not configured for this test");
    }
    execFileState.impl(cmd, args, opts, cb);
  };
  return {
    execFile,
    default: { execFile },
  };
});

const HELP_WITH_RELEASE =
  "Usage: traycer host update [options]\n  --release <version>  Install an exact registry release\n";
const HELP_WITHOUT_RELEASE =
  "Usage: traycer host update [options]\n  Update the host to the latest release\n";

function configureProbeHelp(byPath: ReadonlyMap<string, string>): void {
  execFileState.impl = (cmd, args, _opts, cb) => {
    expect(args).toEqual(["host", "update", "--help"]);
    const help = byPath.get(cmd);
    if (help === undefined) {
      cb(new Error(`ENOENT: ${cmd}`), "", "");
      return;
    }
    cb(null, help, "");
  };
}

beforeEach(() => {
  discoveryState.discover = null;
  discoveryState.bundled = null;
  execFileState.impl = null;
  vi.resetModules();
});

afterEach(async () => {
  const { clearHostUpdateCliCapabilityCache } =
    await import("../host-update-cli");
  clearHostUpdateCliCapabilityCache();
  discoveryState.discover = null;
  discoveryState.bundled = null;
  execFileState.impl = null;
});

describe("isConsentedHostChannelVersion", () => {
  it("accepts stable X.Y.Z and X.Y.Z-rc.N, with optional build metadata", async () => {
    const { isConsentedHostChannelVersion } =
      await import("../host-update-cli");
    expect(isConsentedHostChannelVersion("1.0.0")).toBe(true);
    expect(isConsentedHostChannelVersion("1.4.2")).toBe(true);
    expect(isConsentedHostChannelVersion("10.20.30")).toBe(true);
    expect(isConsentedHostChannelVersion("1.5.0-rc.1")).toBe(true);
    expect(isConsentedHostChannelVersion("2.0.0-rc.12")).toBe(true);
    expect(isConsentedHostChannelVersion("1.0.0+build.1")).toBe(true);
    expect(isConsentedHostChannelVersion("1.5.0-rc.1+meta")).toBe(true);
  });

  it("rejects alpha/beta/nightly and other non-RC prerelease forms", async () => {
    const { isConsentedHostChannelVersion } =
      await import("../host-update-cli");
    expect(isConsentedHostChannelVersion("2.0.0-alpha.1")).toBe(false);
    expect(isConsentedHostChannelVersion("2.0.0-beta.1")).toBe(false);
    expect(isConsentedHostChannelVersion("2.0.0-alpha")).toBe(false);
    expect(isConsentedHostChannelVersion("1.0.0-nightly.20260101")).toBe(false);
    expect(isConsentedHostChannelVersion("1.0.0-rc")).toBe(false);
    expect(isConsentedHostChannelVersion("1.0.0-rc1")).toBe(false);
    expect(isConsentedHostChannelVersion("1.0.0-RC.1")).toBe(false);
    expect(isConsentedHostChannelVersion("1.0")).toBe(false);
    expect(isConsentedHostChannelVersion("v1.0.0")).toBe(false);
    expect(isConsentedHostChannelVersion("latest")).toBe(false);
    expect(isConsentedHostChannelVersion("")).toBe(false);
  });

  // Strict SemVer numeric identifiers + build metadata (no leading zeros,
  // no empty build segments) keep the app channel from admitting near-miss
  // labels that would otherwise match a looser `\d+` pattern.
  it("rejects malformed SemVer labels with leading zeros or empty build segments", async () => {
    const { isConsentedHostChannelVersion } =
      await import("../host-update-cli");
    expect(isConsentedHostChannelVersion("01.2.3")).toBe(false);
    expect(isConsentedHostChannelVersion("1.2.3-rc.01")).toBe(false);
    expect(isConsentedHostChannelVersion("1.2.3+foo..bar")).toBe(false);
  });
});

describe("exactHostUpdateArgs", () => {
  it("always pins host update --release <version>", async () => {
    const { exactHostUpdateArgs } = await import("../host-update-cli");
    expect(exactHostUpdateArgs("1.7.0")).toEqual([
      "host",
      "update",
      "--release",
      "1.7.0",
    ]);
    expect(exactHostUpdateArgs("1.5.0-rc.2")).toEqual([
      "host",
      "update",
      "--release",
      "1.5.0-rc.2",
    ]);
  });
});

describe("probeCliSupportsHostUpdateRelease", () => {
  it("returns true when help text contains the --release flag token", async () => {
    configureProbeHelp(
      new Map([["/usr/local/bin/traycer", HELP_WITH_RELEASE]]),
    );
    const {
      probeCliSupportsHostUpdateRelease,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(
      probeCliSupportsHostUpdateRelease("/usr/local/bin/traycer"),
    ).resolves.toBe(true);
  });

  it("returns false when help lacks --release or the binary fails empty", async () => {
    configureProbeHelp(new Map([["/old/traycer", HELP_WITHOUT_RELEASE]]));
    const {
      probeCliSupportsHostUpdateRelease,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(
      probeCliSupportsHostUpdateRelease("/old/traycer"),
    ).resolves.toBe(false);

    execFileState.impl = (_cmd, _args, _opts, cb) => {
      cb(new Error("spawn ENOENT"), "", "");
    };
    clearHostUpdateCliCapabilityCache();
    await expect(
      probeCliSupportsHostUpdateRelease("/missing/traycer"),
    ).resolves.toBe(false);
  });

  it("does not treat free-form 'release' prose as the --release flag", async () => {
    configureProbeHelp(
      new Map([
        [
          "/usr/local/bin/traycer",
          "Update the host to the latest release from the registry\n",
        ],
      ]),
    );
    const {
      probeCliSupportsHostUpdateRelease,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(
      probeCliSupportsHostUpdateRelease("/usr/local/bin/traycer"),
    ).resolves.toBe(false);
  });

  it("caches positive capability per binary path for the process lifetime", async () => {
    let calls = 0;
    execFileState.impl = (cmd, _args, _opts, cb) => {
      calls += 1;
      cb(
        null,
        cmd === "/cached/traycer" ? HELP_WITH_RELEASE : HELP_WITHOUT_RELEASE,
        "",
      );
    };
    const {
      probeCliSupportsHostUpdateRelease,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(
      probeCliSupportsHostUpdateRelease("/cached/traycer"),
    ).resolves.toBe(true);
    await expect(
      probeCliSupportsHostUpdateRelease("/cached/traycer"),
    ).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("re-probes a previously incapable path so an in-place CLI upgrade is recognized", async () => {
    let calls = 0;
    execFileState.impl = (_cmd, _args, _opts, cb) => {
      calls += 1;
      // First probe: old binary without --release. Later probes: upgraded
      // bytes at the same path that advertise the flag.
      cb(null, calls === 1 ? HELP_WITHOUT_RELEASE : HELP_WITH_RELEASE, "");
    };
    const {
      probeCliSupportsHostUpdateRelease,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();

    await expect(
      probeCliSupportsHostUpdateRelease("/usr/local/bin/traycer"),
    ).resolves.toBe(false);
    await expect(
      probeCliSupportsHostUpdateRelease("/usr/local/bin/traycer"),
    ).resolves.toBe(true);
    // Positive result is sticky after the upgrade is observed.
    await expect(
      probeCliSupportsHostUpdateRelease("/usr/local/bin/traycer"),
    ).resolves.toBe(true);
    expect(calls).toBe(2);
  });
});

describe("resolveExactHostUpdateCli", () => {
  it("returns the authoritative binary when it supports --release", async () => {
    discoveryState.discover = async () => ({
      kind: "path",
      binaryPath: "/usr/local/bin/traycer",
    });
    discoveryState.bundled = async () => "/Resources/cli/traycer";
    configureProbeHelp(
      new Map([
        ["/usr/local/bin/traycer", HELP_WITH_RELEASE],
        ["/Resources/cli/traycer", HELP_WITH_RELEASE],
      ]),
    );
    const { resolveExactHostUpdateCli, clearHostUpdateCliCapabilityCache } =
      await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).resolves.toEqual({
      command: "/usr/local/bin/traycer",
      args: [],
    });
  });

  it("falls back to a distinct capable bundled CLI when the external CLI lacks --release", async () => {
    discoveryState.discover = async () => ({
      kind: "path",
      binaryPath: "/usr/local/bin/old-traycer",
    });
    discoveryState.bundled = async () => "/Resources/cli/traycer";
    configureProbeHelp(
      new Map([
        ["/usr/local/bin/old-traycer", HELP_WITHOUT_RELEASE],
        ["/Resources/cli/traycer", HELP_WITH_RELEASE],
      ]),
    );
    const { resolveExactHostUpdateCli, clearHostUpdateCliCapabilityCache } =
      await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).resolves.toEqual({
      command: "/Resources/cli/traycer",
      args: [],
    });
  });

  it("throws HostUpdateCliCapabilityError with upgrade guidance when neither CLI supports --release", async () => {
    discoveryState.discover = async () => ({
      kind: "path",
      binaryPath: "/usr/local/bin/old-traycer",
    });
    discoveryState.bundled = async () => "/Resources/cli/also-old-traycer";
    configureProbeHelp(
      new Map([
        ["/usr/local/bin/old-traycer", HELP_WITHOUT_RELEASE],
        ["/Resources/cli/also-old-traycer", HELP_WITHOUT_RELEASE],
      ]),
    );
    const {
      resolveExactHostUpdateCli,
      HostUpdateCliCapabilityError,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HostUpdateCliCapabilityError &&
        err.code === "HOST_UPDATE_CLI_CAPABILITY" &&
        /host update --release/i.test(err.message) &&
        /Upgrade the traycer CLI|reinstall Traycer Desktop/i.test(err.message),
    );
  });

  it("throws when discovery yields none and there is no capable bundled CLI", async () => {
    discoveryState.discover = async () => ({ kind: "none" });
    discoveryState.bundled = async () => null;
    execFileState.impl = (_cmd, _args, _opts, cb) => {
      cb(new Error("should not probe"), "", "");
    };
    const {
      resolveExactHostUpdateCli,
      HostUpdateCliCapabilityError,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).rejects.toBeInstanceOf(
      HostUpdateCliCapabilityError,
    );
  });

  it("uses bundled CLI when discovery is none but bundled supports --release", async () => {
    discoveryState.discover = async () => ({ kind: "none" });
    discoveryState.bundled = async () => "/Resources/cli/traycer";
    configureProbeHelp(
      new Map([["/Resources/cli/traycer", HELP_WITH_RELEASE]]),
    );
    const { resolveExactHostUpdateCli, clearHostUpdateCliCapabilityCache } =
      await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).resolves.toEqual({
      command: "/Resources/cli/traycer",
      args: [],
    });
  });

  it("does not re-probe the same path when primary and bundled resolve to the same binary", async () => {
    discoveryState.discover = async () => ({
      kind: "bundled",
      binaryPath: "/Resources/cli/traycer",
    });
    discoveryState.bundled = async () => "/Resources/cli/traycer";
    configureProbeHelp(
      new Map([["/Resources/cli/traycer", HELP_WITHOUT_RELEASE]]),
    );
    const {
      resolveExactHostUpdateCli,
      HostUpdateCliCapabilityError,
      clearHostUpdateCliCapabilityCache,
    } = await import("../host-update-cli");
    clearHostUpdateCliCapabilityCache();
    await expect(resolveExactHostUpdateCli()).rejects.toBeInstanceOf(
      HostUpdateCliCapabilityError,
    );
  });
});
