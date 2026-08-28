import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `traycer host service start` - the public background start, and the
// counterpart to `host stop`. See `../service-start.ts`'s module doc for why
// it exists as its own command rather than a mode of `host start`.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  lockCalls: [] as Array<{ reason: string }>,
  startFails: false,
  // Is a host POSITIVELY serving? The `running` status alone is derived from a
  // bare liveness check over pid metadata, so this is what decides whether the
  // idempotent shortcut is safe.
  hostServing: true,
  statusResponses: [] as Array<{
    state: "running" | "stopped" | "not-installed" | "externally-managed";
    version: string | null;
    listenUrl: string | null;
    pid: number | null;
  }>,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    serviceLabelFor: () => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    }),
    createServiceController: () => ({
      status: async () => {
        const next = mocks.statusResponses.shift();
        if (next === undefined) {
          throw new Error("test status queue exhausted");
        }
        return next;
      },
      start: async () => {
        mocks.controllerCalls.push("start");
        if (mocks.startFails) throw new Error("schtasks /Run failed");
      },
    }),
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../host/incumbent-check")>()),
  findLiveIncumbentHost: async () =>
    mocks.hostServing
      ? { pid: 4242, version: "1.2.3", websocketUrl: "ws://127.0.0.1:1/rpc" }
      : null,
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      mocks.lockCalls.push({ reason: opts.reason });
      return fn();
    },
  };
});

import { serviceStartCommand } from "../service-start";
import type { CommandContext } from "../../runner/runner";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

const NOT_INSTALLED = {
  state: "not-installed" as const,
  version: null,
  listenUrl: null,
  pid: null,
};

describe("serviceStartCommand", () => {
  beforeEach(() => {
    mocks.controllerCalls = [];
    mocks.lockCalls = [];
    mocks.statusResponses = [];
    mocks.startFails = false;
    mocks.hostServing = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The `not-installed` read is ADVISORY, not a gate. On Windows
  // `statusService` maps every `schtasks /Query` failure - timeout, transient
  // access denial - to `not-installed`, so refusing on it meant a genuinely
  // registered service could not be started whenever that query happened to
  // fail. The platform start is the authoritative attempt; the read only
  // decides what to say when it fails.
  it("still attempts the start when the registration probe says nothing is installed", async () => {
    mocks.startFails = false;
    mocks.statusResponses = [
      NOT_INSTALLED,
      { state: "running", version: "1.2.3", listenUrl: null, pid: 4242 },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toContain("start");
    expect(result.exitCode).toBe(0);
  });

  it("names 'traycer host service install' when the start fails and nothing is registered", async () => {
    mocks.startFails = true;
    mocks.statusResponses = [NOT_INSTALLED];

    let err: unknown;
    try {
      await serviceStartCommand(fakeCtx());
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.SERVICE_CONTROL_FAILED);
    expect((err as CliError).message).toContain("traycer host service install");
  });

  it("starts and reports alreadyRunning: false plus the post-start pid when the service was stopped", async () => {
    mocks.statusResponses = [
      { state: "stopped", version: null, listenUrl: null, pid: null },
      {
        state: "running",
        version: "1.2.3",
        listenUrl: "ws://127.0.0.1:58036/rpc",
        pid: 4242,
      },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(result.data).toMatchObject({
      priorState: "stopped",
      state: "running",
      pid: 4242,
      alreadyRunning: false,
    });
    expect(result.exitCode).toBe(0);
    // "requested ... a host is now serving", not "started the service". The
    // post-start readback shares the shortcut's blind spot: it can be
    // observing a FOREGROUND host while this service's supervisor exited after
    // finding that incumbent.
    expect(result.human ?? "").toContain("requested start");
    expect(result.human ?? "").not.toContain("started service");
  });

  // Idempotent like `host stop`, and it gets there by SKIPPING the platform
  // start rather than trusting it to no-op. On Windows the Scheduled Task is
  // registered `MultipleInstancesPolicy=IgnoreNew`, so `schtasks /Run` against
  // a live task is suppressed - and `runTaskAndVerifyStart` only accepts
  // POST-BASELINE spawn evidence, so a suppressed run polls out its verify
  // timeout and throws E_SERVICE_CONTROL_FAILED. Calling `start` here would
  // have made "start an already-running host" a slow hard failure on Windows.
  it("reports alreadyRunning: true without ever calling controller.start when the service was already running", async () => {
    mocks.hostServing = true;
    mocks.statusResponses = [
      {
        state: "running",
        version: "1.2.3",
        listenUrl: "ws://127.0.0.1:58036/rpc",
        pid: 4242,
      },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual([]);
    expect(result.data).toMatchObject({
      priorState: "running",
      state: "running",
      pid: 4242,
      alreadyRunning: true,
    });
    expect(result.exitCode).toBe(0);
    // "a host", not "the service": nothing here can attribute the running
    // process to the SERVICE MANAGER, since Linux and Windows both derive
    // `running` from shared pid metadata. A foreground `traycer host start`
    // satisfies it while the registration sits inactive, and claiming the
    // service was already running there reports success for a background start
    // that never happened.
    expect(result.human ?? "").toContain("a host is already serving");
    expect(result.human ?? "").toContain("traycer host start");
  });

  // `statusService` derives `running` from `isProcessAlive(pid)` over pid
  // metadata, so a RECYCLED pid reports a host that is not there. Taking the
  // idempotent shortcut on that left a genuinely stopped host down until
  // someone repaired the metadata - the opposite of what was asked.
  it("starts anyway when a 'running' status rests on stale, recycled pid metadata", async () => {
    mocks.hostServing = false;
    mocks.statusResponses = [
      { state: "running", version: "1.2.3", listenUrl: null, pid: 4242 },
      { state: "running", version: "1.2.3", listenUrl: null, pid: 5555 },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(result.data).toMatchObject({ alreadyRunning: false });
  });

  // `externally-managed` is macOS with Desktop's SMAppService owning the
  // label. Deliberately NOT refused: a registration exists, the user asked for
  // the host to be running, and the macOS backend redirects the start to the
  // agent label launchd can actually start.
  it("starts an externally-managed (Desktop-owned) registration rather than refusing it", async () => {
    mocks.hostServing = false;
    mocks.statusResponses = [
      {
        state: "externally-managed",
        version: null,
        listenUrl: null,
        pid: null,
      },
      { state: "running", version: "1.2.3", listenUrl: null, pid: 4242 },
    ];

    const result = await serviceStartCommand(fakeCtx());

    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(result.data).toMatchObject({ priorState: "externally-managed" });
    expect(result.exitCode).toBe(0);
  });

  // A failed pre-start probe must not turn into install guidance: we never
  // learned that nothing was registered, so the raw platform failure is the
  // honest error to surface.
  it("rethrows the raw start failure when the pre-start probe itself threw", async () => {
    mocks.startFails = true;
    mocks.statusResponses = []; // the mock status call throws

    let err: unknown;
    try {
      await serviceStartCommand(fakeCtx());
    } catch (caught) {
      err = caught;
    }

    expect(mocks.controllerCalls).toEqual(["start"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("schtasks /Run failed");
    expect((err as Error).message).not.toContain(
      "traycer host service install",
    );
  });

  it("runs the whole command inside one withCliLock acquisition with reason 'service-start'", async () => {
    mocks.statusResponses = [
      { state: "stopped", version: null, listenUrl: null, pid: null },
      { state: "running", version: "1.2.3", listenUrl: null, pid: 4242 },
    ];

    await serviceStartCommand(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "service-start" }]);
  });
});
