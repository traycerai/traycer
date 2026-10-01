import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";

// Test 31b's bootstrap half (T08 ruling 11), where finding 4 lived: the
// lifecycle's `not-installed` branch with a bootstrap (`host install`, and
// ensure's register, on a machine read as not installed) registers through
// the REAL Windows controller's `install`, on a fake process runner. The
// caller's task appears, disabled by its owner, before the create's own
// read. The write must carry Enabled=false, make no `/Run`, and the
// lifecycle must end with the typed kept-disabled warning - the report that
// crosses the controller -> lifecycle seam, which this branch once dropped.
// `install-lifecycle.test.ts` 49a pins the same seam from the lifecycle side
// with a controller that only reports; this drives the report's real source.
// (`host apply` never reaches this branch: with no bootstrap it leaves an
// unregistered service alone.)

const TEST_HOME = mkdtempSync(join(tmpdir(), "traycer-bootstrap-31b-"));

const mocks = vi.hoisted(() => ({
  controller: null as ServiceController | null,
}));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) => join(TEST_HOME, environment),
    hostHomeDir: (environment: string) => join(TEST_HOME, "host", environment),
  };
});
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));
vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});
vi.mock("../index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../index")>();
  return {
    ...actual,
    createServiceController: (): ServiceController => {
      if (mocks.controller === null) {
        throw new Error("no controller installed for this test");
      }
      return mocks.controller;
    },
    serviceLabelFor: (): ServiceLabel => LABEL,
  };
});
vi.mock("../cli-binary", () => ({
  resolveServiceCliInvocation: async () => ({
    command: "C:\\traycer.exe",
    args: [],
  }),
}));

import { NO_INSTALL_PHASE_HOOKS } from "../../installer";
import { createServiceInstallLifecycle } from "../install-lifecycle";
import {
  createWindowsController,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../platforms/windows";
import { SERVICE_KEPT_DISABLED_WARNING } from "../registration-owner";

const LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

const CALLER_SID = "S-1-5-21-1000-2000-3000-1001";

function callerTaskXml(enabled: boolean): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>${enabled ? "true" : "false"}</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command></Exec></Actions>
</Task>`;
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

afterEach(() => {
  mocks.controller = null;
  setWindowsDefinitionDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
});
afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("31b (bootstrap): the lifecycle's not-installed branch over the real Windows controller, a disabled task appearing before the create's read", () => {
  it("the write carries Enabled=false, 0 /Run, and postSwapWarning is SERVICE_KEPT_DISABLED_WARNING", async () => {
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    // The gate's own read finds nothing; the confirm-read after staging
    // finds this account's task, disabled by its owner.
    const answers: readonly ScheduledTaskXmlQuery[] = [
      { kind: "absent" },
      { kind: "xml", xml: callerTaskXml(false) },
    ];
    let reads = 0;
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        if (answer === undefined) throw new Error("unreachable");
        return answer;
      },
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const staged: boolean[] = [];
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async (_options, _userId, settingsEnabled) => {
        staged.push(settingsEnabled);
        return {
          tmpDir: join(TEST_HOME, "stage"),
          xmlPath: join(TEST_HOME, `stage-${String(staged.length)}.xml`),
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const osCalls: RecordedCall[] = [];
    const run: ProcessRunner = async (command, args) => {
      osCalls.push({ command, args: [...args] });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const windows = createWindowsController(run, { now: () => 0 });
    // Every verb but `install` is the lifecycle's view of a machine with no
    // registration; `install` is the real controller's.
    mocks.controller = {
      ...windows,
      status: async () => ({
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      }),
    };

    const handle = createServiceInstallLifecycle({
      environment: "production",
      bootstrap: { enableLinger: false, allowSelfInvocation: true },
      force: false,
      onWillStopHost: null,
      hooks: NO_INSTALL_PHASE_HOOKS,
    });
    await handle.lifecycle.beforeSwap();
    await handle.lifecycle.afterSwap();

    expect(handle.state.postSwapAction).toBe("install");
    expect(handle.state.postSwapWarning).toEqual(SERVICE_KEPT_DISABLED_WARNING);
    expect(handle.state.postSwapError).toBeNull();
    expect(staged).toEqual([true, false]);
    const schtasks = osCalls.filter((call) => call.command === "schtasks");
    expect(schtasks.filter((call) => call.args[0] === "/Create")).toHaveLength(
      1,
    );
    expect(schtasks.filter((call) => call.args[0] === "/Run")).toEqual([]);
  });
});
