import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import type { Environment } from "../../runner/environment";
import type { HostPidMetadata, HostPidMetadataEvidence } from "../pid-metadata";
import { singleChatStoreSurveyRoot } from "../chat-store-survey-roots";
import type { SwapQuiescence } from "../swap-quiescence";

const mocks = vi.hoisted(() => ({
  readHostPidMetadataEvidenceMock: vi.fn(),
  readHostHolderEvidenceMock: vi.fn(),
  macosServiceMayRespawnMock: vi.fn(),
  linuxServiceMayRespawnMock: vi.fn(),
}));

// The holder record is read for every surveyed root, so it is sandboxed for
// the same reason the pid read is: left real, it touches the operator's own
// `~/.traycer` AND puts filesystem I/O inside the fake-timer window, where it
// desynchronizes the settle-loop choreography. Absent by default - the state
// of a machine whose roots nobody holds.
vi.mock("../holder-record", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../holder-record")>();
  return {
    ...actual,
    readHostHolderEvidenceAt: mocks.readHostHolderEvidenceMock,
  };
});

// The observer reads every record by PATH (`readHostPidMetadataEvidenceAt`),
// so one mock serves the single-root tests, which never look at the path,
// and the dev-slot tests, which answer per path.
vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadataEvidenceAt: mocks.readHostPidMetadataEvidenceMock,
  };
});

// The dev-slot walk resolves `host/dev-runs`, the unslotted `host/dev` home
// and this process's own pid path through `store/paths` - genuine filesystem
// I/O against the operator's real `~/.traycer` if left unmocked. While a
// sandbox is set, the three resolve under it; otherwise they are the real
// functions, which the single-root tests only ever use for path arithmetic.
const sandbox = vi.hoisted(() => ({
  root: null as string | null,
  // Path to make `readdir` reject with EACCES for - `null` lets every call
  // through to the real filesystem.
  readdirEaccesForPath: null as string | null,
}));
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  const { join } = await import("node:path");
  return {
    ...actual,
    hostPidMetadataPath: (environment: Environment | undefined) =>
      sandbox.root === null
        ? actual.hostPidMetadataPath(environment)
        : join(sandbox.root, "host", "dev-runs", "slot-a", "pid.json"),
    hostDevHomeDir: () =>
      sandbox.root === null
        ? actual.hostDevHomeDir()
        : join(sandbox.root, "host", "dev"),
    hostDevRunsRoot: () =>
      sandbox.root === null
        ? actual.hostDevRunsRoot()
        : join(sandbox.root, "host", "dev-runs"),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (
      path: Parameters<typeof actual.readdir>[0],
      options: Parameters<typeof actual.readdir>[1],
    ) => {
      if (path === sandbox.readdirEaccesForPath) {
        throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
      }
      return actual.readdir(path, options);
    },
  };
});

// `serviceManagerMayRespawn` shells out for real (`launchctl print` /
// `systemctl --user is-active`) - left unmocked, every test that reaches the
// "no process right now" arms spawns a genuine subprocess and is green only
// by accident of what happens to be loaded/registered on the machine running
// the suite. Same class as an earlier round's unmocked network yank-lookup.
vi.mock("../../service/platforms/macos", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/macos")>();
  return {
    ...actual,
    macosServiceMayRespawn: mocks.macosServiceMayRespawnMock,
  };
});
vi.mock("../../service/platforms/linux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/linux")>();
  return {
    ...actual,
    linuxServiceMayRespawn: mocks.linuxServiceMayRespawnMock,
  };
});

// Default to "will not respawn" so the pre-existing tests below - none of
// which care about this arm - keep clearing exactly as before, without ever
// touching the real platform probes.
mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
mocks.linuxServiceMayRespawnMock.mockResolvedValue(false);
mocks.readHostHolderEvidenceMock.mockResolvedValue({ kind: "absent" });

const { observeSwapQuiescence, SERVICE_SETTLE_TIMEOUT_MS } =
  await import("../swap-quiescence");

async function withPlatform<T>(
  platform: string,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (original === undefined) {
    throw new Error("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

interface RecordedCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields;
}

function fakeLogger(): ILogger & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    debug: (message, fields) => {
      calls.push({ level: "debug", message, fields });
    },
    info: (message, fields) => {
      calls.push({ level: "info", message, fields });
    },
    warn: (message, fields) => {
      calls.push({ level: "warn", message, fields });
    },
    error: (message, fields) => {
      calls.push({ level: "error", message, fields });
    },
  };
}

function samplePidMetadata(
  overrides: Partial<HostPidMetadata>,
): HostPidMetadata {
  return {
    pid: 4242,
    hostId: "host-abc",
    version: "1.2.4",
    websocketUrl: "ws://127.0.0.1:1234",
    startedAt: "2026-05-15T00:00:00.000Z",
    processStartIdentity: null,
    processStartIdentityRead: "absent",
    layer0: null,
    layer0Slot: null,
    ...overrides,
  };
}

