import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native Packaging system-marker fallback. On Linux, the .deb / .rpm
// post-install scripts drop /var/lib/traycer/source.{apt,rpm} so the
// CLI knows the binary is package-manager-owned even before the
// per-user manifest at ~/.traycer/cli/manifest.json has been written.
//
// Two domain rules pinned here:
//   1. Only the **prod** environment honours the system marker - a dev-
//      environment CLI on a host that also has a prod apt install present
//      must NOT synthesize a manifest with `source: "apt"` for the
//      dev environment (the marker was written by the prod packaging).
//   2. The fallback is Linux-only; macOS/Windows reads always return
//      null when no per-user manifest exists.

let sandboxRoot = "";

// Pin every environment-aware path helper at a sandbox under tmpdir so the
// reader probes the test workspace rather than the real ~/.traycer.
// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden would otherwise resolve
// against the REAL production `~/.traycer`, not this sandbox. Redirect the
// `os` boundary itself so `vi.importActual`'s fresh module evaluation picks
// up the sandbox (falling back to the real tmpdir, never the real home,
// before the first `beforeEach` has set `sandboxRoot`).
// `vi.mock` factories are hoisted above this file's own top-level `let
// sandboxRoot` - a direct reference hits a TDZ `ReferenceError`, so the
// live value has to live in `vi.hoisted` instead.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  type Environment = "prod" | "dev";
  const cliHomeFor = (environment: Environment | undefined): string => {
    const base = join(sandboxRoot, "cli");
    return environment === "dev" ? join(base, "dev") : base;
  };
  return {
    ...actual,
    cliHomeDir: (environment: Environment | undefined) =>
      cliHomeFor(environment),
    cliManifestPath: (environment: Environment) =>
      join(cliHomeFor(environment), "manifest.json"),
    ensureCliHomeDir: async (environment: Environment | undefined) => {
      mkdirSync(cliHomeFor(environment), { recursive: true });
    },
  };
});

// Imports must come AFTER vi.mock so the mocked store/paths is in
// place when cli-manifest resolves its dependencies.
import {
  __setSystemSourceMarkerDirForTest,
  readCliManifest,
} from "../cli-manifest";

interface MarkerContent {
  readonly binaryPath: string;
  readonly version: string;
}

function writeSystemMarker(
  dir: string,
  packageManager: "apt" | "rpm",
  contents: MarkerContent,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `source.${packageManager}`),
    JSON.stringify(contents),
    "utf8",
  );
}

