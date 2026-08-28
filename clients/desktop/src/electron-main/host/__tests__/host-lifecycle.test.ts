import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Accept: test",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ephemeral listener has no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

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

const tlsConnect = vi.hoisted(() => vi.fn());

vi.mock("node:tls", () => ({
  connect: tlsConnect,
  default: { connect: tlsConnect },
}));

import {
  canReachHostWebsocketUrl,
  HostLifecycle,
  isCurrentHostWebsocketUrl,
  PRODUCTION_LABEL,
  readPidMetadata,
  readPidMetadataState,
} from "../host-lifecycle";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";
import { DEV_LABEL } from "../host-paths";
import { config } from "../../../config";

// These fixtures deliberately use synthetic PIDs. Their endpoint listener is
// the positive readiness evidence under test; an OS liveness result is
// unavailable for a synthetic pid, just as it can be unavailable for a real
// host because of permissions or a failed platform probe. Model that state
// locally, so no unrelated test can inherit the test-only global seam.
function useIndeterminateProcessLiveness(): () => void {
  const restore = __setAsyncProcessLivenessReaderForTest(
    async () => "indeterminate",
  );
  return () => __setAsyncProcessLivenessReaderForTest(restore);
}

describe("isCurrentHostWebsocketUrl", () => {
  it("accepts the canonical ws URL shape", () => {
    expect(isCurrentHostWebsocketUrl("ws://127.0.0.1:55555/rpc")).toBe(true);
  });
  it("rejects mismatched paths", () => {
    expect(isCurrentHostWebsocketUrl("ws://127.0.0.1:55555/stream")).toBe(
      false,
    );
  });
  it("rejects non-loopback hosts", () => {
    expect(isCurrentHostWebsocketUrl("ws://example.com:55555/rpc")).toBe(false);
  });
  it("rejects URLs without an explicit port", () => {
    expect(isCurrentHostWebsocketUrl("ws://127.0.0.1/rpc")).toBe(false);
  });
});

