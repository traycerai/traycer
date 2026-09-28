import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// `statusService` (`windows.ts:~520-535`) runs
// `runCommand("schtasks", ["/Query","/TN",task], {tolerateNonZeroExit: false})`
// and treats ANY `ProcessRunError` (its base class, so `ProcessSpawnError`
// and `ProcessTimeoutError` both qualify via `instanceof`) as "the task is
// not registered". An access-denied query or a timeout is read exactly like
// a genuinely missing task, so `host status` (and everything that trusts it,
// like `ensure`'s re-registration decision - see `ensure.test.ts`'s status-probe-failure tests) silently reports
// "not-installed" for a service that is very much still there.
//
// HOME isolation: hoisted `vi.mock("node:os")` mkdtemps `homedir()` before
// any import runs - defensive, since every row here either throws before
// `statusService` reaches `readHostPidMetadata` or resolves through the
// early `statusNotInstalled()` return, neither of which touches
// `~/.traycer`, but the row shapes are exactly the kind other suites in this
// epic got wrong by relying on a partial `store/paths` mock alone. Also
// mocks `../../../host/pid-metadata` (unreached by every row below, but
// mocked the same way `windows.test.ts` does it, in case a future row here
// ever reaches the `registered: true` branch).
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: mkdtempSyncForHome } = await import("node:fs");
  const { join: joinForHome } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSyncForHome(
      joinForHome(actual.tmpdir(), "traycer-windows-status-query-os-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(async () => null),
  removeHostPidMetadata: vi.fn(async () => undefined),
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));

const runCommandMock = vi.hoisted(() => ({
  impl: null as
    | ((command: string, args: readonly string[]) => Promise<unknown>)
    | null,
}));
vi.mock("../../process-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process-runner")>();
  return {
    ...actual,
    runCommand: async (command: string, args: readonly string[]) => {
      if (runCommandMock.impl === null) {
        throw new Error("runCommand called without a configured mock impl");
      }
      return runCommandMock.impl(command, args);
    },
  };
});

afterAll(async () => {
  if (osHome.current !== "") {
    await rm(osHome.current, { recursive: true, force: true });
  }
});

import { createWindowsController } from "../windows";
import { ProcessRunError, ProcessTimeoutError } from "../../process-runner";
import { serviceLabelFor } from "../../label";

const label = serviceLabelFor("production");

describe("statusService disambiguates schtasks /Query failures", () => {
  it("(i) access denied: status(label) rejects rather than reading as not-installed", async () => {
    runCommandMock.impl = async () => {
      throw new ProcessRunError(
        "schtasks /Query /TN ai.traycer.host exited with code 1: ERROR: Access is denied.",
        "schtasks",
        ["/Query", "/TN", "ai.traycer.host"],
        1,
        "",
        "ERROR: Access is denied.\r\n",
      );
    };
    const controller = createWindowsController(null, { now: () => 0 });

    await expect(controller.status(label)).rejects.toThrow();
  });

  it("(ii) a timeout (ProcessTimeoutError): status(label) rejects rather than reading as not-installed", async () => {
    runCommandMock.impl = async () => {
      throw new ProcessTimeoutError(
        "schtasks /Query /TN ai.traycer.host timed out after 15000ms (killed via SIGTERM)",
        "schtasks",
        ["/Query", "/TN", "ai.traycer.host"],
        -1,
        "",
        "",
        15_000,
      );
    };
    const controller = createWindowsController(null, { now: () => 0 });

    await expect(controller.status(label)).rejects.toThrow();
  });

  it("(iii) control: 'cannot find the file specified' resolves {state:'not-installed', ...} - green on head", async () => {
    runCommandMock.impl = async () => {
      throw new ProcessRunError(
        "schtasks /Query /TN ai.traycer.host exited with code 1: ERROR: The system cannot find the file specified.",
        "schtasks",
        ["/Query", "/TN", "ai.traycer.host"],
        1,
        "",
        "ERROR: The system cannot find the file specified.\r\n",
      );
    };
    const controller = createWindowsController(null, { now: () => 0 });

    await expect(controller.status(label)).resolves.toEqual({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });
  });

  it("(iv) corrupt task image: resolves 'not-installed' on head, but for the WRONG reason (any failure reads that way, not specifically a corrupt-image diagnosis)", async () => {
    runCommandMock.impl = async () => {
      throw new ProcessRunError(
        "schtasks /Query /TN ai.traycer.host exited with code 1: ERROR: The task image is corrupt or has been tampered with.",
        "schtasks",
        ["/Query", "/TN", "ai.traycer.host"],
        1,
        "",
        "ERROR: The task image is corrupt or has been tampered with.\r\n",
      );
    };
    const controller = createWindowsController(null, { now: () => 0 });

    // Green on head - but only because `statusService` treats this
    // ProcessRunError exactly like every other one (access denied, a
    // timeout, a genuinely missing task), not because it recognises the
    // corrupt-image text. The new contract must reach the same outcome for
    // the RIGHT reason: recognising this specific wording, the same way
    // access-denied/timeout must now be told apart and thrown instead.
    await expect(controller.status(label)).resolves.toEqual({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });
  });
});