describe("readCliManifest - system-marker fallback (Linux .deb / .rpm)", () => {
  let markerDir: string;
  let previousMarkerDir: string;

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-cli-marker-test-"));
    osHome.current = sandboxRoot;
    markerDir = join(sandboxRoot, "var-lib-traycer");
    previousMarkerDir = __setSystemSourceMarkerDirForTest(markerDir);
  });

  afterEach(() => {
    __setSystemSourceMarkerDirForTest(previousMarkerDir);
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  // The fallback path itself is Linux-only - Darwin/Windows return
  // null without touching the filesystem. We assert the platform-skip
  // branch by short-circuiting `process.platform` for the duration of
  // the test rather than relying on the host runner's OS.
  function withPlatform<T>(
    platform: NodeJS.Platform,
    fn: () => Promise<T>,
  ): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    return fn().finally(() => {
      if (descriptor !== undefined) {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
  }

  it("Linux + prod environment + apt marker present: synthesises an 'apt' manifest", async () => {
    writeSystemMarker(markerDir, "apt", {
      binaryPath: "/usr/bin/traycer",
      version: "1.5.0",
    });
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result).not.toBeNull();
    expect(result?.source).toBe("apt");
    expect(result?.binaryPath).toBe("/usr/bin/traycer");
    expect(result?.version).toBe("1.5.0");
    expect(result?.pendingUpgrade).toBeNull();
    // The synthesised manifest uses the epoch installedAt because we
    // don't know when the package install happened; downstream
    // consumers shouldn't treat it as a fresh-install timestamp.
    expect(result?.installedAt).toBe(new Date(0).toISOString());
  });

  it("Linux + prod environment + rpm marker present: synthesises an 'rpm' manifest", async () => {
    writeSystemMarker(markerDir, "rpm", {
      binaryPath: "/usr/bin/traycer",
      version: "1.5.0-rpm",
    });
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result?.source).toBe("rpm");
    expect(result?.version).toBe("1.5.0-rpm");
  });

  it("Linux + dev environment + apt marker present: returns null (environment-aware gate)", async () => {
    // The system marker is written by the prod packaging only. A
    // dev-environment read must NOT inherit the prod apt source - that
    // would mis-attribute the dev install to dpkg/rpm and lock the
    // user out of `cli upgrade --environment dev`.
    writeSystemMarker(markerDir, "apt", {
      binaryPath: "/usr/bin/traycer",
      version: "1.5.0",
    });
    const result = await withPlatform("linux", () => readCliManifest("dev"));
    expect(result).toBeNull();
  });

  it("Linux + prod environment + no marker present: returns null", async () => {
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result).toBeNull();
  });

  it("npm distribution stamp synthesises an npm-owned manifest when no per-user manifest exists", async () => {
    const previousDistribution = process.env.TRAYCER_CLI_DISTRIBUTION;
    const previousVersion = process.env.TRAYCER_CLI_VERSION;
    const previousArgv1 = process.argv[1];
    process.env.TRAYCER_CLI_DISTRIBUTION = "npm";
    process.env.TRAYCER_CLI_VERSION = "1.2.3";
    process.argv[1] = "/usr/local/bin/traycer";
    try {
      const result = await readCliManifest("production");
      expect(result).toMatchObject({
        source: "npm",
        version: "1.2.3",
        binaryPath: "/usr/local/bin/traycer",
        pendingUpgrade: null,
      });
    } finally {
      if (previousDistribution === undefined) {
        delete process.env.TRAYCER_CLI_DISTRIBUTION;
      } else {
        process.env.TRAYCER_CLI_DISTRIBUTION = previousDistribution;
      }
      if (previousVersion === undefined) {
        delete process.env.TRAYCER_CLI_VERSION;
      } else {
        process.env.TRAYCER_CLI_VERSION = previousVersion;
      }
      process.argv[1] = previousArgv1;
    }
  });

  it("Darwin + prod environment + marker present: returns null (Linux-only fallback)", async () => {
    writeSystemMarker(markerDir, "apt", {
      binaryPath: "/usr/bin/traycer",
      version: "1.5.0",
    });
    const result = await withPlatform("darwin", () =>
      readCliManifest("production"),
    );
    expect(result).toBeNull();
  });

  it("Windows + prod environment + marker present: returns null (Linux-only fallback)", async () => {
    writeSystemMarker(markerDir, "apt", {
      binaryPath: "/usr/bin/traycer",
      version: "1.5.0",
    });
    const result = await withPlatform("win32", () =>
      readCliManifest("production"),
    );
    expect(result).toBeNull();
  });

  it("Linux + prod environment + marker with missing version field: returns null (best-effort parse)", async () => {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, "source.apt"),
      JSON.stringify({ binaryPath: "/usr/bin/traycer" }),
      "utf8",
    );
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result).toBeNull();
  });

  it("Linux + prod environment + marker with invalid JSON: returns null without throwing", async () => {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "source.apt"), "not-json-{", "utf8");
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result).toBeNull();
  });

  it("Per-user manifest takes precedence over the system marker on prod", async () => {
    // When the user's manifest file IS present, the system marker is
    // never consulted - the in-home manifest is authoritative for
    // version/source. Seed both and assert the in-home wins.
    writeSystemMarker(markerDir, "apt", {
      binaryPath: "/usr/bin/traycer",
      version: "0.0.1-apt",
    });
    const cliDir = join(sandboxRoot, "cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify({
        version: "2.0.0",
        installedAt: "2026-05-15T00:00:00.000Z",
        binaryPath: "/usr/local/bin/traycer",
        source: "manual",
        pendingUpgrade: null,
      }),
      "utf8",
    );
    const result = await withPlatform("linux", () =>
      readCliManifest("production"),
    );
    expect(result?.source).toBe("manual");
    expect(result?.version).toBe("2.0.0");
    expect(result?.binaryPath).toBe("/usr/local/bin/traycer");
  });
});
