import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  withUpdateContender,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";

// HOME is redirected to a private temp dir BEFORE anything reads it: the
// `store/paths` mock below only overrides `hostHomeDir` - it is NOT
// isolation on its own, because `createCliLogger` (through
// `store/paths.ts`'s `cliLogPath`) and the protocol path helpers still
// resolve `homedir()` for real. `node:os.homedir()` itself must be
// redirected first.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-stop-if-idle-stop-intent-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(async () => {
  expect(osHome.current).not.toBe("");
  const paths =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  expect(paths.hostHomeDir("production").startsWith(osHome.current)).toBe(true);
  expect(paths.cliLogPath("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

// `host stop --if-idle` through the REAL `withStopIntent` decorator: a busy
// host must refuse before the decorator announces anything, because the stop
// intent is written inside `controller.stop` and a supervisor that reads one
// reads the kill that follows as deliberate.

const state = vi.hoisted(() => ({
  home: "",
  announced: [] as string[],
  busy: false,
}));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, hostHomeDir: () => state.home };
});
vi.mock("../stop-intent", () => ({
  writeStopIntent: async (_environment: string, reason: string) => {
    state.announced.push(reason);
    return true;
  },
  clearStopIntent: async () => undefined,
}));
vi.mock("../incumbent-check", () => ({
  findLiveIncumbentHost: async () => null,
}));
vi.mock("../busy-check", () => ({
  assertHostIdleForStop: async () => {
    if (state.busy) {
      const { CliError, CLI_ERROR_CODES } = await import("../../runner/errors");
      throw new CliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "busy",
        details: null,
        exitCode: 1,
      });
    }
  },
}));

import { withStopIntent, type ServiceController } from "../../service";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { stopHostServiceWithAttempt } from "../update-mutation";

const label = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production" as const,
  devSlot: null,
};
const options = {
  environment: "production" as const,
  reason: "stop-if-idle-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "service-maintenance" as const,
};

function inner(calls: string[]): ServiceController {
  const unimplemented = (): never => {
    throw new Error("not used in this test");
  };
  return {
    install: unimplemented,
    uninstall: unimplemented,
    status: unimplemented,
    stop: async () => {
      calls.push("inner-stop");
    },
    start: unimplemented,
    restart: unimplemented,
    stopForRestart: unimplemented,
    relaunchAfterRestart: unimplemented,
    hostStartAdoptionLabel: unimplemented,
    retireCompetingRegistration: unimplemented,
    takeoverDesktopRegistration: unimplemented,
  };
}

const roots: string[] = [];
afterEach(async () => {
  state.announced.length = 0;
  state.busy = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function inContender(
  run: (capability: UpdateMutationCapability) => Promise<unknown>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stop-if-idle-intent-"));
  roots.push(root);
  state.home = join(root, "host-home");
  await withUpdateContender(
    {
      hostHomeDir: state.home,
      reason: options.reason,
      waitMs: 0,
      pollIntervalMs: 10,
      admission: options.admission,
    },
    run,
  );
}

describe("--if-idle through withStopIntent", () => {
  it("a busy host writes NO stop intent and stops nothing", async () => {
    const calls: string[] = [];
    state.busy = true;
    const controller = withStopIntent(inner(calls));
    await inContender(async (capability) => {
      await expect(
        stopHostServiceWithAttempt(
          capability,
          options,
          controller,
          label,
          { force: false },
          "if-idle",
        ),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
    });
    expect(state.announced).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an idle host announces the intent and then stops", async () => {
    const calls: string[] = [];
    const controller = withStopIntent(inner(calls));
    await inContender((capability) =>
      stopHostServiceWithAttempt(
        capability,
        options,
        controller,
        label,
        { force: false },
        "if-idle",
      ),
    );
    expect(state.announced).toEqual(["stop"]);
    expect(calls).toEqual(["inner-stop"]);
  });
});
