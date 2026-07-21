import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandContext,
  CommandFn,
} from "../../../../../traycer-cli/src/runner/runner";

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/traycer-test/desktop",
    isPackaged: false,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

class RunnerBridgeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  readonly stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding = () => undefined;
    this.stderr.setEncoding = () => undefined;
  }

  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
  }

  close(exitCode: number): void {
    this.emit("close", exitCode);
  }
}

// The runner is intentionally invoked in-process so the fault-server registry
// configuration reaches its real code. `streamTraycerCliJson` is inherently a
// child-process consumer, so this bridge transports the runner's unmodified
// stdout bytes into that parser; it never constructs progress or result JSON.
let bridgeChild: RunnerBridgeChild | null = null;

vi.mock("node:child_process", () => ({
  execFile: () => {
    throw new Error("execFile is not used by the cross-layer stream test");
  },
  spawn: () => {
    if (bridgeChild === null) {
      throw new Error("runner bridge child was not configured");
    }
    return bridgeChild;
  },
  default: {
    execFile: () => {
      throw new Error("execFile is not used by the cross-layer stream test");
    },
    spawn: () => {
      if (bridgeChild === null) {
        throw new Error("runner bridge child was not configured");
      }
      return bridgeChild;
    },
  },
}));

const HOST_SIGNING_KEY =
  "RWSEfvU5EZoZYQTQUOVHeQFv3poThl1VM7FZLkNQr0Zu0FyL2x+u2O2l";
const HOST_SIGNING_KEY_ID = "847ef539119a1961";
const FAULT_SERVER_ATTEMPT_MS = 10_000;
const FAULT_SERVER_BACKOFF_MS = 750;
const DESKTOP_INACTIVITY_MS = 15_000;
const DESKTOP_ABSOLUTE_CAP_MS = 60_000;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_NON_INTERACTIVE = process.env.TRAYCER_NONINTERACTIVE;

const faultServers: Server[] = [];

beforeEach(() => {
  bridgeChild = null;
  process.env.CI = "";
  process.env.TRAYCER_NONINTERACTIVE = "";
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.doUnmock("../../../../../traycer-cli/src/config");
  vi.doUnmock("../../../../../traycer-cli/src/logger");
  vi.doUnmock("@sentry/node");
  if (ORIGINAL_CI === undefined) delete process.env.CI;
  else process.env.CI = ORIGINAL_CI;
  if (ORIGINAL_NON_INTERACTIVE === undefined) {
    delete process.env.TRAYCER_NONINTERACTIVE;
  } else {
    process.env.TRAYCER_NONINTERACTIVE = ORIGINAL_NON_INTERACTIVE;
  }
  await Promise.all(
    faultServers.splice(0).map((server) => closeFaultServer(server)),
  );
});

async function startFaultServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  faultServers.push(server);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fault server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeFaultServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(
  baseUrl: string,
  platformKey: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-21T00:00:00Z",
    latest: "1.5.0",
    versions: [
      {
        version: "1.5.0",
        releasedAt: "2026-07-21T00:00:00Z",
        releaseNotesUrl: "https://example.test/host-release-notes",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          [platformKey]: {
            available: true,
            unavailableReason: null,
            url: `${baseUrl}/archive`,
            sizeBytes: 6,
            sha256: sha256("abcdef"),
            signatureUrl: `${baseUrl}/archive.minisig`,
            signatureAlgorithm: "minisign",
            publicKeyId: HOST_SIGNING_KEY_ID,
          },
        },
      },
    ],
  };
}

function installCliSourceMocks(manifestUrl: string): void {
  vi.doMock("../../../../../traycer-cli/src/config", () => ({
    config: {
      environment: "test",
      hostTrustedPubkeys: [HOST_SIGNING_KEY],
    },
    hostRegistryUrl: manifestUrl,
  }));
  vi.doMock("../../../../../traycer-cli/src/logger", () => ({
    createCliLogger: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    }),
    errorFromUnknown: (value: unknown) =>
      value instanceof Error ? value : new Error(String(value)),
  }));
  vi.doMock("@sentry/node", () => ({
    captureException: () => undefined,
    flush: async () => undefined,
  }));
}

class RunnerExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`runner exited with ${exitCode}`);
    this.exitCode = exitCode;
  }
}

async function runRunnerIntoBridge(
  command: CommandFn,
  child: RunnerBridgeChild,
): Promise<void> {
  const originalWrite = process.stdout.write;
  const originalExit = process.exit;
  Object.defineProperty(process.stdout, "write", {
    configurable: true,
    value: (chunk: string | Uint8Array): boolean => {
      child.stdout.emit(
        "data",
        typeof chunk === "string" ? chunk : chunk.toString(),
      );
      return true;
    },
  });
  Object.defineProperty(process, "exit", {
    configurable: true,
    value: (exitCode: number | undefined): never => {
      throw new RunnerExit(exitCode ?? 0);
    },
  });
  try {
    const { runCommand } =
      await import("../../../../../traycer-cli/src/runner/runner");
    await runCommand(command, {
      json: true,
      quiet: null,
      noProgress: null,
      noBootstrap: null,
    });
    throw new Error("runner returned without its terminal process.exit");
  } catch (error) {
    if (error instanceof RunnerExit) {
      child.close(error.exitCode);
      return;
    }
    throw error;
  } finally {
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: originalWrite,
    });
    Object.defineProperty(process, "exit", {
      configurable: true,
      value: originalExit,
    });
  }
}

async function waitForRequestCount(
  count: () => number,
  expected: number,
  nativeSetTimeout: typeof setTimeout,
): Promise<void> {
  for (let tick = 0; tick < 100 && count() < expected; tick += 1) {
    await new Promise<void>((resolve) => {
      nativeSetTimeout(resolve, 10);
    });
  }
  expect(count()).toBeGreaterThanOrEqual(expected);
}

async function driveBlackholedFetchRetries(
  count: () => number,
  nativeSetTimeout: typeof setTimeout,
): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await waitForRequestCount(count, attempt, nativeSetTimeout);
    await vi.advanceTimersByTimeAsync(FAULT_SERVER_ATTEMPT_MS);
    await new Promise<void>((resolve) => {
      nativeSetTimeout(resolve, 10);
    });
    if (attempt < 4) {
      await vi.advanceTimersByTimeAsync(FAULT_SERVER_BACKOFF_MS);
    }
  }
}

function startDesktopStream(
  child: RunnerBridgeChild,
  progressStages: string[],
  streamTraycerCliJson: typeof import("../traycer-cli").streamTraycerCliJson,
): Promise<unknown> {
  bridgeChild = child;
  return streamTraycerCliJson<unknown>({
    args: ["host", "available"],
    onEvent: (event) => {
      if (event.type === "progress") progressStages.push(event.stage);
    },
    env: null,
    timeoutPolicy: {
      kind: "progress-inactivity",
      inactivityMs: DESKTOP_INACTIVITY_MS,
      absoluteCapMs: DESKTOP_ABSOLUTE_CAP_MS,
    },
    timeoutMs: DESKTOP_INACTIVITY_MS,
    invocation: { command: "in-process-runner", args: [] },
  });
}

function expectOfflineRegistryFailure(error: unknown): void {
  if (!(error instanceof Error)) {
    throw new Error("desktop stream rejected with a non-Error value");
  }
  return;
}

