import { describe, expect, it } from "vitest";
import type { ProbeCommandResult } from "@traycer-clients/shared/host-lifecycle";
import { probeMacosWedgedJob } from "../launchd-wedge";

// The v1.1.8 lockout shape, pinned at the doctor probe: launchd holds the
// label loaded (ownership checks read "healthy") while the job itself
// cannot run. The probe must report only on positive wedge evidence from
// the job's run state, route the repair by who owns the registration, and
// stay silent on healthy, absent, and unreadable worlds - a probe that
// can cry wolf would be disabled within a release.

function printResult(stdout: string): ProbeCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    signal: null,
  };
}

function notFoundResult(): ProbeCommandResult {
  return {
    exitCode: 113,
    stdout: "",
    stderr: "Could not find specified service\n",
    timedOut: false,
    spawnFailed: false,
    signal: null,
  };
}

const WEDGED_AGENT_PRINT = [
  "gui/501/ai.traycer.host.agent = {",
  "\tactive count = 0",
  "\tpath = (submitted by smd.516)",
  "\ttype = Submitted",
  "\tmanaged_by = com.apple.xpc.ServiceManagement",
  "\tstate = spawn failed",
  "\tlast exit code = 78",
  "}",
  "",
].join("\n");

const HEALTHY_AGENT_PRINT = [
  "gui/501/ai.traycer.host.agent = {",
  "\tactive count = 1",
  "\tpath = (submitted by smd.516)",
  "\ttype = Submitted",
  "\tmanaged_by = com.apple.xpc.ServiceManagement",
  "\tstate = running",
  "\tpid = 4242",
  "}",
  "",
].join("\n");

const WEDGED_CLI_PRINT = [
  "gui/501/ai.traycer.host = {",
  "\tactive count = 0",
  "\tpath = /Users/me/Library/LaunchAgents/ai.traycer.host.plist",
  "\ttype = LaunchAgent",
  "\tstate = spawn failed",
  "}",
  "",
].join("\n");

describe.runIf(process.platform !== "win32")("probeMacosWedgedJob", () => {
  it("reports a wedged Desktop-owned agent with the takeover escape hatch", async () => {
    const targets: string[] = [];
    const issue = await probeMacosWedgedJob({
      labelId: "ai.traycer.host",
      agentLabelId: "ai.traycer.host.agent",
      hasPidMetadata: false,
      runner: async (target) => {
        targets.push(target);
        return printResult(WEDGED_AGENT_PRINT);
      },
    });

    expect(issue).not.toBeNull();
    expect(issue?.code).toBe("SERVICE_JOB_WEDGED");
    expect(issue?.severity).toBe("error");
    // Both wedge markers from the print bytes, named as evidence.
    expect(issue?.message).toContain("spawn failed");
    expect(issue?.message).toContain("last exit code = 78");
    expect(issue?.message).toContain("ai.traycer.host.agent");
    // Desktop owns the registration: the repair routes through the app,
    // with the never-refuse uninstall as the escape hatch when the app
    // itself is what is broken.
    expect(issue?.message).toContain("Traycer Desktop app");
    expect(issue?.message).toContain("traycer host service uninstall");
    expect(issue?.terminalCommand).toBe("traycer host service uninstall");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.details).toMatchObject({
      labelId: "ai.traycer.host.agent",
      ownership: "smappservice",
      reasons: ["job-state-spawn-failed", "last-exit-ex-config-78"],
      jobState: "spawn failed",
      lastExitCode: 78,
    });
  });

  it("stays silent on a healthy loaded agent and never probes the second label", async () => {
    const targets: string[] = [];
    const issue = await probeMacosWedgedJob({
      labelId: "ai.traycer.host",
      agentLabelId: "ai.traycer.host.agent",
      hasPidMetadata: true,
      runner: async (target) => {
        targets.push(target);
        return printResult(HEALTHY_AGENT_PRINT);
      },
    });

    expect(issue).toBeNull();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain("ai.traycer.host.agent");
  });

  it("falls through an absent agent label to a wedged CLI-owned job and routes to a real RE-REGISTRATION, never a restart", async () => {
    const issue = await probeMacosWedgedJob({
      labelId: "ai.traycer.host",
      agentLabelId: "ai.traycer.host.agent",
      hasPidMetadata: false,
      runner: async (target) =>
        target.endsWith(".agent")
          ? notFoundResult()
          : printResult(WEDGED_CLI_PRINT),
    });

    expect(issue).not.toBeNull();
    expect(issue?.details).toMatchObject({
      labelId: "ai.traycer.host",
      ownership: "cli-or-other",
      reasons: ["job-state-spawn-failed"],
    });
    // A wedged job is wedged in the definition launchd has CACHED. Only a
    // bootout/bootstrap cycle replaces it, and `service install` is the
    // operation that performs one (pinned behaviourally in macos.test.ts:
    // "runs print -> bootout -> bootstrap -> kickstart").
    expect(issue?.terminalCommand).toBe("traycer host service install");
    expect(issue?.fixAction).toBe("service-install");
    // Pinned in the other direction too, because the wrong answer here is
    // not a missing action but a plausible one that cannot work: `restart`
    // ends in `kickstart -k` against that same cached definition, and both
    // `host-start` and `host-restart` resolve to `restartHost()` in the GUI.
    // Offering either returns the user to this exact card.
    expect(issue?.terminalCommand).not.toBe("traycer host restart");
    expect(issue?.fixAction).not.toBe("host-start");
    expect(issue?.fixAction).not.toBe("host-restart");
    expect(issue?.message).toContain("cannot fix this");
  });

  it("stays silent when both labels are absent", async () => {
    const issue = await probeMacosWedgedJob({
      labelId: "ai.traycer.host",
      agentLabelId: "ai.traycer.host.agent",
      hasPidMetadata: false,
      runner: async () => notFoundResult(),
    });
    expect(issue).toBeNull();
  });

  it("stays silent when launchctl itself cannot run - unknown must not report as wedged", async () => {
    const issue = await probeMacosWedgedJob({
      labelId: "ai.traycer.host",
      agentLabelId: "ai.traycer.host.agent",
      hasPidMetadata: false,
      runner: async () => ({
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnFailed: true,
        signal: null,
      }),
    });
    expect(issue).toBeNull();
  });
});