const ENVIRONMENT: Environment = "production";

// A pid essentially guaranteed not to be a live process on any platform this
// suite runs on - `publishedHostProcessGone`'s liveness check is real, not
// mocked, so the metadata fixture itself has to be the thing that decides
// "gone" vs. "still running".
const DEFINITELY_DEAD_PID = 999_999_999;

// The settle budget is read from the monotonic clock, which vitest does not
// fake by default - a suite that faked only `Date` and the timers would run
// the loop against real elapsed time and never reach its deadline.
const FAKED_TIMERS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "Date",
  "performance",
] as const;

/**
 * Drive `observeSwapQuiescence` under fake timers past the whole settle
 * window. The manager mocks answer per call, so a probe that keeps saying
 * "may respawn" spends the window and one that flips settles at its next poll.
 */
async function observeThroughSettleWindow(
  logger: ILogger,
): Promise<SwapQuiescence> {
  const pending = observeSwapQuiescence(
    ENVIRONMENT,
    singleChatStoreSurveyRoot("/tmp/host-home"),
    logger,
  );
  await vi.advanceTimersByTimeAsync(SERVICE_SETTLE_TIMEOUT_MS + 1_000);
  return await pending;
}

describe("observeSwapQuiescence", () => {
  it("is established when no host has ever published pid.json (kind: absent)", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "absent",
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        singleChatStoreSurveyRoot("/tmp/host-home"),
        logger,
      ),
    ).resolves.toEqual({
      established: true,
    });
  });

  it("is NOT established, with reason writer-unknown and a warn, when pid.json could not be read", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "unreadable",
      cause: "simulated EACCES",
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        singleChatStoreSurveyRoot("/tmp/host-home"),
        logger,
      ),
    ).resolves.toEqual({
      established: false,
      reason: "writer-unknown",
    });

    const warnCall = logger.calls.find((call) => call.level === "warn");
    expect(warnCall).toBeDefined();
    expect(warnCall?.message).toContain("could not be read");
  });

  it("is established when the published host process is provably gone", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "read",
      metadata: samplePidMetadata({ pid: DEFINITELY_DEAD_PID }),
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        singleChatStoreSurveyRoot("/tmp/host-home"),
        logger,
      ),
    ).resolves.toEqual({
      established: true,
    });
  });

  it("is NOT established, with reason writer-still-running, when the published host process is still alive", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "read",
      // This test process's own pid - guaranteed alive for the duration of
      // the test, with no start-identity stamp to compare (so
      // `publishedHostProcessGone` falls to its liveness-only answer).
      metadata: samplePidMetadata({ pid: process.pid }),
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        singleChatStoreSurveyRoot("/tmp/host-home"),
        logger,
      ),
    ).resolves.toEqual({
      established: false,
      reason: "writer-still-running",
    });
  });

  it("is NOT established, with reason unseen-writers, when a NON-dev survey spans more than one root - and never even consults the pid record", async () => {
    // Only the dev survey unions roots (`resolveChatStoreSurveyRoots`), and
    // only dev hosts publish into enumerable run slots. A multi-root survey
    // under any other environment is outside the observer's model of who
    // writes what, so it refuses rather than guesses. This check has to run
    // BEFORE any pid read - asserting the mock's call count is what proves
    // the ordering rather than just the result. Cleared first since this
    // file has no shared `beforeEach` and earlier tests left calls on the
    // same mock.
    mocks.readHostPidMetadataEvidenceMock.mockClear();
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        {
          roots: [
            { path: "/tmp/host-home", label: "host" },
            { path: "/tmp/identity-a", label: "identity-a" },
          ],
          enumerationFailed: false,
        },
        logger,
      ),
    ).resolves.toEqual({ established: false, reason: "unseen-writers" });

    expect(mocks.readHostPidMetadataEvidenceMock).not.toHaveBeenCalled();
  });

  describe("a dev survey spanning more than one root walks every run slot's pid record", () => {
    // `pid.json` is SLOT-scoped while the chat stores are IDENTITY-scoped.
    // A pooled identity home carries no pid record at all; the host holding
    // it publishes into the run slot it was started in - `host/dev-runs/
    // <slot>`, or the unslotted `host/dev` home. So the records that can
    // vouch for every surveyed root are exactly those, and the observer
    // reads each of them instead of refusing on the root count. It also reads
    // each SURVEYED root's own pid path - normally ENOENT, since an identity
    // home carries no record - so that premise is checked rather than assumed.
    const DEV_ROOTS = {
      roots: [
        { path: "/tmp/dev-runs/slot-a", label: "host" },
        { path: "/tmp/dev/identities/identity-a", label: "identity-a" },
      ],
      enumerationFailed: false,
    };
    /** The surveyed roots' own pid paths, which every walk below also reads. */
    const SURVEYED_ROOT_RECORDS = DEV_ROOTS.roots.map((entry) =>
      join(entry.path, "pid.json"),
    );
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "swap-quiescence-dev-slots-"));
      sandbox.root = root;
      sandbox.readdirEaccesForPath = null;
      mocks.readHostPidMetadataEvidenceMock.mockReset();
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      // Reset alongside the pid mock, or the per-path assertions below inherit
      // the previous test's calls - this describe reads BOTH kinds of record.
      mocks.readHostHolderEvidenceMock.mockReset();
      mocks.readHostHolderEvidenceMock.mockResolvedValue({ kind: "absent" });
      // And the service probe, for the same reason twice over: tests here
      // assert WHICH labels were probed, and some install an implementation
      // that must not outlive them. Restored to the file-level default, so a
      // later describe still starts from "will not respawn".
      mocks.macosServiceMayRespawnMock.mockReset();
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
    });
    afterEach(async () => {
      sandbox.root = null;
      sandbox.readdirEaccesForPath = null;
      await rm(root, { recursive: true, force: true });
    });

    function recordPath(...segments: string[]): string {
      return join(root, "host", ...segments, "pid.json");
    }
    function readPaths(): string[] {
      return mocks.readHostPidMetadataEvidenceMock.mock.calls.map(
        (call) => call[0] as string,
      );
    }
    /**
     * The DISTINCT records consulted. The walk runs twice on a clearing pass -
     * once up front, once after the service probes, which are subprocess calls
     * a host could publish during - so the raw call list has every path twice.
     */
    function distinctReadPaths(): string[] {
      return [...new Set(readPaths())].sort();
    }
    function holderPaths(): string[] {
      return [
        ...new Set(
          mocks.readHostHolderEvidenceMock.mock.calls.map(
            (call) => call[0] as string,
          ),
        ),
      ].sort();
    }

    it("reads the unslotted dev home's record and every dev-runs slot's, and is established when each is absent", async () => {
      await mkdir(join(root, "host", "dev-runs", "slot-a"), {
        recursive: true,
      });
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });
      // A stray file under `dev-runs` is not a slot and is skipped - the
      // same rule the identity pool applies to a `.DS_Store`.
      await writeFile(join(root, "host", "dev-runs", ".DS_Store"), "", "utf8");
      await mkdir(join(root, "host", "dev"), { recursive: true });

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({ established: true });

      // The pid records are the SLOT homes: this process's, the unslotted dev
      // home's, and every `dev-runs` slot's. Surveyed roots are covered by
      // their holder records instead - a pooled identity home never gets a
      // pid.json at all.
      expect(distinctReadPaths()).toEqual(
        [
          recordPath("dev"),
          recordPath("dev-runs", "slot-a"),
          recordPath("dev-runs", "slot-b"),
        ].sort(),
      );
      expect(holderPaths()).toEqual(
        [
          ...DEV_ROOTS.roots.map((entry) => join(entry.path, "holder.json")),
          join(root, "host", "dev-runs", "slot-a", "holder.json"),
          join(root, "host", "dev-runs", "slot-b", "holder.json"),
        ].sort(),
      );
    });

    it("still reads its own slot's record and the unslotted home's when dev-runs does not exist", async () => {
      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({ established: true });
      expect(distinctReadPaths()).toEqual(
        [recordPath("dev"), recordPath("dev-runs", "slot-a")].sort(),
      );
    });

    it("is NOT established, with reason writer-still-running, when ANOTHER slot's record names a live process", async () => {
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });
      mocks.readHostPidMetadataEvidenceMock.mockImplementation(
        async (path: string) =>
          path === recordPath("dev-runs", "slot-b")
            ? {
                kind: "read",
                // This very process: alive, and with no start identity on
                // record it cannot be proven to be an impostor.
                metadata: samplePidMetadata({ pid: process.pid }),
              }
            : { kind: "absent" },
      );

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({
        established: false,
        reason: "writer-still-running",
      });
    });

    it("is NOT established, with reason writer-unknown, when another slot's record cannot be read", async () => {
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });
      mocks.readHostPidMetadataEvidenceMock.mockImplementation(
        async (path: string) =>
          path === recordPath("dev-runs", "slot-b")
            ? { kind: "unreadable", cause: "not valid JSON" }
            : { kind: "absent" },
      );

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({ established: false, reason: "writer-unknown" });
    });

    it("is NOT established when a SURVEYED ROOT's holder record names a live process, whatever slot launched it", async () => {
      // The finding this closes: a host may be started with any
      // `--host-data-dir` beneath `~/.traycer/host` and then acquire a pooled
      // identity, so its pid lands in a home no enumeration can be sure to
      // list - while the identity home it writes gets no pid.json at all. The
      // holder record sits in the root itself, so it answers regardless.
      const identityRoot = DEV_ROOTS.roots[1]?.path ?? "";
      mocks.readHostHolderEvidenceMock.mockImplementation(
        async (path: string) =>
          path === join(identityRoot, "holder.json")
            ? {
                kind: "read",
                holder: { pid: process.pid, processStartIdentity: null },
              }
            : { kind: "absent" },
      );

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({
        established: false,
        reason: "writer-still-running",
      });
    });

    it("is NOT established, with reason writer-unknown, when a surveyed root's holder record cannot be read", async () => {
      mocks.readHostHolderEvidenceMock.mockResolvedValue({
        kind: "unreadable",
        cause: "not valid JSON",
      });

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({ established: false, reason: "writer-unknown" });
    });

    it("probes EVERY enumerated slot's service job, not just this process's label", async () => {
      // The other half of the same finding: the pid walk covered slot B while
      // the settle probe only ever asked about slot A's label, so a sibling
      // job inside its relaunch window cleared the swap.
      //
      // Both slots are created HERE rather than leaned on from the first test
      // in this describe: that one runs unwrapped, so it reaches the macOS
      // probe only on a macOS developer's machine, and this assertion passed
      // on darwin off its leaked calls while failing on CI's Linux. The
      // `beforeEach` reset makes the set below this test's OWN probes, and
      // creating both slots makes every label it asserts one it actually put
      // on disk - the own label is `serviceLabelFor`'s, which reads an ambient
      // `DEV_DESKTOP_SLOT` this suite must not inherit an answer from.
      await mkdir(join(root, "host", "dev-runs", "slot-a"), {
        recursive: true,
      });
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });

      await withPlatform("darwin", async () => {
        await expect(
          observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
        ).resolves.toEqual({ established: true });
      });

      const probed = new Set(
        mocks.macosServiceMayRespawnMock.mock.calls.map(
          (call) => (call[0] as { id: string }).id,
        ),
      );
      expect(probed).toContain("ai.traycer.host.dev.slot-a");
      expect(probed).toContain("ai.traycer.host.dev.slot-b");
      expect(probed).toContain("ai.traycer.host.dev");
    });

    it("does NOT clear when a run slot appears while the service manager is being probed - its records are re-read, but its job never was", async () => {
      // The backstop for the finding above, along the TIME axis. The probes
      // are subprocess calls; a slot created while they run is named by the
      // re-resolution that follows them, and clearing on that re-read would
      // clear on a job nothing ever asked about - exactly the writer this wait
      // exists to catch.
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });
      mocks.macosServiceMayRespawnMock.mockImplementation(async () => {
        await mkdir(join(root, "host", "dev-runs", "slot-c"), {
          recursive: true,
        });
        return false;
      });

      await withPlatform("darwin", async () => {
        await expect(
          observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
        ).resolves.toEqual({ established: false, reason: "unseen-writers" });
      });

      const probed = new Set(
        mocks.macosServiceMayRespawnMock.mock.calls.map(
          (call) => (call[0] as { id: string }).id,
        ),
      );
      expect(probed).not.toContain("ai.traycer.host.dev.slot-c");
    });

    it("probes a run slot that appears DURING the settle wait, and clears once its job is proven too", async () => {
      // The other side of the same coin: the label set is re-resolved after
      // every sleep, so a slot created mid-wait is probed by the next round
      // rather than only noticed by the final re-read. Without that the swap
      // could never clear while a slot appeared - the backstop above would
      // refuse forever - so this is the half that keeps the wait USEFUL.
      await mkdir(join(root, "host", "dev-runs", "slot-b"), {
        recursive: true,
      });
      // REAL timers, and so one real 500 ms poll: the loop's re-resolution is
      // a `readdir` of the temp root, and faking timers around real filesystem
      // work is how an earlier round of this suite deadlocked. One sleep is
      // cheaper than that class of flake.
      let round = 0;
      mocks.macosServiceMayRespawnMock.mockImplementation(async () => {
        round += 1;
        if (round > 1) return false;
        // Busy on the first round only, and the slot lands while it is busy.
        await mkdir(join(root, "host", "dev-runs", "slot-c"), {
          recursive: true,
        });
        return true;
      });

      await withPlatform("darwin", async () => {
        await expect(
          observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
        ).resolves.toEqual({ established: true });
      });

      const probed = new Set(
        mocks.macosServiceMayRespawnMock.mock.calls.map(
          (call) => (call[0] as { id: string }).id,
        ),
      );
      expect(probed).toContain("ai.traycer.host.dev.slot-c");
    });

    it("is NOT established, with reason unseen-writers, when dev-runs cannot be read - and consults no record", async () => {
      await mkdir(join(root, "host", "dev-runs"), { recursive: true });
      sandbox.readdirEaccesForPath = join(root, "host", "dev-runs");

      await expect(
        observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
      ).resolves.toEqual({ established: false, reason: "unseen-writers" });
      expect(mocks.readHostPidMetadataEvidenceMock).not.toHaveBeenCalled();
    });

    // `symlink()` is EPERM for a Windows developer without the create-
    // symbolic-link privilege - see `chat-store-survey.test.ts`'s same guard.
    it.skipIf(process.platform === "win32")(
      "is NOT established, with reason unseen-writers, when a dev-runs entry is a symlink - followed it could leave the slots, ignored it could hide one",
      async () => {
        await mkdir(join(root, "host", "dev-runs", "slot-b"), {
          recursive: true,
        });
        await symlink(
          join(root, "host", "dev-runs", "slot-b"),
          join(root, "host", "dev-runs", "slot-link"),
        );

        await expect(
          observeSwapQuiescence("dev", DEV_ROOTS, fakeLogger()),
        ).resolves.toEqual({ established: false, reason: "unseen-writers" });
        expect(mocks.readHostPidMetadataEvidenceMock).not.toHaveBeenCalled();
      },
    );
  });

  it("is NOT established, with reason unseen-writers, for a SINGLE root that failed to ENUMERATE - and never even consults the pid record", async () => {
    // A different shape than the multi-root case above: `roots.length` alone
    // used to gate this, so `{roots: [one], enumerationFailed: true}` fell
    // through to the pid read and could clear. `enumerationFailed` now
    // triggers this arm on its own.
    //
    // The survey itself turns an unreadable enumeration into its own `*`
    // failure, so on every path that actually consults this today the
    // outcome would have refused anyway - this fix changes no observable
    // behavior right now. It exists so quiescence answers HONESTLY as a
    // standalone question ("I could not enumerate the roots" is not evidence
    // that nothing is writing them), not because today's outcome would
    // differ. Do not read the unchanged outcome as this being redundant.
    mocks.readHostPidMetadataEvidenceMock.mockClear();
    const logger = fakeLogger();

    await expect(
      observeSwapQuiescence(
        ENVIRONMENT,
        {
          roots: [{ path: "/tmp/host-home", label: "host" }],
          enumerationFailed: true,
        },
        logger,
      ),
    ).resolves.toEqual({ established: false, reason: "unseen-writers" });

    expect(mocks.readHostPidMetadataEvidenceMock).not.toHaveBeenCalled();
  });

  describe("service-may-respawn (the throttle-window gap)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    });
    afterEach(() => {
      vi.useRealTimers();
      // Restore the "will not respawn" default so a test order change
      // elsewhere in this file can't inherit a `true` left behind here.
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
      mocks.linuxServiceMayRespawnMock.mockResolvedValue(false);
    });

    it("is NOT established, reason service-may-respawn, when pid.json is absent and the service manager keeps holding a job past the settle window", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        await expect(observeThroughSettleWindow(logger)).resolves.toEqual({
          established: false,
          reason: "service-may-respawn",
        });
      });
    });

    it("is NOT established, reason service-may-respawn, when the published process is provably gone but the service manager keeps holding a job", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "read",
        metadata: samplePidMetadata({ pid: DEFINITELY_DEAD_PID }),
      } satisfies HostPidMetadataEvidence);
      mocks.linuxServiceMayRespawnMock.mockResolvedValue(true);
      const logger = fakeLogger();

      await withPlatform("linux", async () => {
        await expect(observeThroughSettleWindow(logger)).resolves.toEqual({
          established: false,
          reason: "service-may-respawn",
        });
      });
    });

    it("still clears a provably-gone process when the service manager says it will NOT respawn - the deliberate-stop flow", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "read",
        metadata: samplePidMetadata({ pid: DEFINITELY_DEAD_PID }),
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        await expect(
          observeSwapQuiescence(
            ENVIRONMENT,
            singleChatStoreSurveyRoot("/tmp/host-home"),
            logger,
          ),
        ).resolves.toEqual({ established: true });
      });
    });

    it("a LIVE pid short-circuits to writer-still-running without ever consulting the respawn probe", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "read",
        metadata: samplePidMetadata({ pid: process.pid }),
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockClear();
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        await expect(
          observeSwapQuiescence(
            ENVIRONMENT,
            singleChatStoreSurveyRoot("/tmp/host-home"),
            logger,
          ),
        ).resolves.toEqual({
          established: false,
          reason: "writer-still-running",
        });
      });

      // The pid answer is the more specific one - it short-circuits before
      // the respawn probe is ever asked.
      expect(mocks.macosServiceMayRespawnMock).not.toHaveBeenCalled();
    });

    it("on Windows, never consults the respawn probe - no crash-restart policy there - and clears", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockClear();
      mocks.linuxServiceMayRespawnMock.mockClear();
      const logger = fakeLogger();

      await withPlatform("win32", async () => {
        await expect(
          observeSwapQuiescence(
            ENVIRONMENT,
            singleChatStoreSurveyRoot("/tmp/host-home"),
            logger,
          ),
        ).resolves.toEqual({ established: true });
      });

      expect(mocks.macosServiceMayRespawnMock).not.toHaveBeenCalled();
      expect(mocks.linuxServiceMayRespawnMock).not.toHaveBeenCalled();
    });
  });

  describe("the ordinary running-host downgrade (waiting for the service manager to settle)", () => {
    // `beforeSwap` stops the host CHILD, the clean stop purges `pid.json`,
    // and `stopService` returns while launchd/systemd still consider the
    // SUPERVISOR running (it outlives its child by the whole post-mortem).
    // Read once, that live supervisor would refuse the headline Settings >
    // Update-now downgrade by its own stop. It is not exempted - nothing
    // here can tell it from a supervisor between children, or from a SECOND
    // supervisor whose child is still booting - it is waited out: a clean
    // exit is one neither manager respawns, so the job settles on its own.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    });
    afterEach(() => {
      vi.useRealTimers();
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
    });

    it("supervisor still winding down at the first probe, settled by the next poll -> quiesced, with the pid record read again after the wait", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockClear();
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        await expect(observeThroughSettleWindow(logger)).resolves.toEqual({
          established: true,
        });
      });
      // Once before the manager was asked, once after it settled: a host
      // started outside any manager during the wait would show in the second.
      expect(mocks.readHostPidMetadataEvidenceMock).toHaveBeenCalledTimes(2);
    });

    it("a manager that never held a job pays no wait at all", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockClear();
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        // No timer advance: the answer must arrive without one.
        await expect(
          observeSwapQuiescence(
            ENVIRONMENT,
            singleChatStoreSurveyRoot("/tmp/host-home"),
            logger,
          ),
        ).resolves.toEqual({ established: true });
      });
      expect(vi.getTimerCount()).toBe(0);
      // TWICE, not once: the probe is a subprocess call, so a host that
      // published while it ran is invisible to the read that preceded it.
      // This early return used to skip the re-read the post-wait path does.
      expect(mocks.readHostPidMetadataEvidenceMock).toHaveBeenCalledTimes(2);
    });

    it("a second supervisor whose child is still booting never settles -> service-may-respawn once the window is spent, and not before (the competing-registration shape)", async () => {
      // Dual CLI + Desktop registration, both children spawned before the
      // install took its lock. A published and served; B is still in
      // bootstrap with no `pid.json`. The install stops A cleanly - A's
      // record is purged, A's supervisor exits 0 - and the manager still
      // shows B's supervisor with a live pid for as long as B boots. The
      // stop this install performed says nothing about B, so no exemption
      // keyed on it may clear this; only settling would, and B does not.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockClear();
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        let settled = false;
        const pending = observeSwapQuiescence(
          ENVIRONMENT,
          singleChatStoreSurveyRoot("/tmp/host-home"),
          logger,
        ).then((answer) => {
          settled = true;
          return answer;
        });
        // Still polling one second short of the window.
        await vi.advanceTimersByTimeAsync(SERVICE_SETTLE_TIMEOUT_MS - 1_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({
          established: false,
          reason: "service-may-respawn",
        });
      });
      // Polled every 500 ms across the window, not answered from one read.
      expect(
        mocks.macosServiceMayRespawnMock.mock.calls.length,
      ).toBeGreaterThanOrEqual(SERVICE_SETTLE_TIMEOUT_MS / 500);
      const refusal = logger.calls.find(
        (call) => call.level === "info" && "waitedMs" in call.fields,
      );
      expect(refusal?.fields.waitedMs).toBeGreaterThanOrEqual(
        SERVICE_SETTLE_TIMEOUT_MS,
      );
    });

    it("a probe that hangs to its timeout cannot stretch the wait past the window - each probe is capped by the remaining budget", async () => {
      // `launchctl print` can sit for its whole 10 s timeout on a wedged
      // launchd. Without the cap the loop would spend 10 s, sleep, spend
      // another 10 s, and refuse at ~20 s while claiming a 15 s bound.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockClear();
      const probeTimeouts: number[] = [];
      mocks.macosServiceMayRespawnMock.mockImplementation(
        (_label: unknown, _runner: unknown, timeoutMs: number) => {
          probeTimeouts.push(timeoutMs);
          return new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), Math.min(10_000, timeoutMs));
          });
        },
      );
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        let settled = false;
        const pending = observeSwapQuiescence(
          ENVIRONMENT,
          singleChatStoreSurveyRoot("/tmp/host-home"),
          logger,
        ).then((answer) => {
          settled = true;
          return answer;
        });
        await vi.advanceTimersByTimeAsync(SERVICE_SETTLE_TIMEOUT_MS + 1_000);
        expect(settled).toBe(true);
        await expect(pending).resolves.toEqual({
          established: false,
          reason: "service-may-respawn",
        });
      });
      // The first probe had the full per-call allowance; the second was cut
      // to what the budget had left after it.
      expect(probeTimeouts[0]).toBe(10_000);
      expect(probeTimeouts[1] ?? Number.NaN).toBeLessThan(5_000);
      const refusal = logger.calls.find(
        (call) => call.level === "info" && "waitedMs" in call.fields,
      );
      expect(refusal?.fields.waitedMs).toBeLessThanOrEqual(
        SERVICE_SETTLE_TIMEOUT_MS + 500,
      );
    });

    it("a wall clock corrected backwards during the wait neither stretches nor shortens it", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        let settled = false;
        const pending = observeSwapQuiescence(
          ENVIRONMENT,
          singleChatStoreSurveyRoot("/tmp/host-home"),
          logger,
        ).then((answer) => {
          settled = true;
          return answer;
        });
        await vi.advanceTimersByTimeAsync(5_000);
        // Ten minutes backwards, mid-wait. The budget is monotonic, so the
        // remaining ten seconds are still ten seconds.
        vi.setSystemTime(Date.now() - 600_000);
        await vi.advanceTimersByTimeAsync(SERVICE_SETTLE_TIMEOUT_MS - 5_500);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({
          established: false,
          reason: "service-may-respawn",
        });
      });
    });

    it("a manager that settles while a host published during the wait -> writer-still-running, not quiesced", async () => {
      mocks.readHostPidMetadataEvidenceMock
        .mockResolvedValueOnce({
          kind: "absent",
        } satisfies HostPidMetadataEvidence)
        .mockResolvedValue({
          kind: "read",
          metadata: samplePidMetadata({ pid: process.pid }),
        } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);
      const logger = fakeLogger();

      await withPlatform("darwin", async () => {
        await expect(observeThroughSettleWindow(logger)).resolves.toEqual({
          established: false,
          reason: "writer-still-running",
        });
      });
    });
  });
});