describe("cross-layer registry blackhole handling", () => {
  it("routes a blackholed manifest from the real host-available runner through NDJSON, Desktop timeout handling, and categorization", async () => {
    vi.useRealTimers();
    const nativeSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    let manifestRequests = 0;
    const baseUrl = await startFaultServer((request) => {
      if (request.url === "/versions.json") manifestRequests += 1;
    });
    installCliSourceMocks(`${baseUrl}/versions.json`);
    const child = new RunnerBridgeChild();
    const progressStages: string[] = [];
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const desktop = startDesktopStream(
      child,
      progressStages,
      streamTraycerCliJson,
    );
    const desktopOutcome = desktop.then(
      () => ({ failure: null }),
      (failure: unknown) => ({ failure }),
    );
    const { buildHostAvailableCommand } =
      await import("../../../../../traycer-cli/src/commands/host-available");
    const runner = runRunnerIntoBridge(
      buildHostAvailableCommand({ includePreReleases: false }),
      child,
    );

    await driveBlackholedFetchRetries(() => manifestRequests, nativeSetTimeout);
    await runner;

    const { failure } = await desktopOutcome;
    expectOfflineRegistryFailure(failure);
    const { categorizeHostCliError } =
      await import("../../host/host-readiness");
    expect(categorizeHostCliError(failure)).toEqual({
      kind: "offline",
      message:
        "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
      code: "E_REGISTRY_UNAVAILABLE",
    });
    expect(progressStages).toContain("registry-manifest-watchdog");
    expect(child.killed).toBe(false);
  });

  it("routes a blackholed signature after a complete archive through the same runner, NDJSON, Desktop timeout, and categorizer path", async () => {
    vi.useRealTimers();
    const nativeSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    let signatureRequests = 0;
    let archiveCompleted = false;
    let baseUrl = "";
    let platformKey = "";
    baseUrl = await startFaultServer((request, response) => {
      if (request.url === "/versions.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(manifestFor(baseUrl, platformKey)));
        return;
      }
      if (request.url === "/archive") {
        response.writeHead(200, { "content-length": "6", etag: '"etag-1"' });
        response.end("abcdef", () => {
          archiveCompleted = true;
        });
        return;
      }
      if (request.url === "/archive.minisig") signatureRequests += 1;
    });
    installCliSourceMocks(`${baseUrl}/versions.json`);
    const child = new RunnerBridgeChild();
    const progressStages: string[] = [];
    const { streamTraycerCliJson } = await import("../traycer-cli");
    const desktop = startDesktopStream(
      child,
      progressStages,
      streamTraycerCliJson,
    );
    const desktopOutcome = desktop.then(
      () => ({ failure: null }),
      (failure: unknown) => ({ failure }),
    );
    const { createDefaultRegistryClient, currentHostPlatformKey } =
      await import("../../../../../traycer-cli/src/registry");
    platformKey = currentHostPlatformKey();
    const signatureCommand: CommandFn = async (
      ctx: CommandContext,
    ): Promise<{
      readonly data: unknown;
      readonly human: string | null;
      readonly exitCode: number;
    }> => {
      const client = await createDefaultRegistryClient(
        ctx.runtime.environment,
        ctx.progress,
      );
      const { entry, asset } = await client.resolveAsset(
        "latest",
        currentHostPlatformKey(),
      );
      await client.downloadAndVerify(entry, asset, () => undefined);
      return { data: { installed: true }, human: null, exitCode: 0 };
    };
    const runner = runRunnerIntoBridge(signatureCommand, child);

    await waitForRequestCount(() => signatureRequests, 1, nativeSetTimeout);
    expect(archiveCompleted).toBe(true);
    await driveBlackholedFetchRetries(
      () => signatureRequests,
      nativeSetTimeout,
    );
    await runner;

    const { failure } = await desktopOutcome;
    expectOfflineRegistryFailure(failure);
    const { categorizeHostCliError } =
      await import("../../host/host-readiness");
    expect(categorizeHostCliError(failure)).toEqual({
      kind: "offline",
      message:
        "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
      code: "E_REGISTRY_UNAVAILABLE",
    });
    expect(progressStages).toContain("registry-signature-watchdog");
    expect(child.killed).toBe(false);
  });
});
