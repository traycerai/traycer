import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../cli/traycer-cli", () => ({
  streamTraycerCliJson: vi.fn(async () => ({ data: {} })),
}));

import { HostLifecycle, PRODUCTION_LABEL } from "../host-lifecycle";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";
import type { DesktopLocalHostSnapshot } from "../../../ipc-contracts/host-types";
import type { HostFsLayout } from "../host-paths";

// The retry scenarios use a stable synthetic pid while the test controls the
// endpoint probe. A platform liveness probe has no positive result for that
// pid, so model the indeterminate branch locally: the handshake remains
// authoritative while a positively dead/recycled pid is rejected elsewhere.
function useIndeterminateProcessLiveness(): () => void {
  const restore = __setAsyncProcessLivenessReaderForTest(
    async () => "indeterminate",
  );
  return () => __setAsyncProcessLivenessReaderForTest(restore);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met in time");
    }
    await sleep(25);
  }
}

function layoutIn(dir: string): HostFsLayout {
  return {
    rootDir: dir,
    pidMetadataFile: join(dir, "pid.json"),
    logFile: join(dir, "host.log"),
    installDir: join(dir, "install"),
    installRecordFile: join(dir, "install", "install.json"),
    stagedDir: join(dir, "staged"),
    stagedRecordFile: join(dir, "staged", "staged.json"),
    pendingLoginItemRevisionFile: join(dir, "pending-login-item-revision.json"),
    environment: "production" as const,
  };
}

const PID_METADATA = JSON.stringify({
  hostId: "3be7933d-bcaa-478b-b914-e625b5d2a777",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
  version: "production.1784044433971.435b4f59c",
  pid: 18841,
});

/**
 * Regression guard for the 2026-07-14 incident (production desktop log,
 * first launch after a reinstall): bootstrap timed out with HOST_NOT_READY,
 * the host then published pid.json and became reachable 7s later - and the
 * snapshot stayed null for the rest of the session because the pid.json
 * watcher is edge-triggered on file WRITES while reachability is
 * time-varying. A single probe failure at the only watcher edge used to be
 * terminal ("Bound host is offline" on every chat until an app restart).
 *
 * The fix is the retry-until-reachable ladder in `reloadSnapshot`: whenever
 * pid metadata exists but its endpoint didn't answer, a backoff timer keeps
 * re-probing until the endpoint answers (or the metadata disappears).
 */
