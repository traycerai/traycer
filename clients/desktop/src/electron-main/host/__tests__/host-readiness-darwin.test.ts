import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror host-readiness.test.ts's harness: control reachability + URL shape,
// real `sleep`, real temp files for log + pid.json.
const mocks = vi.hoisted(() => ({
  canReachHostWebsocketUrl: vi.fn(),
}));

vi.mock("../host-lifecycle", () => ({
  canReachHostWebsocketUrl: (url: string) =>
    mocks.canReachHostWebsocketUrl(url),
  isCurrentHostWebsocketUrl: (url: string) => {
    try {
      const parsed = new URL(url);
      return (
        (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
        parsed.hostname === "127.0.0.1" &&
        parsed.port !== "" &&
        parsed.pathname === "/rpc"
      );
    } catch {
      return false;
    }
  },
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
}));

// host-readiness imports HOST_AGENT_LABEL + readAgentLabelPid transitively;
// stub both to keep the module graph free of electron / real launchctl.
vi.mock("../../app/host-login-item", () => ({
  HOST_AGENT_LABEL: "ai.traycer.host.agent",
}));
vi.mock("../launchctl-agent-pid", () => ({
  readAgentLabelPid: vi.fn().mockResolvedValue(null),
}));

const { captureHostSpawnEvidenceBaseline, waitForHostReady } =
  await import("../host-readiness");
import type { DarwinAgentAuthority } from "../host-readiness";

const AGENT_LABEL = "ai.traycer.host.agent";

function pidJson(pid: number): string {
  return JSON.stringify({
    version: "1.0.0",
    pid,
    websocketUrl: "ws://127.0.0.1:7100/rpc",
  });
}

function terminalMarker(supervisorPid: number, error: string): string {
  return `[${new Date().toISOString()}] phase=failed-to-spawn attempt=a supervisorPid=${supervisorPid} error=${error}\n`;
}

let root = "";
let logPath = "";
let pidPath = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "host-readiness-darwin-"));
  logPath = join(root, "host.log");
  pidPath = join(root, "pid.json");
  mocks.canReachHostWebsocketUrl.mockReset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function darwinAuthority(
  readAgentLabelPid: (label: string) => Promise<number | null>,
): Promise<DarwinAgentAuthority> {
  const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
  return {
    agentLabel: AGENT_LABEL,
    readAgentLabelPid,
    terminalMarkerBaseline: baseline,
    probeIntervalMs: 5,
  };
}

