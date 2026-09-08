import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The FINAL hold model: set-only-on-downgrade + reset-on-uninstall, now bound
// to the install INSTANCE (`installId`), not merely the version - a later
// reinstall of the same version writes a fresh `installId` and so cannot
// inherit a stale hold. A forward/equal/first-install move writes NOTHING -
// the gate deactivates the hold purely via `held.installId === installed`,
// no delete on a move, so there is no clear/ABA/TOCTOU race. The record is
// removed in exactly one place (`resetHeldHostVersion`, uninstall) and
// otherwise only ever OVERWRITTEN by a later downgrade. Same real-filesystem,
// mocked-`node:os.homedir()` isolation `host-free-port-lock.test.ts` uses for
// genuine CLI host-home I/O - `store/paths` captures `homedir()` once at
// module load, and mutating `process.env.HOME` alone is not trustworthy
// under `bun --bun` (see that suite's comment, commit 96fc9f47), so the
// sandbox has to win via the mock and modules have to be re-imported fresh
// per test to pick it up.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-held-host-version-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
});

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
  rmSync(workHome, { recursive: true, force: true });
});

describe("setHeldHostVersion", () => {
  it("writes a record readHostHeldVersion can read back", async () => {
    const { setHeldHostVersion } = await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await setHeldHostVersion("production", "1.2.0", "install-a");

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.2.0",
      installId: "install-a",
    });
  });

  it("replaces a prior hold (overwrite, not merge)", async () => {
    const { setHeldHostVersion } = await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await setHeldHostVersion("production", "1.2.0", "install-a");
    await setHeldHostVersion("production", "1.1.0", "install-b");

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.1.0",
      installId: "install-b",
    });
  });

  it("writes the record atomically, leaving no .tmp- sibling behind", async () => {
    const { setHeldHostVersion } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");
    const { readdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    await setHeldHostVersion("production", "1.2.0", "install-a");

    const dir = dirname(hostHeldVersionRecordPath("production"));
    const leftoverTmp = readdirSync(dir).filter((name) =>
      name.includes(".tmp-"),
    );
    expect(leftoverTmp).toEqual([]);
    const raw = readFileSync(hostHeldVersionRecordPath("production"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: "1.2.0",
      installId: "install-a",
    });
  });
});

describe("resetHeldHostVersion", () => {
  it("removes an existing record unconditionally", async () => {
    const { setHeldHostVersion, resetHeldHostVersion } =
      await import("../held-host-version");
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await setHeldHostVersion("production", "1.2.0", "install-a");
    await resetHeldHostVersion("production");

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });

  it("is a no-op (never throws) when nothing is held", async () => {
    const { resetHeldHostVersion } = await import("../held-host-version");

    await expect(resetHeldHostVersion("production")).resolves.toBeUndefined();
  });
});

describe("readHostHeldVersion: tolerant reader", () => {
  it("returns null when the record file is missing", async () => {
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });

  it("returns null for malformed JSON on disk", async () => {
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    const path = hostHeldVersionRecordPath("production");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");

    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });

  it("returns null when `version` is missing from an otherwise-valid JSON object", async () => {
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    const path = hostHeldVersionRecordPath("production");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ notVersion: "1.2.0", installId: "install-a" }),
      "utf8",
    );

    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });

  // installId-binding: a record missing `installId` (a legacy/pre-binding
  // record, or a hand-edited one) cannot be matched against any install and
  // so must read as "nothing held" - never fall back to a version-only match.
  it("returns null when `installId` is missing from an otherwise-valid JSON object", async () => {
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    const path = hostHeldVersionRecordPath("production");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: "1.2.0" }), "utf8");

    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });
});