describe("HostLifecycle reachability retry ladder", () => {
  it(
    "converges after the host outlives a failed probe at the only watcher " +
      "edge, then stops probing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-"));
      const layout = layoutIn(dir);
      let probeResult = false;
      let probeCalls = 0;
      const lifecycle = new HostLifecycle({
        layout,
        bundledBinaryPath: null,
        label: PRODUCTION_LABEL,
        readyTimeoutMs: 300,
        reachabilityProbe: async () => {
          probeCalls += 1;
          return probeResult;
        },
      });
      const restoreLiveness = useIndeterminateProcessLiveness();
      const changes: (DesktopLocalHostSnapshot | null)[] = [];
      lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
        changes.push(snapshot);
      });
      const errors: { code: string }[] = [];
      lifecycle.on("error", (err: { code: string }) =>
        errors.push({ code: err.code }),
      );

      try {
        // The incident's opening state: app boots while the host is down.
        await lifecycle.bootstrap();
        expect(errors).toEqual([{ code: "HOST_NOT_READY" }]);
        expect(lifecycle.getSnapshot()).toBeNull();

        // Host publishes pid.json, but the probe fails at the watcher edge
        // (a just-spawned host exceeding the 750ms connect budget).
        await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
        await waitUntil(() => probeCalls >= 1, 5_000);

        // The host is now genuinely reachable. No further fs event will
        // fire - only the retry ladder can converge.
        probeResult = true;
        await waitUntil(() => lifecycle.getSnapshot() !== null, 10_000);
        expect(lifecycle.getSnapshot()?.hostId).toBe(
          "3be7933d-bcaa-478b-b914-e625b5d2a777",
        );
        expect(changes.at(-1)?.pid).toBe(18841);

        // Convergence clears the ladder: no further probes fire once the
        // snapshot is reachable (the max retry delay is 5s, so a lingering
        // timer would show up well within this window).
        const settledCalls = probeCalls;
        await sleep(1_200);
        expect(probeCalls).toBe(settledCalls);
      } finally {
        restoreLiveness();
        lifecycle.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("clears the ARMED ladder on a deliberate stop and never resurfaces the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-"));
    const layout = layoutIn(dir);
    let reachable = false;
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return reachable;
      },
    });
    const changes: (DesktopLocalHostSnapshot | null)[] = [];
    lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
      changes.push(snapshot);
    });
    lifecycle.on("error", () => {});

    try {
      // pid.json is present but the endpoint refuses: bootstrap times out and
      // the ladder ARMS, so this test actually exercises the clear path (the
      // previous version left the probe reachable, so no ladder ever armed and
      // deleting the clear would not have failed it).
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await lifecycle.bootstrap();
      expect(lifecycle.getSnapshot()).toBeNull();
      await waitUntil(() => probeCalls >= 2, 5_000);

      // `traycer host stop` unlinks pid.json on graceful teardown. Even if an
      // unrelated process now answers on that port, an ABSENT file must clear
      // the ladder and never resurface a host the user deliberately stopped.
      await unlink(layout.pidMetadataFile);
      reachable = true;
      await sleep(1_500);
      expect(lifecycle.getSnapshot()).toBeNull();
      expect(changes.every((snapshot) => snapshot === null)).toBe(true);
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * The tests above drive the ladder through real `fs.watch` edges. These
 * exercise the retry PREDICATE directly - no `bootstrap()`, no watcher - by
 * calling `reloadSnapshotFromDisk()` ourselves and advancing fake timers, so a
 * regression that made the predicate arm/clear on the wrong condition fails
 * here even if a stray watcher edge would otherwise have masked it.
 */
describe("HostLifecycle reachability retry ladder (predicate, no bootstrap)", () => {
  it("converges via the retry timer when malformed metadata becomes valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-direct-"));
    const layout = layoutIn(dir);
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    try {
      // Malformed: present but INDETERMINATE, not absent - the ladder must
      // arm without ever reaching the probe (there is no URL to probe yet).
      await writeFile(layout.pidMetadataFile, '{"hostId":"partial', "utf8");
      const first = await lifecycle.reloadSnapshotFromDisk();
      expect(first).toBeNull();
      expect(probeCalls).toBe(0);

      // The file becomes valid before the armed timer fires. Only the
      // ladder's own scheduled reload can pick this up - bootstrap()/the
      // watcher were never installed in this test.
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await waitUntil(() => lifecycle.getSnapshot() !== null, 8_000);
      expect(lifecycle.getSnapshot()?.hostId).toBe(
        "3be7933d-bcaa-478b-b914-e625b5d2a777",
      );
      expect(probeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("clears on absence and does not resurface a later valid file without a new reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-direct-"));
    const layout = layoutIn(dir);
    let reachable = false;
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return reachable;
      },
    });
    try {
      // Parsed but unreachable: arms the ladder.
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      const first = await lifecycle.reloadSnapshotFromDisk();
      expect(first).toBeNull();
      await waitUntil(() => probeCalls >= 1, 5_000);

      // Deliberate stop before the next armed reload: it must observe an
      // absent file and clear, not reschedule.
      await unlink(layout.pidMetadataFile);
      await sleep(1_000);
      expect(lifecycle.getSnapshot()).toBeNull();

      // A later valid, reachable file appears - but with the ladder cleared
      // and no watcher installed (bootstrap() was never called), nothing
      // re-reads it. The snapshot must stay null; only an explicit reload (a
      // real watcher event in production) would surface it.
      reachable = true;
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await sleep(1_500);
      expect(lifecycle.getSnapshot()).toBeNull();
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
