import { describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import type { Environment } from "../../runner/environment";
import type { HostPidMetadata, HostPidMetadataEvidence } from "../pid-metadata";

const mocks = vi.hoisted(() => ({
  readHostPidMetadataEvidenceMock: vi.fn(),
}));

vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadataEvidence: mocks.readHostPidMetadataEvidenceMock,
  };
});

const { observeSwapQuiescence } = await import("../swap-quiescence");

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

describe("observeSwapQuiescence", () => {
  it("is established when no host has ever published pid.json (kind: absent)", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "absent",
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(observeSwapQuiescence(ENVIRONMENT, logger)).resolves.toEqual({
      established: true,
    });
  });

  it("is NOT established, with reason writer-unknown and a warn, when pid.json could not be read", async () => {
    mocks.readHostPidMetadataEvidenceMock.mockResolvedValue({
      kind: "unreadable",
      cause: "simulated EACCES",
    } satisfies HostPidMetadataEvidence);
    const logger = fakeLogger();

    await expect(observeSwapQuiescence(ENVIRONMENT, logger)).resolves.toEqual({
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

    await expect(observeSwapQuiescence(ENVIRONMENT, logger)).resolves.toEqual({
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

    await expect(observeSwapQuiescence(ENVIRONMENT, logger)).resolves.toEqual({
      established: false,
      reason: "writer-still-running",
    });
  });
});
