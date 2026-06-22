import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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

function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
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

// `HostLifecycle` shells out to the CLI for `respawn` (`traycer host
// restart`). Mock the helper so a test exercising that path can assert
// on the captured argv without spawning a real CLI subprocess.
const cliStreamCalls: { args: readonly string[] }[] = [];
vi.mock("../../cli/traycer-cli", () => ({
  streamTraycerCliJson: vi.fn(async (opts: { args: readonly string[] }) => {
    cliStreamCalls.push({ args: opts.args });
    return { data: {} };
  }),
}));

import {
  HostLifecycle,
  isCurrentHostWebsocketUrl,
  PRODUCTION_LABEL,
  readPidMetadata,
} from "../host-lifecycle";
import { DEV_LABEL } from "../host-paths";
import { config } from "../../../config";

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
      expect(errors).toEqual([]);
      const snapshot = lifecycle.getSnapshot();
      expect(snapshot?.pid).toBe(12345);
      expect(snapshot?.version).toBe(config.version);
    } finally {
      lifecycle.dispose();
      server.close();
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
      environment: "production" as const,
    };
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
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

  // Unified flow (Tech Plan Decision 8): production is no longer exempt from
  // the build-identity gate. A reachable host whose stamp differs from this
  // build is nulled (HOST_NOT_READY), exactly like dev/staging, so the ensure
  // flow runs - the CLI busy probe then keeps it if it has work in progress, or
  // restarts it if idle. (Previously, ticket 676fa92d accepted any version in
  // production via the hotfix model; that exemption is removed.)
  it("rejects a reachable host whose stamp differs from config.version in production (unified flow)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      environment: "production" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "mismatch-host",
        websocketUrl: `ws://127.0.0.1:${port}/rpc`,
        version: `${config.version}-mismatch`,
        pid: 12345,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
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
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Dogfood build-identity gate (dev/staging only): a reachable host whose
  // published stamp differs from this build's `config.version` is treated as
  // not-ready so the host gate reinstalls + restarts it. This catches the
  // reinstall-without-uninstall protocol-mismatch case during development.
  it("rejects a reachable host whose stamp differs from config.version on a non-production slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      environment: "dev" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "stale-host",
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
      // The stale host is reachable but its stamp does not match, so it is
      // not accepted - bootstrap times out into HOST_NOT_READY.
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("HOST_NOT_READY");
      expect(lifecycle.getSnapshot()).toBeNull();
    } finally {
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // host-busy keep path: when the CLI reports the host busy, the desktop
  // calls `tolerateStampMismatch()` so the stamp gate yields and the (busy,
  // mismatched) host is surfaced to the renderer for its compat probe -
  // instead of being nulled, which would trigger a reinstall + restart.
  it("tolerateStampMismatch surfaces a reachable but stamp-mismatched host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      environment: "dev" as const,
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
      label: DEV_LABEL,
      readyTimeoutMs: 5_000,
    });
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      lifecycle.tolerateStampMismatch(`${config.version}-stale`);
      await Promise.race([
        lifecycle.bootstrap(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);
      // The mismatched host is surfaced (not nulled) so the renderer can
      // connect and probe it; no HOST_NOT_READY error fires.
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.hostId).toBe("busy-mismatched-host");
      expect(lifecycle.getSnapshot()?.version).toBe(`${config.version}-stale`);
    } finally {
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Unified flow (Decision 8) end-to-end in PRODUCTION: production is no longer
  // exempt from the stamp gate, yet a busy mismatched host the CLI kept is
  // still surfaced (not nulled) for the renderer's compat probe - the same as
  // dev/staging. This is the headline "same flow on all environments" behavior,
  // so it is pinned with a production layout specifically.
  it("tolerateStampMismatch surfaces a stamp-mismatched host in PRODUCTION too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
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
    });
    const errors: { code: string }[] = [];
    lifecycle.on("error", (err) => errors.push({ code: err.code }));
    try {
      lifecycle.tolerateStampMismatch(`${config.version}-stale`);
      // reloadSnapshotFromDisk returns the snapshot it derived; the desktop
      // judges "surfaced" off this return rather than a racy getSnapshot().
      const surfaced = await lifecycle.reloadSnapshotFromDisk();
      expect(surfaced?.hostId).toBe("busy-mismatched-host");
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.hostId).toBe("busy-mismatched-host");
    } finally {
      lifecycle.dispose();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The tolerance is consumed when the tolerated host leaves: a later flap of
  // the SAME stale version is gated again instead of being surfaced without a
  // fresh busy check, so a one-shot keep never lingers for the whole process.
  it("stops tolerating once the tolerated host leaves, gating a later flap of the same version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      environment: "dev" as const,
    };
    const { server, port } = await listenOnEphemeralPort();
    const staleMeta = JSON.stringify({
      hostId: "flappy-host",
      websocketUrl: `ws://127.0.0.1:${port}/rpc`,
      version: `${config.version}-stale`,
      pid: 12345,
    });
    await writeFile(layout.pidMetadataFile, staleMeta, "utf8");
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: DEV_LABEL,
      readyTimeoutMs: 5_000,
    });
    try {
      lifecycle.tolerateStampMismatch(`${config.version}-stale`);
      expect((await lifecycle.reloadSnapshotFromDisk())?.hostId).toBe(
        "flappy-host",
      );
      // The tolerated host exits (pid.json removed): the reload clears the
      // tolerance.
      await rm(layout.pidMetadataFile, { force: true });
      expect(await lifecycle.reloadSnapshotFromDisk()).toBeNull();
      // The same stale version flaps back. The one-shot tolerance was consumed
      // when it left, so it is gated (nulled) now, not silently surfaced.
      await writeFile(layout.pidMetadataFile, staleMeta, "utf8");
      expect(await lifecycle.reloadSnapshotFromDisk()).toBeNull();
    } finally {
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
      expect(errors).toEqual([]);
      expect(lifecycle.getSnapshot()?.version).toBe(config.version);
    } finally {
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
      environment: "production" as const,
    };
    const initialListener = await listenOnEphemeralPort();
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "same-host",
        websocketUrl: `ws://127.0.0.1:${initialListener.port}/rpc`,
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
    });
    const changes: Array<string | null> = [];
    lifecycle.on("change", (snapshot) => {
      changes.push(snapshot?.hostId ?? null);
    });
    try {
      await lifecycle.bootstrap();
      expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
      expect(changes).toEqual(["same-host"]);

      await closeServer(initialListener.server);
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()).toBeNull();
      expect(changes).toEqual(["same-host", null]);

      const restartedListener = await listenOnPort(initialListener.port);
      try {
        await lifecycle.reloadSnapshotFromDisk();
        expect(lifecycle.getSnapshot()?.hostId).toBe("same-host");
        expect(lifecycle.getSnapshot()?.websocketUrl).toBe(
          `ws://127.0.0.1:${initialListener.port}/rpc`,
        );
        expect(changes).toEqual(["same-host", null, "same-host"]);
      } finally {
        await closeServer(restartedListener);
      }
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("HostLifecycle.getServiceStatus", () => {
  it("reads PID metadata rather than consulting a platform service-manager dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    const layout = {
      rootDir: dir,
      pidMetadataFile: join(dir, "host.pid.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      environment: "production" as const,
    };
    await writeFile(
      layout.pidMetadataFile,
      JSON.stringify({
        hostId: "live-host",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        version: "1.2.3",
        pid: 77777,
      }),
      "utf8",
    );
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 5_000,
    });
    try {
      const status = await lifecycle.getServiceStatus();
      expect(status.state).toBe("running");
      expect(status.version).toBe("1.2.3");
      expect(status.pid).toBe(77777);
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("HostLifecycle.respawn (CLI subprocess)", () => {
  // Ticket 7c890b39: user-driven restart now delegates to
  // `traycer host restart` via CLI subprocess.

  function makeChannelLifecycleForChannel(environment: "production" | "dev"): {
    lifecycle: HostLifecycle;
    cleanup: () => Promise<void>;
  } {
    const tmp = mkdtemp(join(tmpdir(), "lifecycle-test-"));
    return {
      lifecycle: new HostLifecycle({
        layout: {
          rootDir: "/tmp/no-such-dir",
          pidMetadataFile: "/tmp/no-such-dir/pid.json",
          logFile: "/tmp/no-such-dir/host.log",
          installDir: "/tmp/no-such-dir/install",
          installRecordFile: "/tmp/no-such-dir/install/install.json",
          environment,
        },
        bundledBinaryPath: null,
        label: environment === "dev" ? DEV_LABEL : PRODUCTION_LABEL,
        // Short timeout - `respawn` calls `waitForReady` after the CLI
        // step and we don't want the test to block waiting for pid.json.
        readyTimeoutMs: 50,
      }),
      cleanup: async () => {
        await tmp.then((d) => rm(d, { recursive: true, force: true }));
      },
    };
  }

  it("shells out to `traycer host restart`", async () => {
    cliStreamCalls.length = 0;
    const { lifecycle, cleanup } = makeChannelLifecycleForChannel("production");
    // `respawn()` ends with a `waitForReady` against a deliberately
    // missing pid.json so the lifecycle emits a `HOST_NOT_READY`
    // error after the CLI step. Subscribe a no-op listener so
    // EventEmitter does not throw the unhandled `error` event - the
    // assertion here is purely about which CLI args were issued.
    lifecycle.on("error", () => undefined);
    try {
      await lifecycle.respawn();
      expect(cliStreamCalls).toHaveLength(1);
      // No --environment - the CLI resolves its slot from config.environment.
      expect(cliStreamCalls[0]?.args).toEqual(["host", "restart"]);
    } finally {
      lifecycle.dispose();
      await cleanup();
    }
  });

  it("shells out to `traycer host restart` for the dev label", async () => {
    cliStreamCalls.length = 0;
    const { lifecycle, cleanup } = makeChannelLifecycleForChannel("dev");
    // See sibling test - pid.json is intentionally absent, so the
    // post-CLI `waitForReady` emits a `HOST_NOT_READY` error.
    lifecycle.on("error", () => undefined);
    try {
      await lifecycle.respawn();
      expect(cliStreamCalls).toHaveLength(1);
      // No --environment - the CLI resolves its slot from config.environment.
      expect(cliStreamCalls[0]?.args).toEqual(["host", "restart"]);
    } finally {
      lifecycle.dispose();
      await cleanup();
    }
  });
});
