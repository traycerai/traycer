import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import type { Environment } from "../../runner/environment";
import type { HostPidMetadata, HostPidMetadataEvidence } from "../pid-metadata";
import { singleChatStoreSurveyRoot } from "../chat-store-survey-roots";

const mocks = vi.hoisted(() => ({
  readHostPidMetadataEvidenceMock: vi.fn(),
  macosServiceMayRespawnMock: vi.fn(),
  linuxServiceMayRespawnMock: vi.fn(),
  // The path `readStopIntent`/`writeStopIntent` resolve through
  // `hostStopIntentPath`, which this suite sandboxes to a per-test temp
  // file - see the `store/paths` mock below for why the module-level
  // `store/paths` mock most other suites use does not, by itself, cover
  // this one path.
  stopIntentPath: { current: "" },
}));

vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadataEvidence: mocks.readHostPidMetadataEvidenceMock,
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

// `readStopIntent`/`writeStopIntent` (kept REAL below, deliberately not
// mocked - the "ordinary running-host downgrade" tests exist to pin the
// genuine file-based freshness check) resolve their path through
// `hostStopIntentPath`, which - like `hostPidMetadataPath` elsewhere in this
// package - computes via `store/paths`'s OWN internal `hostHomeDir()` call
// rather than the module's exported binding, so overriding `hostHomeDir`
// here would not redirect it. Overriding `hostStopIntentPath` itself does.
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostStopIntentPath: () => mocks.stopIntentPath.current,
  };
});

// Default to "will not respawn" so the pre-existing tests below - none of
// which care about this arm - keep clearing exactly as before, without ever
// touching the real platform probes.
mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
mocks.linuxServiceMayRespawnMock.mockResolvedValue(false);

const { observeSwapQuiescence } = await import("../swap-quiescence");
const { writeStopIntent } = await import("../stop-intent");

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

let sandboxRoot: string;

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "swap-quiescence-test-"));
  // No file at this path by default - `readStopIntent` reads it as ENOENT
  // and returns `null`, exactly like a machine with no stop in flight.
  mocks.stopIntentPath.current = join(sandboxRoot, "stop-intent.json");
});

afterEach(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

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

  it("is NOT established, with reason unseen-writers, when the survey spans more than one root - and never even consults the pid record", async () => {
    // `pid.json` is SLOT-scoped while the chat stores are IDENTITY-scoped.
    // A pooled identity home carries no pid record at all, and the host
    // holding it publishes into its own slot, which this process cannot
    // enumerate - so every root beyond the one whose pid we can read is a
    // store whose writer we cannot see, and its silence proves nothing.
    // This check has to run BEFORE the pid read, not merely produce the
    // same outcome after it - asserting the mock's call count is what
    // proves the ordering rather than just the result. Cleared first since
    // this file has no shared `beforeEach` and earlier tests left calls on
    // the same mock.
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
    afterEach(() => {
      // Restore the "will not respawn" default so a test order change
      // elsewhere in this file can't inherit a `true` left behind here.
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
      mocks.linuxServiceMayRespawnMock.mockResolvedValue(false);
    });

    it("is NOT established, reason service-may-respawn, when pid.json is absent but the service manager may restart one", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
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
          reason: "service-may-respawn",
        });
      });
    });

    it("is NOT established, reason service-may-respawn, when the published process is provably gone but the service manager may restart one", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "read",
        metadata: samplePidMetadata({ pid: DEFINITELY_DEAD_PID }),
      } satisfies HostPidMetadataEvidence);
      mocks.linuxServiceMayRespawnMock.mockResolvedValue(true);
      const logger = fakeLogger();

      await withPlatform("linux", async () => {
        await expect(
          observeSwapQuiescence(
            ENVIRONMENT,
            singleChatStoreSurveyRoot("/tmp/host-home"),
            logger,
          ),
        ).resolves.toEqual({
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

  describe("the ordinary running-host downgrade (stop-intent marker, driven for real)", () => {
    // `beforeSwap` stops the host CHILD, the clean stop purges `pid.json`,
    // and `stopService` returns while launchd/systemd still consider the
    // SUPERVISOR running (it outlives its child by the whole post-mortem).
    // Without reading intent, that live supervisor alone would refuse the
    // headline Settings > Update-now downgrade by its own stop. These tests
    // drive `writeStopIntent`/the real freshness check rather than mocking
    // `deliberateStopInFlight` away, because the file-based marker IS the
    // production path this fix depends on.
    afterEach(() => {
      mocks.macosServiceMayRespawnMock.mockResolvedValue(false);
      vi.useRealTimers();
    });

    it("running host, clean stop, supervisor still present, FRESH stop intent -> quiesced", async () => {
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      await writeStopIntent(ENVIRONMENT, "stop");
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

    it("fresh RESTART intent + live supervisor -> service-may-respawn, NOT quiesced", async () => {
      // A `restart` intent means a NEW host is expected - the opposite of
      // winding down - so a live supervisor here is exactly the writer this
      // check exists to catch, not one to wave through.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      await writeStopIntent(ENVIRONMENT, "restart");
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
          reason: "service-may-respawn",
        });
      });
    });

    it("fresh UNINSTALL intent + live supervisor -> service-may-respawn, NOT quiesced", async () => {
      // Not this flow at all - a stop intent this check cannot name as a
      // deliberate `stop` is not one it should vouch for.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      await writeStopIntent(ENVIRONMENT, "uninstall");
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
          reason: "service-may-respawn",
        });
      });
    });

    it("same, but the intent is STALE (older than STOP_INTENT_STALE_MS) -> service-may-respawn", async () => {
      // Past expiry the supervisor itself resumes normal crash recovery, so
      // a stale record would be vouching for a stop nobody is running
      // anymore.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
      vi.useFakeTimers();
      const writtenAt = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(writtenAt);
      await writeStopIntent(ENVIRONMENT, "stop");
      const { STOP_INTENT_STALE_MS } = await import("../stop-intent");
      vi.setSystemTime(
        new Date(writtenAt.getTime() + STOP_INTENT_STALE_MS + 1_000),
      );
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
          reason: "service-may-respawn",
        });
      });
    });

    it("no intent at all + live supervisor -> service-may-respawn", async () => {
      // No `writeStopIntent` call at all - the ordinary crash-loop shape,
      // not a deliberate stop.
      mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
        kind: "absent",
      } satisfies HostPidMetadataEvidence);
      mocks.macosServiceMayRespawnMock.mockResolvedValue(true);
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
          reason: "service-may-respawn",
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
        stdout: "\tlast exit code = (never exited)\n",
      })),
    );

    expect(respawn).toBe(false);
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
    );

    expect(respawn).toBe(true);
    // Both targets were actually probed, not just the CLI label - the
    // whole point of the dual-label check.
    expect(seenTargets).toHaveLength(2);
    expect(seenTargets[0]).not.toContain(".agent");
    expect(seenTargets[1]).toContain(".agent");
  });
});