describe("macosServiceMayRespawn (field parsing, real launchctl-print classification)", () => {
  // Genuine field parsing, not the module-level mock above: this describe
  // block imports the REAL function via `importActual` and drives it with a
  // fake `ProcessRunner`, so a regression in the field-parsing logic itself
  // - not merely in `observeSwapQuiescence`'s use of the boolean - fails
  // here. Real sample shapes from a live machine's `launchctl print`.
  const label = {
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production" as Environment,
    devSlot: null,
  };

  function fakeRunner(
    byTarget: (target: string) => { exitCode: number; stdout: string },
  ) {
    return async (
      _command: string,
      args: readonly string[],
      _options: unknown,
    ) => {
      const target = args[args.length - 1] ?? "";
      const { exitCode, stdout } = byTarget(target);
      return { stdout, stderr: "", exitCode };
    };
  }

  it("a throttled job (no supervisor pid, dirty last exit) may respawn", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({
        exitCode: 0,
        stdout: "\tlast exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT\n",
      })),
      10_000,
    );

    expect(respawn).toBe(true);
  });

  it("a live supervisor with a dead host CHILD may respawn - the inverted case: launchctl's pid is the supervisor, not pid.json's host", async () => {
    // Reaching this function at all means `publishedHostProcessGone` already
    // found the HOST CHILD gone (or never published). A live launchd `pid`
    // here is the SUPERVISOR sitting between children - the internal
    // crash-relaunch loop - which can spawn the next writer without launchd
    // itself being involved.
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({ exitCode: 0, stdout: "\tpid = 1234\n" })),
      10_000,
    );

    expect(respawn).toBe(true);
  });

  it("a clean-exited loaded job does not respawn", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({
        exitCode: 0,
        stdout: "\tlast exit code = 0\n",
      })),
      10_000,
    );

    expect(respawn).toBe(false);
  });

  it("a loaded job that has NEVER run may respawn - RunAtLoad is about to start it (Codex)", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({
        exitCode: 0,
        stdout: "\tlast exit code = (never exited)\n",
      })),
      10_000,
    );

    expect(respawn).toBe(true);
  });

  it("a job that is not loaded at all does not respawn", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({
        exitCode: 1,
        stdout: "Could not find service in domain for port\n",
      })),
      10_000,
    );

    expect(respawn).toBe(false);
  });

  // The two cases below are a deliberate pair: both a spawn/timeout failure
  // and launchctl's own "not loaded" answer surface as a non-zero exit code
  // from `runCommand`, and they mean the OPPOSITE thing. Collapsing them was
  // the bug: `tolerateNonZeroExit: true` resolves a spawn failure or a
  // timeout as `exitCode: -1` (`process-runner.ts` maps a non-numeric
  // `err.code` to it) - a probe that never ran - while launchctl's genuine
  // "could not find service" answer is always a POSITIVE exit code. Reading
  // the negative one as "not loaded" cleared a swap on a question that was
  // never actually asked.
  it("a probe that never ran (spawn failure or timeout, exitCode: -1) is UNPROVEN and may respawn - not the same as 'not loaded'", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({ exitCode: -1, stdout: "" })),
      10_000,
    );

    expect(respawn).toBe(true);
  });

  it("launchctl's own positive-exit-code 'could not find service' answer does not respawn", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner(() => ({
        exitCode: 113,
        stdout: "Could not find service in domain for port\n",
      })),
      10_000,
    );

    expect(respawn).toBe(false);
  });

  it("consults BOTH the CLI label and Desktop's SMAppService .agent label - the agent in its relaunch window still refuses", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");
    const seenTargets: string[] = [];

    const respawn = await macosServiceMayRespawn(
      label,
      fakeRunner((target) => {
        seenTargets.push(target);
        if (target.endsWith(".agent")) {
          return {
            exitCode: 0,
            stdout: "\tlast exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT\n",
          };
        }
        return { exitCode: 1, stdout: "Could not find service\n" };
      }),
      10_000,
    );

    expect(respawn).toBe(true);
    // Both targets were actually probed, not just the CLI label - the
    // whole point of the dual-label check.
    expect(seenTargets).toHaveLength(2);
    expect(seenTargets[0]).not.toContain(".agent");
    expect(seenTargets[1]).toContain(".agent");
  });
});