describe("holdVersionIfDowngrade", () => {
  it("strict-below with a non-null installId sets the hold to {version, installId}", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade("production", "1.5.0", "1.2.0", "install-a");

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.2.0",
      installId: "install-a",
    });
  });

  it("strict-below overwrites a different prior hold with the new (older) target", async () => {
    const { setHeldHostVersion, holdVersionIfDowngrade } =
      await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    await setHeldHostVersion("production", "1.0.0", "install-old");

    await holdVersionIfDowngrade("production", "1.5.0", "1.2.0", "install-a");

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.2.0",
      installId: "install-a",
    });
  });

  // A null `committedInstallId` (legacy record with no per-install identity)
  // cannot be bound to an instance and so must never be held, even on a
  // genuine strict downgrade.
  it("strict-below with a null committedInstallId writes nothing", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade("production", "1.5.0", "1.2.0", null);

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });

  it("a forward move writes nothing (no hold to clear, none created)", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade("production", "1.2.0", "1.5.0", "install-a");

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
    await expect(readHostHeldVersion("production")).resolves.toBeNull();
  });

  // The write-once/never-delete design leans on this: a forward move must
  // NEVER touch an existing record (even one from an unrelated concurrent
  // downgrade) - it deactivates the hold purely through `held.installId !==
  // installed` at the gate, never by writing here.
  it("a forward move leaves an existing (unrelated) hold record completely untouched", async () => {
    const { setHeldHostVersion, holdVersionIfDowngrade } =
      await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    await setHeldHostVersion("production", "1.0.0", "install-old");

    await holdVersionIfDowngrade("production", "1.2.0", "1.5.0", "install-a");

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.0.0",
      installId: "install-old",
    });
  });

  it("equal target/previous writes nothing", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade("production", "1.2.0", "1.2.0", "install-a");

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });

  it("incomparable versions (unordered build stamps) write nothing", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade(
      "production",
      "staging.1788780730120.1d4be2fe71",
      "staging.1788780730999.aa11bb22cc",
      "install-a",
    );

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });

  it("a first install (previousVersion null) writes nothing", async () => {
    const { holdVersionIfDowngrade } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");

    await holdVersionIfDowngrade("production", null, "1.2.0", "install-a");

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });
});

// T6-safe write site: the committer fires this observer right after the
// atomic swap (before the throwing post-swap lifecycle hook), so a caller
// never calls `holdVersionIfDowngrade` itself after the commit returns. This
// exercises the exact closure `commitInstallFromSource` invokes with
// `{ record, previous }`.
describe("holdVersionOnSwapCommitted", () => {
  function sampleRecord(version: string, installId: string) {
    return {
      installId,
      version,
      runtimeVersion: null,
      platform: "darwin" as const,
      arch: "arm64" as const,
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry" as const, value: version },
      archiveSha256: "a".repeat(64),
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1,
      executablePath: "/tmp/traycer-host",
      executableSha256: null,
    };
  }

  it("writes the hold for a strict downgrade", async () => {
    const { holdVersionOnSwapCommitted } = await import("../held-host-version");
    const { readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    const observer = holdVersionOnSwapCommitted("production");

    await observer({
      record: sampleRecord("1.2.0", "install-new"),
      previous: sampleRecord("1.5.0", "install-old"),
    });

    await expect(readHostHeldVersion("production")).resolves.toEqual({
      version: "1.2.0",
      installId: "install-new",
    });
  });

  it("writes nothing for a forward move", async () => {
    const { holdVersionOnSwapCommitted } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");
    const observer = holdVersionOnSwapCommitted("production");

    await observer({
      record: sampleRecord("1.5.0", "install-new"),
      previous: sampleRecord("1.2.0", "install-old"),
    });

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });

  it("writes nothing for an equal-precedence move (a first install, previous null)", async () => {
    const { holdVersionOnSwapCommitted } = await import("../held-host-version");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");
    const observer = holdVersionOnSwapCommitted("production");

    await observer({
      record: sampleRecord("1.2.0", "install-new"),
      previous: null,
    });

    expect(existsSync(hostHeldVersionRecordPath("production"))).toBe(false);
  });
});