describe("waitForHostReady darwin agent-label authority (Finding F)", () => {
  it("extends past the base budget on a live agent-label pid, then returns ready", async () => {
    const readAgentLabelPid = vi.fn().mockResolvedValue(4242);
    // Unreachable through the base budget, then reachable - so a `ready` result
    // can only mean the wait extended past 40ms on the live agent pid.
    let calls = 0;
    mocks.canReachHostWebsocketUrl.mockImplementation(async () => {
      calls += 1;
      return calls > 8;
    });
    await writeFile(pidPath, pidJson(4242), "utf8");
    const authority = await darwinAuthority(readAgentLabelPid);

    const started = Date.now();
    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(readAgentLabelPid).toHaveBeenCalledWith(AGENT_LABEL);
  });

  it("fails at the base budget with the generic reason when there is no live agent pid and no owned terminal", async () => {
    const readAgentLabelPid = vi.fn().mockResolvedValue(null);
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const authority = await darwinAuthority(readAgentLabelPid);

    const started = Date.now();
    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });
    const elapsed = Date.now() - started;

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("pid metadata");
    // Did NOT extend toward the 5s hard cap.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("fail-fasts on an OWNED terminal marker once launchctl stops reporting the pid", async () => {
    // Gen 4242 is observed live, then launchctl stops reporting it (it crashed).
    // Its OWNED terminal marker is then the authoritative death reason. While
    // launchctl still yields a live pid a marker never fails the attempt - the
    // live pid is the sole authority (see the superseded-generation tests).
    let probe = 0;
    const readAgentLabelPid = vi
      .fn<(label: string) => Promise<number | null>>()
      .mockImplementation(async () => {
        probe += 1;
        return probe <= 1 ? 4242 : null; // Observed once, then gone.
      });
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const authority = await darwinAuthority(readAgentLabelPid);
    await writeFile(logPath, terminalMarker(4242, "EX_CONFIG"), "utf8");

    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("EX_CONFIG");
  });

  it("LANDMINE: an UNOWNED (legacy-label) terminal marker never fail-fasts the agent-label attempt", async () => {
    // The agent pid is 4242 and alive; a legacy-label start left a terminal
    // marker under a DIFFERENT supervisor pid. It must not fail this attempt -
    // the agent extends on its live pid and becomes ready.
    const readAgentLabelPid = vi.fn().mockResolvedValue(4242);
    let calls = 0;
    mocks.canReachHostWebsocketUrl.mockImplementation(async () => {
      calls += 1;
      return calls > 8;
    });
    await writeFile(pidPath, pidJson(4242), "utf8");
    const authority = await darwinAuthority(readAgentLabelPid);
    await writeFile(logPath, terminalMarker(9999, "EX_CONFIG"), "utf8");

    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(true);
  });

  it("fails once the agent-label pid disappears during the extended wait", async () => {
    // Alive through the base budget (so it extends), then gone: the extension
    // is only valid while a live current-generation pid exists.
    const started = Date.now();
    const readAgentLabelPid = vi
      .fn<(label: string) => Promise<number | null>>()
      .mockImplementation(async () =>
        Date.now() - started < 90 ? 4242 : null,
      );
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    const authority = await darwinAuthority(readAgentLabelPid);

    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("exited during the extended wait");
  });

  it("C1 (prod cadence): a superseded owned marker never fails while launchctl still yields a live pid", async () => {
    // probeIntervalMs (30) > pollIntervalMs (10): between real probes the cached
    // pid is reused across ~3 poll iterations, matching prod (3000 vs 250) rather
    // than inverting it. Gen A (100) is observed and its OWNED crash marker is on
    // disk from the first poll; the cached 100 is reused across several polls
    // before the next real probe reveals Gen B (200) live. A fail rule that
    // matched the (stale) cached pid to the marker would kill this attempt; the
    // live-pid-is-sole-authority rule keeps polling to readiness instead.
    let probe = 0;
    const readAgentLabelPid = vi
      .fn<(label: string) => Promise<number | null>>()
      .mockImplementation(async () => {
        probe += 1;
        return probe <= 1 ? 100 : 200; // Gen A observed once, then Gen B live.
      });
    let reach = 0;
    mocks.canReachHostWebsocketUrl.mockImplementation(async () => {
      reach += 1;
      return reach > 6; // Reachable only after extending on the live newer pid.
    });
    await writeFile(pidPath, pidJson(200), "utf8");
    const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
    const authority: DarwinAgentAuthority = {
      agentLabel: AGENT_LABEL,
      readAgentLabelPid,
      terminalMarkerBaseline: baseline,
      probeIntervalMs: 30,
    };
    await writeFile(logPath, terminalMarker(100, "EX_CONFIG"), "utf8");

    const result = await waitForHostReady(40, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(true);
  });

  it("M1: a single transient launchctl miss during the extended wait does not fail (debounce)", async () => {
    // Live agent pid the whole time except ONE isolated null probe well after
    // the wait has extended. A single transient miss (launchctl timeout / the
    // crash→relaunch gap) must not fail: confirmation needs consecutive misses.
    let probe = 0;
    const readAgentLabelPid = vi
      .fn<(label: string) => Promise<number | null>>()
      .mockImplementation(async () => {
        probe += 1;
        return probe === 6 ? null : 100; // One isolated miss, then live again.
      });
    let reach = 0;
    mocks.canReachHostWebsocketUrl.mockImplementation(async () => {
      reach += 1;
      return reach > 12; // Reachable only well after the flap, forcing extension.
    });
    await writeFile(pidPath, pidJson(100), "utf8");
    const authority = await darwinAuthority(readAgentLabelPid);

    const result = await waitForHostReady(20, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 5_000,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(true);
  });

  it("M2: an unowned terminal marker decorates the generic timeout reason", async () => {
    // Agent pid live the whole time (so it extends and never fail-fasts) but the
    // host never becomes reachable. A legacy-label (unowned) terminal marker
    // must surface as a diagnostic hint on the generic timeout, not be lost.
    const readAgentLabelPid = vi.fn().mockResolvedValue(4242);
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    await writeFile(pidPath, pidJson(4242), "utf8");
    const authority = await darwinAuthority(readAgentLabelPid);
    await writeFile(logPath, terminalMarker(9999, "EX_SOFTWARE"), "utf8");

    const result = await waitForHostReady(20, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 60, // Small extended cap so the generic timeout hits fast.
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain("EX_SOFTWARE");
    expect(result.reason).toContain("last observed host terminal marker");
  });

  it("does NOT decorate the timeout with a superseded OWNED marker (live-but-slow generation)", async () => {
    // Gen A (100) is observed then superseded by Gen B (200), which stays live
    // but never binds its port, so the wait times out. The generic timeout must
    // NOT be decorated with A's crash reason: A is a superseded OWNED marker, not
    // an unowned legacy start, and surfacing it would misattribute B's hang to a
    // stale, unrelated crash.
    let probe = 0;
    const readAgentLabelPid = vi
      .fn<(label: string) => Promise<number | null>>()
      .mockImplementation(async () => {
        probe += 1;
        return probe <= 1 ? 100 : 200; // Gen A observed once, then Gen B live.
      });
    mocks.canReachHostWebsocketUrl.mockResolvedValue(false);
    await writeFile(pidPath, pidJson(200), "utf8");
    const authority = await darwinAuthority(readAgentLabelPid);
    await writeFile(logPath, terminalMarker(100, "EX_CONFIG"), "utf8");

    const result = await waitForHostReady(20, pidPath, 10, null, {
      spawnEvidenceBaseline: null,
      extendedTimeoutMs: 60,
      darwinAgentAuthority: authority,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).not.toContain("EX_CONFIG");
  });
});