describe("readPidMetadata", () => {
  it("returns null on missing file", async () => {
    const result = await readPidMetadata(join(tmpdir(), "non-existent.json"));
    expect(result).toBeNull();
  });
  it("parses valid PID metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const path = join(dir, "host.pid.json");
    await writeFile(
      path,
      JSON.stringify({
        hostId: "test-host",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "0.0.0",
        pid: 12345,
      }),
      "utf8",
    );
    try {
      const result = await readPidMetadata(path);
      expect(result).toMatchObject({
        hostId: "test-host",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "0.0.0",
        pid: 12345,
      });
      expect(result?.displayName).toBe(result?.systemHostName);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Review finding 4: the retry ladder must distinguish a CONFIRMED-absent file
// (deliberate stop → clear the ladder) from a present-but-indeterminate read (a
// partial write / transient error → keep retrying). Collapsing both to `null`
// let a coalesced watcher edge that landed mid-write silently clear the ladder.
describe("readPidMetadataState", () => {
  it("reports `absent` only for a missing file (ENOENT)", async () => {
    const state = await readPidMetadataState(
      join(tmpdir(), "definitely-not-here.json"),
    );
    expect(state.kind).toBe("absent");
  });

  // A non-ENOENT read failure (EISDIR here - deterministic regardless of
  // root/CI, unlike a chmod-based EACCES) must classify as `indeterminate`,
  // never `absent`. If every read error collapsed to `absent`, a transient
  // EACCES/EIO on a present file would clear the retry ladder exactly like a
  // deliberate stop - the bug this discrimination exists to prevent.
  it("reports `indeterminate` for a non-ENOENT read failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-pidstate-"));
    const path = join(dir, "pid.json");
    // A directory at the pid.json path: readFile throws EISDIR, not ENOENT.
    await mkdir(path);
    try {
      const state = await readPidMetadataState(path);
      expect(state.kind).toBe("indeterminate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports `indeterminate` for a partially-written (invalid JSON) file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-pidstate-"));
    const path = join(dir, "pid.json");
    // A torn write: the host had only flushed the opening bytes.
    await writeFile(path, '{"hostId":"test-host","websocket', "utf8");
    try {
      const state = await readPidMetadataState(path);
      expect(state.kind).toBe("indeterminate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports `indeterminate` for valid JSON of the wrong shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-pidstate-"));
    const path = join(dir, "pid.json");
    await writeFile(path, JSON.stringify({ hostId: "x" }), "utf8");
    try {
      const state = await readPidMetadataState(path);
      expect(state.kind).toBe("indeterminate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports `parsed` with the snapshot for a complete file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-pidstate-"));
    const path = join(dir, "pid.json");
    await writeFile(
      path,
      JSON.stringify({
        hostId: "test-host",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "0.0.0",
        pid: 12345,
      }),
      "utf8",
    );
    try {
      const state = await readPidMetadataState(path);
      expect(state.kind).toBe("parsed");
      if (state.kind === "parsed") {
        expect(state.snapshot.hostId).toBe("test-host");
        expect(state.snapshot.pid).toBe(12345);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Directly exercises the real TCP probe that `HostLifecycle` uses by default
// (`reachabilityProbe: undefined`). Deterministic - a single listener for the
// reachable case, an immediate ECONNREFUSED on a freed port for the
// unreachable case - without the close/rebind-same-port race that made the
// orchestration test flaky.
describe("canReachHostWebsocketUrl", () => {
  it("returns true when the endpoint completes a WebSocket handshake", async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      expect(await canReachHostWebsocketUrl(`ws://127.0.0.1:${port}/rpc`)).toBe(
        true,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns false when nothing is listening on the port", async () => {
    // Bind to get an OS-assigned port, then free it so the connect is refused.
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await canReachHostWebsocketUrl(`ws://127.0.0.1:${port}/rpc`)).toBe(
      false,
    );
  });

  it("returns false for an unrelated TCP listener that does not speak WebSocket", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("ephemeral listener has no port");
    }
    try {
      expect(
        await canReachHostWebsocketUrl(`ws://127.0.0.1:${address.port}/rpc`),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses a completed TLS handshake before probing a wss endpoint", async () => {
    class TestTlsSocket extends EventEmitter {
      setTimeout = vi.fn();
      destroy = vi.fn();

      write(_request: string): boolean {
        this.emit(
          "data",
          Buffer.from(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Sec-WebSocket-Accept: test",
              "",
              "",
            ].join("\r\n"),
          ),
        );
        return true;
      }
    }

    const socket = new TestTlsSocket();
    tlsConnect.mockImplementationOnce((options: unknown) => {
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    });

    expect(await canReachHostWebsocketUrl("wss://127.0.0.1:45678/rpc")).toBe(
      true,
    );
    expect(tlsConnect).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 45678,
      rejectUnauthorized: false,
    });
  });
});

describe("HostLifecycle.bootstrap (metadata-first)", () => {
  // Ticket 7c890b39 - steady-state Desktop boot is metadata-first. The
  // legacy platform service-manager dispatch was deleted from the desktop
  // tree alongside `electron-main/service/`; bootstrap now reads pid.json
  // and probes the websocket endpoint, nothing else.

  it("publishes a snapshot from reachable PID metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "test-host",
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
        version: config.version,
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 5_000,
      reachabilityProbe: undefined,
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      expect(errors).toEqual([]);
      const snapshot = lifecycle.getSnapshot();
      expect(snapshot?.pid).toBe(12345);
      expect(snapshot?.version).toBe(config.version);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("A1: rejects a handshake-reachable legacy pid record when liveness proves its PID dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const reachabilityProbe = vi.fn(async () => true);
    const restoreLiveness = __setAsyncProcessLivenessReaderForTest(
      async () => "dead",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe,
    });
    try {
      await writeFile(
        layout.pidMetadataFile,
        JSON.stringify({
          hostId: "stale-host",
          websocketUrl: "ws://127.0.0.1:55555/rpc",
          version: "1.0.0",
          pid: 999_999,
        }),
        "utf8",
      );

      await expect(lifecycle.reloadSnapshotFromDisk()).resolves.toBeNull();
      expect(reachabilityProbe).toHaveBeenCalledOnce();
    } finally {
      lifecycle.dispose();
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits HOST_NOT_READY (Doctor/CLI recovery) when no PID metadata appears within the wait window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: undefined,
    });
    const errors: { code: string; message: string }[] = [];
    lifecycle.on("error", (err) =>
      errors.push({ code: err.code, message: err.message }),
    );
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("HOST_NOT_READY");
      expect(errors[0]?.message.toLowerCase()).toContain("doctor");
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // traycer#961 / #996 / #1001, int #4845: on a machine where no host has
  // EVER been installed, the launch converge refuses to provision before
  // sign-in, so no provisioning lane exists to re-arm the quiet budget - the
  // wait below could only ever run to completion and then report that a host
  // "did not start" when nothing asked it to. That ERROR rides in the
  // desktop.log attached to every fresh-install support report (it misdirected
  // three field investigations) and holding bootstrap open delays the deferred
  // work gated on it.
  //
  // The budget here is 30s against a 3s race: a regression to the waiting path
  // fails this test outright rather than merely slowing it down.
  it("skips the readiness wait entirely when no host is installed on this machine", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    // A never-installed machine has NO host root at all - the CLI creates it
    // during provisioning. Rooting the layout at an absent nested directory
    // is what makes this the real fresh-install shape: watching an existing
    // `mkdtemp` root would pass even with the ENOENT bug present.
    const dir = join(parent, "host");
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const websocketUrl = "ws://127.0.0.1:54322/rpc";
    let reachable = false;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 30_000,
      reachabilityProbe: (url) =>
        Promise.resolve(url === websocketUrl && reachable),
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: false }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("bootstrap waited")), 3_000),
        ),
      ]);
      // No host, but also no failure to report: nothing was asked to start.
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()).toBeNull();

      // The watcher still went in - against a root that did not exist when
      // bootstrap started. That is what picks the host up once the user signs
      // in and provisioning runs; skipping the wait must not cost the
      // auto-heal, and an ENOENT here would leave the desktop blind to a host
      // that appears later.
      reachable = true;
      // Exactly what provisioning does after sign-in: create the host root,
      // then publish pid.json into it. Creating it HERE rather than in the
      // fixture is what isolates the watcher - if bootstrap failed to install
      // one, these writes land silently and the snapshot never converges.
      await mkdir(dir, { recursive: true });
      await writeFile(
        layout.pidMetadataFile,
        JSON.stringify({
          hostId: "post-signin-host",
          websocketUrl,
          version: config.version,
          pid: 4321,
        }),
        "utf8",
      );
      // Comfortably inside this test's own 10s budget so a missing watcher
      // fails on the snapshot assertion below - naming the actual cause -
      // rather than as an opaque test timeout. The watcher fires in
      // milliseconds when it exists; the margin is for a loaded CI box where
      // event-loop and fs.watch latency spike.
      const deadline = Date.now() + 5_000;
      while (lifecycle.getSnapshot() === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(lifecycle.getSnapshot()?.hostId).toBe("post-signin-host");
      expect(errors).toEqual([]);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      // `parent`, not `dir` - the layout is rooted one level down, so removing
      // only `dir` would leave an empty temp directory behind on every run.
      await rm(parent, { recursive: true, force: true });
    }
  }, 10_000);

  // traycer#862: a fresh install downloaded ~800MB and extracted a 2.2GB
  // runtime tree - 3m17s on that machine - and the flat wall-clock budget
  // reported "Could not start Traycer Host" at the 60s mark, over an install
  // that was still visibly running. The budget is quiet-time, not wall-clock:
  // installer progress re-arms it, and only silence spends it.
  it("holds the startup budget open while host provisioning reports progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const readyTimeoutMs = 300;
    const progressWindowMs = 900;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs,
      reachabilityProbe: undefined,
    });
    const errors: { code: string; message: string }[] = [];
    lifecycle.on("error", (err) =>
      errors.push({ code: err.code, message: err.message }),
    );
    // Stand in for the CLI's NDJSON progress stream: events well inside the
    // quiet budget, for three times as long as that budget.
    let lastProgressAt = Date.now();
    const ticker = setInterval(() => {
      lastProgressAt = Date.now();
      lifecycle.notifyProvisioningActivity();
    }, 50);
    const stopTicker = setTimeout(
      () => clearInterval(ticker),
      progressWindowMs,
    );
    const startedAt = Date.now();
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 10_000),
        ),
      ]);
      const elapsedMs = Date.now() - startedAt;
      // No host ever appeared, so it still ends in HOST_NOT_READY - but only
      // after the installer went quiet. Under a flat budget this fired at
      // ~`readyTimeoutMs`, long before the progress stream stopped.
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("HOST_NOT_READY");
      expect(elapsedMs).toBeGreaterThanOrEqual(progressWindowMs);
      // ...and the budget is still a BUDGET once progress stops. Outliving the
      // progress window alone cannot tell "re-armed, then spent the full quiet
      // budget" apart from "re-armed, then fired the instant the stream went
      // quiet" - which is the regression a quiet-time deadline can actually
      // have. Measuring from the last event is what separates them.
      expect(Date.now() - lastProgressAt).toBeGreaterThanOrEqual(
        readyTimeoutMs,
      );
    } finally {
      clearTimeout(stopTicker);
      clearInterval(ticker);
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The build-stamp gate was removed: a reachable host is surfaced regardless
  // of its version stamp, and the renderer negotiates protocol compatibility
  // over the WS handshake. This is what prevents the permanent "Starting Local
  // Host" loop when the Desktop build stamp and the host release version differ
  // but are still compatible.
  it("surfaces a reachable host whose stamp differs from config.version on a non-production slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "dev" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "different-version-host",
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
        version: `${config.version}-stale`,
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: DEV_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: undefined,
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      // Reachable host on a different version is surfaced, not nulled - no
      // HOST_NOT_READY error fires.
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.hostId).toBe("different-version-host");
      expect(lifecycle.getSnapshot()?.version).toBe(`${config.version}-stale`);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A reachable host on a different stamp is surfaced in PRODUCTION too (no
  // environment exemption) - the headline "same flow on all environments"
  // behavior, pinned with a production layout specifically.
  it("surfaces a reachable stamp-mismatched host in PRODUCTION too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "busy-mismatched-host",
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
        version: `${config.version}-stale`,
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 5_000,
      reachabilityProbe: undefined,
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      // reloadSnapshotFromDisk returns the snapshot it derived; the desktop
      // judges "surfaced" off this return rather than a racy getSnapshot().
      const surfaced = await lifecycle.reloadSnapshotFromDisk();
      expect(surfaced?.hostId).toBe("busy-mismatched-host");
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.hostId).toBe("busy-mismatched-host");
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a reachable host whose stamp matches config.version on a non-production slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "dev" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "matching-host",
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
        version: config.version,
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: DEV_LABEL,
      readyTimeoutMs: 5_000,
      reachabilityProbe: undefined,
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.version).toBe(config.version);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed PID metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "bad-host",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "0.0.0",
        // pid intentionally missing
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 500,
      reachabilityProbe: undefined,
    });
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("HOST_NOT_READY");
      expect(lifecycle.getSnapshot()).toBeNull();
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unreachable / wrong-shape websocket URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "wrong-shape",
        websocketUrl: "ws://127.0.0.1:55555/legacy",
        version: "0.0.0",
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 500,
      reachabilityProbe: undefined,
    });
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      await Promise.race([
        lifecycle.bootstrap({ hostInstalled: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("HOST_NOT_READY");
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("holds one failed probe, degrades the second to busy - never to absent - and recovers on the next success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production" as const,
    };
    const websocketUrl = "ws://127.0.0.1:54321/rpc";
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "same-host",
        websocketUrl,
        version: config.version,
        pid: 12345,
      }),
      "utf8",
    );
    // Inject reachability so the reachable -> unreachable -> reachable
    // transitions are deterministic rather than racing real socket
    // bind/close/rebind on the same port (the CI flake).
    let reachable = true;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 5_000,
      reachabilityProbe: (url) =>
        Promise.resolve(url === websocketUrl && reachable),
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const changes: Array<string | null> = [];
    lifecycle.on("change", (snapshot) => {
      changes.push(snapshot?.hostId ?? null);
    });
    try {
      await lifecycle.bootstrap({ hostInstalled: true });
      expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
      expect(changes).toEqual(["same-host"]);

      // ONE failed probe against a live process changes nothing the renderer
      // can see. This assertion used to demand `null` - and that is the
      // 2026-08-11 outage in one line: a single unanswered loopback probe
      // telling the renderer a host it was actively using no longer exists.
      reachable = false;
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()?.availability).toBe("available");
      expect(changes).toEqual(["same-host"]);

      // The SECOND consecutive failure is corroboration, so the verdict
      // degrades - to `busy`, never to absence. The host is still named, still
      // carries its real websocketUrl, and stays dialable throughout.
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()?.availability).toBe("busy");
      expect(lifecycle.getSnapshot()?.websocketUrl).toBe(websocketUrl);
      expect(changes).toEqual(["same-host", "same-host"]);

      // Recovery takes exactly one success and no app relaunch.
      reachable = true;
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()?.availability).toBe("available");
      expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
      expect(changes).toEqual(["same-host", "same-host", "same-host"]);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
