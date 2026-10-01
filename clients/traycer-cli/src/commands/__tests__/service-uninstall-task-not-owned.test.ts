import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// `traycer host service uninstall` asks for the service registration and
// nothing else. Over a Scheduled Task another Windows user owns there is
// nothing of this account's to remove, so it FAILS with
// `E_SERVICE_TASK_NOT_OWNED` before anything - stop, sweep, launcher, task - is
// touched (`host uninstall` has work of its own and finishes it instead).
// Harness: the hoisted-home + mocked-controller shape of
// `service-uninstall-foreground.test.ts`.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const state = vi.hoisted(() => ({
  ownership: { kind: "absent" } as
    | { kind: "absent" }
    | { kind: "caller"; xml: string }
    | {
        kind: "not-owned";
        reason: "other-owner" | "unconfirmed";
        detail: string;
      },
  uninstall: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      uninstall: (...args: Parameters<typeof state.uninstall>) =>
        state.uninstall(...args),
      stop: (...args: Parameters<typeof state.stop>) => state.stop(...args),
    }),
    serviceLabelFor: (environment: "dev" | "production") => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  };
});

vi.mock("../../service/platforms/windows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/windows")>();
  return {
    ...actual,
    readWindowsServiceTaskOwnership: async () => state.ownership,
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/incumbent-check")>();
  return { ...actual, findLiveIncumbentHost: async () => null };
});

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: { reason: string },
      fn: (handle: {
        path: string;
        metadata: Record<string, unknown>;
        release: () => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> =>
      fn({ path: "/tmp/.lock", metadata: {}, release: async () => {} }),
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let workHome: string;

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

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-service-uninstall-owner-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.resetModules();
  state.ownership = { kind: "absent" };
  state.uninstall.mockReset();
  state.uninstall.mockResolvedValue(undefined);
  state.stop.mockReset();
  state.stop.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  rmSync(workHome, { recursive: true, force: true });
});

describe("host service uninstall over a task another Windows user owns", () => {
  for (const reason of ["other-owner", "unconfirmed"] as const) {
    it(`fails E_SERVICE_TASK_NOT_OWNED (${reason}) and mutates nothing: no controller call, so no stop, sweep, launcher or task write`, async () => {
      state.ownership = { kind: "not-owned", reason, detail: "" };
      const { serviceUninstallCommand } = await import("../service-uninstall");
      await expect(serviceUninstallCommand(fakeCtx())).rejects.toMatchObject({
        code: "E_SERVICE_TASK_NOT_OWNED",
        details: { verb: "delete", reason },
      });
      expect(state.uninstall).not.toHaveBeenCalled();
      expect(state.stop).not.toHaveBeenCalled();
    });
  }

  it("the refusal says another Windows user owns it and names no account", async () => {
    state.ownership = { kind: "not-owned", reason: "other-owner", detail: "" };
    const { serviceUninstallCommand } = await import("../service-uninstall");
    const caught = await serviceUninstallCommand(fakeCtx()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error("unreachable");
    expect(caught.message).toContain("owned by another Windows user");
    expect(JSON.stringify(caught)).not.toMatch(/S-1-\d/);
  });

  it("(unconfirmed) the refusal says ownership could not be confirmed, never another Windows user", async () => {
    state.ownership = { kind: "not-owned", reason: "unconfirmed", detail: "" };
    const { serviceUninstallCommand } = await import("../service-uninstall");
    const caught = await serviceUninstallCommand(fakeCtx()).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(caught instanceof Error)) throw new Error("unreachable");
    expect(caught.message).toBe(
      "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.",
    );
    expect(caught.message).not.toContain("another Windows user");
  });

  it("control: over the caller's own task (or none) it proceeds to the controller's uninstall", async () => {
    state.ownership = { kind: "absent" };
    const { serviceUninstallCommand } = await import("../service-uninstall");
    const result = await serviceUninstallCommand(fakeCtx());
    expect(result.exitCode).toBe(0);
    expect(state.uninstall).toHaveBeenCalledTimes(1);
  });
});