describe("macosServiceMayRespawn (one deadline across both labels)", () => {
  const label = {
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production" as Environment,
    devSlot: null,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a first launchctl that spends most of the budget leaves the second only the rest - the probe cannot exceed its caller's budget", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");
    const timeouts: number[] = [];
    const runner = async (
      _command: string,
      _args: readonly string[],
      options: { readonly timeoutMs: number },
    ) => {
      timeouts.push(options.timeoutMs);
      // The CLI label's probe sits for nine of the ten seconds before
      // answering "not loaded"; the Desktop label's must then get ~one.
      const wait = timeouts.length === 1 ? 9_000 : 0;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait);
      });
      return { stdout: "Could not find service", stderr: "", exitCode: 113 };
    };

    const pending = macosServiceMayRespawn(label, runner, 10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(false);

    expect(timeouts[0]).toBe(10_000);
    expect(timeouts[1] ?? Number.NaN).toBeLessThanOrEqual(1_000);
    expect(timeouts[1] ?? Number.NaN).toBeGreaterThan(0);
  });

  it("a first launchctl that spends the WHOLE budget leaves the second a 1 ms probe, and its timeout reads as may-respawn - the unasked label is never cleared", async () => {
    const { macosServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/macos")
    >("../../service/platforms/macos");
    const timeouts: number[] = [];
    const runner = async (
      _command: string,
      _args: readonly string[],
      options: { readonly timeoutMs: number },
    ) => {
      timeouts.push(options.timeoutMs);
      if (timeouts.length === 1) {
        // Sits past the deadline before answering "not loaded".
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 12_000);
        });
        return { stdout: "Could not find service", stderr: "", exitCode: 113 };
      }
      // What `runCommand` returns for a probe that hit its timeout.
      return { stdout: "", stderr: "", exitCode: -1 };
    };

    const pending = macosServiceMayRespawn(label, runner, 10_000);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);

    expect(timeouts).toEqual([10_000, 1]);
  });
});

describe("linuxServiceMayRespawn (field parsing, real systemctl classification)", () => {
  // Checked by inspection that this shape was already covered: anything
  // that is not `inactive`/`failed`/`unknown` falls through to `true`,
  // including the empty stdout a `-1` (spawn failure / timeout) resolve
  // produces - `systemctl --user is-active` never runs. Pinned here rather
  // than left to inspection, mirroring the macOS pair above.
  const label = {
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production" as Environment,
    devSlot: null,
  };

  it("a probe that never ran (spawn failure or timeout, exitCode: -1, empty stdout) is UNPROVEN and may respawn", async () => {
    const { linuxServiceMayRespawn } = await vi.importActual<
      typeof import("../../service/platforms/linux")
    >("../../service/platforms/linux");

    const respawn = await linuxServiceMayRespawn(
      label,
      async () => ({
        exitCode: -1,
        stdout: "",
        stderr: "",
      }),
      10_000,
    );

    expect(respawn).toBe(true);
  });
});
