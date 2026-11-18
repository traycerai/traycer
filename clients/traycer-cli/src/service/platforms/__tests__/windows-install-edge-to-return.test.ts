import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS,
  WINDOWS_START_SPAWN_POLL_MS,
  WINDOWS_START_SPAWN_VERIFY_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import {
  createWindowsController,
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
} from "../windows";
import { WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS } from "../../spawn-edge-bounds";
import { runWithLeaseAtServiceSpawnEdge } from "../../spawn-edge";
import { serviceLabelFor } from "../../label";
import type { SpawnEvidenceBaseline } from "../../../host/spawn-evidence";

// The documented bound (spawn-edge-bounds.ts): a Windows install's edge ->
// controller-return is the install bound (75s: /Create + verified /Run) plus
// one verify poll plus the failed start's /Last Run Result/ /Query. All three
// are IMPORTED, never hand-derived.
const DOCUMENTED_EDGE_TO_RETURN_MS =
  WINDOWS_INSTALL_SPAWN_EDGE_BOUND_MS +
  WINDOWS_START_SPAWN_POLL_MS +
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS;

// Hand-derived (not exported anywhere): the synchronous `whoami` read's
// `execFileSync` timeout, windows.ts `readCurrentUserSidFromWhoami`
// (`timeout: 10_000`).
const SID_READER_BLOCK_MS = 10_000;

// Same isolation windows.test.ts uses: the default staging writes the
// persistent launcher under `cliInstallHomeDir`, redirected to a temp root.
const TEST_CLI_INSTALL_HOME_ROOT = mkdtempSync(
  join(tmpdir(), "traycer-windows-install-edge-test-"),
);
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) =>
      join(TEST_CLI_INSTALL_HOME_ROOT, environment),
  };
});

vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));

afterAll(async () => {
  await rm(TEST_CLI_INSTALL_HOME_ROOT, { recursive: true, force: true });
});

function emptySpawnBaseline(): SpawnEvidenceBaseline {
  return {
    log: {
      path: "/tmp/host.log",
      exists: false,
      size: 0,
      dev: null,
      ino: null,
      mtimeMs: null,
    },
    pidMetadata: {
      path: "/tmp/pid.json",
      exists: false,
      mtimeMs: null,
      pid: null,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  // Only timers and Date are faked: the default staging does real file I/O,
  // whose completion must not be starved by a faked setImmediate.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  // Spawn evidence NEVER arrives: real verify window and poll, fake sleep.
  setWindowsStartEvidenceDepsForTests({
    captureBaseline: async () => emptySpawnBaseline(),
    createEvidenceReader: () => ({ collect: async () => null }),
    sleep,
    verifyTimeoutMs: WINDOWS_START_SPAWN_VERIFY_MS,
    verifyPollMs: WINDOWS_START_SPAWN_POLL_MS,
  });
  setWindowsTaskInstallDepsForTests(null);
  // The ownership gate reads the task in front of `/Create` and `/Run`; a
  // fresh install finds none, and the read costs no time on the edge's clock.
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => ({ kind: "absent" }),
    predictCli: async () => {
      throw new Error("predictCli is not part of an install");
    },
    resolveCli: async () => {
      throw new Error("resolveCli is not part of an install");
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  setWindowsDefinitionDepsForTests(null);
  setWindowsStartEvidenceDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
});

/**
 * Installs under `runWithLeaseAtServiceSpawnEdge`, returning edge -> return.
 * Advances fake time only to the next pending timer, and yields real ticks
 * while none is pending (file I/O), so no fake time is ever skipped over.
 */
async function edgeToReturnMs(): Promise<number> {
  // Every schtasks call is charged its full runner timeout.
  const runner: ProcessRunner = async (_command, _args, options) => {
    await sleep(options.timeoutMs);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  let edgeAt: number | null = null;
  const publish = async (): Promise<null> => {
    edgeAt = Date.now();
    return null;
  };
  const controller = createWindowsController(runner, { now: () => Date.now() });
  const run = runWithLeaseAtServiceSpawnEdge(publish, () =>
    controller.install({
      label: serviceLabelFor("staging"),
      cli: { command: "C:\\traycer.exe", args: [] },
      enableLinger: false,
    }),
  );
  let returnedAt: number | null = null;
  run.then(
    () => {
      returnedAt = Date.now();
    },
    () => {
      returnedAt = Date.now();
    },
  );
  for (let tick = 0; tick < 100_000 && returnedAt === null; tick += 1) {
    if (vi.getTimerCount() === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } else {
      await vi.advanceTimersToNextTimerAsync();
    }
  }
  if (returnedAt === null || edgeAt === null) {
    throw new Error("install never returned or never reached its edge");
  }
  return returnedAt - edgeAt;
}

describe("Windows install: edge to controller return", () => {
  it("(w0 control) an instant SID reader keeps edge -> return within the documented bound", async () => {
    setWindowsTaskUserSidReaderForTests(() => "S-1-5-21-1-2-3-1001");
    const observed = await edgeToReturnMs();
    expect(
      observed,
      `edge -> return ${observed} ms vs documented ${DOCUMENTED_EDGE_TO_RETURN_MS} ms`,
    ).toBeLessThanOrEqual(DOCUMENTED_EDGE_TO_RETURN_MS);
  });

  it("(w1) a synchronous 10s SID read after the edge pushes edge -> return past the documented bound", async () => {
    setWindowsTaskUserSidReaderForTests(() => {
      vi.setSystemTime(Date.now() + SID_READER_BLOCK_MS);
      return "S-1-5-21-1-2-3-1001";
    });
    const observed = await edgeToReturnMs();
    expect(
      observed,
      `edge -> return ${observed} ms vs documented ${DOCUMENTED_EDGE_TO_RETURN_MS} ms`,
    ).toBeLessThanOrEqual(DOCUMENTED_EDGE_TO_RETURN_MS);
  });
});
