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
        lifecycle.bootstrap(),
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
        lifecycle.bootstrap(),
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
        lifecycle.bootstrap(),
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
        lifecycle.bootstrap(),
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
        lifecycle.bootstrap(),
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
        lifecycle.bootstrap(),
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

  it("forced reload emits null for unchanged unreachable pid metadata and restores the same host id when it is reachable again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
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
      await lifecycle.bootstrap();
      expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
      expect(changes).toEqual(["same-host"]);

      reachable = false;
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()).toBeNull();
      expect(changes).toEqual(["same-host", null]);

      reachable = true;
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
      expect(lifecycle.getSnapshot()?.websocketUrl).toBe(websocketUrl);
      expect(changes).toEqual(["same-host", null, "same-host"]);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
