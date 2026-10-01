import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";
import type { ApplyHostOutcome } from "../../installer/apply";

// `host apply` over a service registration that is disabled (its owner's
// setting) or another user's:
//  - the EXPLICIT apply swaps, keeps the task disabled and says so at exit 0;
//  - `--respect-hold` (the desktop's launch apply, an AUTOMATIC path) defers
//    before the lock, the busy gate or the stop, with the reserved exit 79;
//  - `--respect-hold --no-service` touches no service, so is never refused.

const state = vi.hoisted(() => ({
  home: "",
  outcome: null as ApplyHostOutcome | null,
  applyHostCalls: 0,
  lockCalls: 0,
  disabled: { kind: "not-disabled" } as
    | { kind: "disabled" }
    | { kind: "not-disabled" },
}));

vi.mock("../../installer/apply", () => ({
  applyHost: async () => {
    state.applyHostCalls += 1;
    if (state.outcome === null) throw new Error("test outcome not set");
    return state.outcome;
  },
}));
vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      _opts: unknown,
      fn: () => Promise<T>,
    ): Promise<T> => {
      state.lockCalls += 1;
      return fn();
    },
  };
});
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return { ...actual, hostHomeDir: () => state.home };
});
// R3: `refuseUpdateOverUnstartableService` reads ownership through the gate
// (`readWindowsServiceTaskOwnership`), not the removed
// `readOwnServiceRegistrationDisabled`. `state.disabled` drives a caller task
// whose `<Enabled>` matches it; only the disabled/not-disabled axis is this
// file's concern (the not-owned axis is `update-service-unstartable.test.ts`'s).
vi.mock("../../service/platforms/windows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/windows")>();
  return {
    ...actual,
    readWindowsServiceTaskOwnership: async () =>
      state.disabled.kind === "disabled"
        ? {
            kind: "caller" as const,
            xml: "<Task><Settings><Enabled>false</Enabled></Settings></Task>",
          }
        : { kind: "absent" as const },
  };
});
vi.mock("@traycer/protocol/config/installation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer/protocol/config/installation")
    >();
  return { ...actual, readHostHeldVersion: async () => null };
});
vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return { ...actual, readHostInstallRecord: async () => null };
});

import { buildHostApplyCommand } from "../host-apply";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";
import {
  SERVICE_KEPT_DISABLED_WARNING,
  type ServiceRegistrationWarning,
} from "../../service/registration-owner";
import { SERVICE_TASK_NOT_OWNED_MESSAGE } from "../../service/platforms/windows-task-gate";

function record(version: string): HostInstallRecord {
  return {
    installId: "install-test",
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function appliedWith(
  postSwapWarning: ServiceRegistrationWarning | null,
): ApplyHostOutcome {
  return {
    outcome: "applied",
    record: record("1.3.0"),
    previous: record("1.2.0"),
    runningActivated: false,
    installGeneration: "gen-1",
    serviceLifecycle: {
      priorServiceState: "stopped",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
    },
    postSwapError: null,
    postSwapWarning,
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: true,
      environment: "production",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    output: {
      progress: () => undefined,
      human: () => undefined,
      humanRequired: () => undefined,
      emitResult: () => undefined,
      emitError: () => undefined,
    },
    progress: () => undefined,
  };
}

function run(flags: { respectHold: boolean; noService: boolean }) {
  return buildHostApplyCommand({
    force: false,
    noService: flags.noService,
    expectedStageFingerprint: null,
    respectHold: flags.respectHold,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
    acceptStoreFormatLoss: false,
  })(fakeCtx());
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "traycer-host-apply-svc-"));
  state.applyHostCalls = 0;
  state.lockCalls = 0;
  state.disabled = { kind: "not-disabled" };
  state.outcome = appliedWith(null);
  // `refuseUpdateOverUnstartableService` reads nothing on any platform but
  // win32 - the disabled-task axis this file drives.
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  rmSync(state.home, { recursive: true, force: true });
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("explicit host apply over a service its owner disabled", () => {
  it("exits 0: applied, the warning in the payload and on the human line, nothing activated, not reported as a failed activation", async () => {
    state.disabled = { kind: "disabled" };
    state.outcome = appliedWith(SERVICE_KEPT_DISABLED_WARNING);

    const result = await run({ respectHold: false, noService: false });

    expect(result.exitCode).toBe(0);
    expect(state.applyHostCalls).toBe(1);
    expect(result.data).toMatchObject({
      outcome: "applied",
      runningActivated: false,
      postSwapError: null,
      postSwapWarning: {
        code: "E_SERVICE_REGISTRATION_DISABLED",
        message: SERVICE_KEPT_DISABLED_WARNING.message,
      },
      // Nothing was attempted and nothing failed.
      activation: "not-attempted",
    });
    expect(result.human ?? "").toContain(SERVICE_KEPT_DISABLED_WARNING.message);
    expect(result.human ?? "").not.toContain("start/restart request failed");
  });

  it("over another user's task the human line carries the refusal's copy at exit 0", async () => {
    state.outcome = appliedWith({
      code: "E_SERVICE_TASK_NOT_OWNED",
      message: SERVICE_TASK_NOT_OWNED_MESSAGE,
      details: { reason: "other-owner" },
    });
    const result = await run({ respectHold: false, noService: false });
    expect(result.exitCode).toBe(0);
    expect(result.human ?? "").toContain(SERVICE_TASK_NOT_OWNED_MESSAGE);
    expect(result.data).toMatchObject({
      postSwapWarning: { code: "E_SERVICE_TASK_NOT_OWNED" },
    });
  });
});

describe("host apply --respect-hold over a service its owner disabled (the automatic launch apply)", () => {
  it("defers: E_SERVICE_REGISTRATION_DISABLED, exit 79, before the lock - so no stop, no swap", async () => {
    state.disabled = { kind: "disabled" };
    await expect(
      run({ respectHold: true, noService: false }),
    ).rejects.toMatchObject({
      code: "E_SERVICE_REGISTRATION_DISABLED",
      exitCode: HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE,
      details: { deferred: true },
    });
    expect(state.lockCalls).toBe(0);
    expect(state.applyHostCalls).toBe(0);
  });

  it("is not refused with --no-service, which touches no service", async () => {
    state.disabled = { kind: "disabled" };
    state.outcome = appliedWith(null);
    const result = await run({ respectHold: true, noService: true });
    expect(result.exitCode).toBe(0);
    expect(state.applyHostCalls).toBe(1);
  });

  it("is not refused when the service is enabled", async () => {
    const result = await run({ respectHold: true, noService: false });
    expect(result.exitCode).toBe(0);
    expect(state.applyHostCalls).toBe(1);
  });

  it("an EXPLICIT apply (no --respect-hold) over the same disabled service is not refused", async () => {
    state.disabled = { kind: "disabled" };
    const result = await run({ respectHold: false, noService: false });
    expect(result.exitCode).toBe(0);
    expect(state.applyHostCalls).toBe(1);
  });
});
