import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// `readWindowsTaskEnabledState` (windows.ts) reads the task's own
// `<Settings><Enabled>` - Task Scheduler's "Disable" switch - from ONE
// read-only `queryTaskXml` call, the same seam `WindowsDefinitionDeps` gives
// the definition refresher. A sibling trigger's own `<Enabled>` (e.g. a
// LogonTrigger switched off on its own) is deliberately NOT this signal: a
// task whose trigger is off still runs on `/Run`, so only the task-level
// Settings value counts.
//
// HOME isolation: hoisted `vi.mock("node:os")` mkdtemps `homedir()` before
// any import runs. Every row below drives `readWindowsTaskEnabledState` /
// `readServiceRegistrationDisabled` through the injected `queryTaskXml` seam
// alone - neither function touches the filesystem or `~/.traycer` - but the
// mock is kept for the same defensive reason `windows-status-query-failure
// .test.ts` gives: matching the isolation standard other suites in this
// epic got wrong by relying on a partial `store/paths` mock alone.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: mkdtempSyncForHome } = await import("node:fs");
  const { join: joinForHome } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSyncForHome(
      joinForHome(actual.tmpdir(), "traycer-windows-task-enabled-os-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

afterAll(async () => {
  if (osHome.current !== "") {
    await rm(osHome.current, { recursive: true, force: true });
  }
});

import {
  readWindowsTaskEnabledState,
  setWindowsDefinitionDepsForTests,
  type ScheduledTaskXmlQuery,
} from "../windows";
import { readServiceRegistrationDisabled } from "../../registration-disabled";
import { serviceLabelFor } from "../../label";

const label = serviceLabelFor("production");

/** A queried task's XML with the given task-level Settings Enabled text. */
function taskXml(
  settingsEnabled: string | null,
  triggerEnabled: string,
): string {
  const settingsEnabledLine =
    settingsEnabled === null
      ? ""
      : `<Enabled>${settingsEnabled}</Enabled>\n    `;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>${triggerEnabled}</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    ${settingsEnabledLine}<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\traycer\\cli.exe</Command>
      <Arguments>host start</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

function queryReturning(query: ScheduledTaskXmlQuery): {
  readonly queryTaskXml: (taskName: string) => Promise<ScheduledTaskXmlQuery>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    queryTaskXml: async (taskName: string) => {
      calls.push(taskName);
      return query;
    },
    calls,
  };
}

afterEach(() => {
  setWindowsDefinitionDepsForTests(null);
});

describe("readWindowsTaskEnabledState", () => {
  it("(w1) Settings Enabled=false: disabled", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: taskXml("false", "true"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "disabled",
    });
  });

  it("(w2) LogonTrigger Enabled=false but Settings Enabled=true: enabled - the trigger's own switch does not count", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: taskXml("true", "false"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "enabled",
    });
  });

  it("(w3) Settings without an Enabled element: enabled (the schema default)", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: taskXml(null, "true"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "enabled",
    });
  });

  it("(w4) Settings Enabled=0: disabled", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: taskXml("0", "true"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "disabled",
    });
  });

  it("(w5) the query fails: unknown, with the reason carried through", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "failed",
      reason: "schtasks /Query failed (exit 1: ERROR: Access is denied.)",
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "unknown",
      reason: "schtasks /Query failed (exit 1: ERROR: Access is denied.)",
    });
  });

  it("(w6) the query says absent: not-registered", async () => {
    const { queryTaskXml } = queryReturning({ kind: "absent" });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "not-registered",
    });
  });

  it("(w7) XML with no Settings element at all: unknown", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author">
    <Exec>
      <Command>C:\\traycer\\cli.exe</Command>
      <Arguments>host start</Arguments>
    </Exec>
  </Actions>
</Task>`,
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "unknown",
      reason: "the task has no Settings element",
    });
  });

  // A realistic full `schtasks /Query /XML` export (trimmed of the fields
  // this function never reads), Task Scheduler's actual shape for a task an
  // operator disabled from the GUI or `schtasks /Change /TN ... /DISABLE`.
  it("(w8) a realistic schtasks export with Settings Enabled=false: disabled", async () => {
    const realisticXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>2026-01-01T00:00:00</Date>
    <Author>DESKTOP-TESTBOX\\testuser</Author>
    <URI>\\ai.traycer.host</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>DESKTOP-TESTBOX\\testuser</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>DESKTOP-TESTBOX\\testuser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>false</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\Users\\testuser\\AppData\\Local\\traycer\\cli\\bin\\traycer.exe</Command>
      <Arguments>host start</Arguments>
    </Exec>
  </Actions>
</Task>`;
    const { queryTaskXml } = queryReturning({ kind: "xml", xml: realisticXml });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(readWindowsTaskEnabledState(label)).resolves.toEqual({
      kind: "disabled",
    });
  });
});

describe("readServiceRegistrationDisabled", () => {
  it("(m1) darwin/linux: not-disabled, and the platform query is never called", async () => {
    const { queryTaskXml, calls } = queryReturning({
      kind: "xml",
      xml: taskXml("false", "true"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(
      readServiceRegistrationDisabled(label, "darwin"),
    ).resolves.toEqual({ kind: "not-disabled" });
    await expect(
      readServiceRegistrationDisabled(label, "linux"),
    ).resolves.toEqual({ kind: "not-disabled" });
    expect(calls).toHaveLength(0);
  });

  it("(m2) win32 with a disabled task: disabled", async () => {
    const { queryTaskXml } = queryReturning({
      kind: "xml",
      xml: taskXml("false", "true"),
    });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(
      readServiceRegistrationDisabled(label, "win32"),
    ).resolves.toEqual({ kind: "disabled" });
  });

  it("(m3) win32 with the task not registered: not-disabled", async () => {
    const { queryTaskXml } = queryReturning({ kind: "absent" });
    setWindowsDefinitionDepsForTests({
      queryTaskXml,
      predictCli: async () => ({ command: "cli", args: [] }),
      resolveCli: async () => ({ command: "cli", args: [] }),
    });

    await expect(
      readServiceRegistrationDisabled(label, "win32"),
    ).resolves.toEqual({ kind: "not-disabled" });
  });
});
