import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

type WatchListener = (event: string, filename: string | null) => void;

interface FakeWatcherHandle {
  readonly directory: string;
  readonly listener: WatchListener;
  readonly close: () => void;
}

const fsState = vi.hoisted(() => ({
  watchers: [] as FakeWatcherHandle[],
  pidFile: "",
  pidReads: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = (directory: string, listener: WatchListener): EventEmitter => {
    const emitter = new EventEmitter();
    fsState.watchers.push({
      directory,
      listener,
      close: () => undefined,
    });
    return Object.assign(emitter, { close: (): void => undefined });
  };
  return { ...actual, watch, default: { ...actual, watch } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (path: string, encoding: "utf8"): Promise<string> => {
    if (path === fsState.pidFile) fsState.pidReads += 1;
    return actual.readFile(path, encoding);
  };
  return { ...actual, readFile, default: { ...actual, readFile } };
});

vi.mock("node:tls", () => {
  const connect = vi.fn();
  return { connect, default: { connect } };
});

import { hostLifecyclePolicyPath } from "@traycer/protocol/config/host-lifecycle-policy";
import { supervisorRecordPath } from "@traycer/protocol/config/supervisor-record";
import { HostLifecycle, PRODUCTION_LABEL } from "../host-lifecycle";
import { freshHostFsLayout } from "./host-fs-layout-test-support";

const roots: string[] = [];
const lifecycles: HostLifecycle[] = [];

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  fsState.watchers.length = 0;
  fsState.pidFile = "";
  fsState.pidReads = 0;
});

async function newLifecycle(): Promise<{
  readonly lifecycle: HostLifecycle;
  readonly rootDir: string;
  readonly pidBasename: string;
}> {
  const layout = await freshHostFsLayout(roots, "lifecycle-records-watch-");
  fsState.pidFile = layout.pidMetadataFile;
  fsState.pidReads = 0;
  const lifecycle = new HostLifecycle({
    layout,
    bundledBinaryPath: null,
    label: PRODUCTION_LABEL,
    readyTimeoutMs: 1_000,
    reachabilityProbe: undefined,
  });
  lifecycles.push(lifecycle);
  return {
    lifecycle,
    rootDir: layout.rootDir,
    pidBasename: basename(layout.pidMetadataFile),
  };
}

function emitEdge(filename: string | null): void {
  const [handle] = fsState.watchers;
  if (handle === undefined) throw new Error("no watcher was installed");
  handle.listener("change", filename);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe("HostLifecycle.disableLocalHostTracking", () => {
  it("turns bootstrap, reload, endpoint-answered and respawn into no-ops that never read the pid file", async () => {
    const { lifecycle } = await newLifecycle();
    lifecycle.disableLocalHostTracking();

    await lifecycle.bootstrap({ hostInstalled: true });
    await lifecycle.reloadSnapshotFromDisk();
    lifecycle.noteEndpointAnswered();
    lifecycle.notifyRespawning();
    await settle();

    expect(lifecycle.getSnapshot()).toBeNull();
    expect(fsState.pidReads).toBe(0);
    // Bootstrap returned before it installed anything to watch.
    expect(fsState.watchers).toHaveLength(0);
  });

  it("positive control: an untouched instance reads the pid file on every one of those paths", async () => {
    const { lifecycle } = await newLifecycle();

    await lifecycle.bootstrap({ hostInstalled: false });
    const afterBootstrap = fsState.pidReads;
    expect(afterBootstrap).toBeGreaterThan(0);

    await lifecycle.reloadSnapshotFromDisk();
    const afterReload = fsState.pidReads;
    expect(afterReload).toBeGreaterThan(afterBootstrap);

    lifecycle.noteEndpointAnswered();
    await vi.waitFor(() => {
      expect(fsState.pidReads).toBeGreaterThan(afterReload);
    });
    expect(fsState.watchers).toHaveLength(1);
  });
});

describe("HostLifecycle.onLifecycleRecordsChanged", () => {
  it("fires on the policy, supervisor and pid records and on a null filename, and not on other files", async () => {
    const { lifecycle, rootDir, pidBasename } = await newLifecycle();
    const listener = vi.fn();
    lifecycle.onLifecycleRecordsChanged(listener);
    await lifecycle.watchLifecycleRecords();
    expect(fsState.watchers).toHaveLength(1);
    expect(fsState.watchers[0]?.directory).toBe(rootDir);

    const policyName = basename(hostLifecyclePolicyPath(rootDir));
    const supervisorName = basename(supervisorRecordPath(rootDir));
    expect(policyName).toBe("lifecycle-policy.json");
    expect(supervisorName).toBe("supervisor.json");

    emitEdge(policyName);
    expect(listener).toHaveBeenCalledTimes(1);
    emitEdge(supervisorName);
    expect(listener).toHaveBeenCalledTimes(2);
    emitEdge(pidBasename);
    expect(listener).toHaveBeenCalledTimes(3);
    emitEdge(null);
    expect(listener).toHaveBeenCalledTimes(4);

    emitEdge("host.log");
    emitEdge("unrelated.json");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("stops notifying an unsubscribed listener while a still-subscribed one keeps firing", async () => {
    const { lifecycle } = await newLifecycle();
    const removed = vi.fn();
    const kept = vi.fn();
    const unsubscribe = lifecycle.onLifecycleRecordsChanged(removed);
    lifecycle.onLifecycleRecordsChanged(kept);
    await lifecycle.watchLifecycleRecords();

    emitEdge("supervisor.json");
    expect(removed).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitEdge("supervisor.json");
    expect(removed).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it("installs one shared watcher however many times watchLifecycleRecords is called", async () => {
    const { lifecycle } = await newLifecycle();
    await lifecycle.watchLifecycleRecords();
    await lifecycle.watchLifecycleRecords();
    expect(fsState.watchers).toHaveLength(1);
    expect(dirname(fsState.pidFile)).toBe(fsState.watchers[0]?.directory);
  });
});

describe("HostLifecycle pid.json reload arming", () => {
  it("does not reload the snapshot on a pid.json edge when only watchLifecycleRecords installed the watcher", async () => {
    const { lifecycle, pidBasename } = await newLifecycle();
    const listener = vi.fn();
    lifecycle.onLifecycleRecordsChanged(listener);
    await lifecycle.watchLifecycleRecords();

    emitEdge(pidBasename);
    emitEdge(null);
    await settle();

    // The lifecycle-record listener heard both edges, so the watcher was live...
    expect(listener).toHaveBeenCalledTimes(2);
    // ...but the pid reload stayed disarmed.
    expect(fsState.pidReads).toBe(0);
  });

  it("reloads on a pid.json edge once bootstrap has armed the pid watch", async () => {
    const { lifecycle, pidBasename } = await newLifecycle();
    await lifecycle.bootstrap({ hostInstalled: false });
    fsState.pidReads = 0;

    emitEdge(pidBasename);
    await vi.waitFor(() => {
      expect(fsState.pidReads).toBeGreaterThan(0);
    });

    const afterPidEdge = fsState.pidReads;
    emitEdge("unrelated.json");
    await settle();
    expect(fsState.pidReads).toBe(afterPidEdge);
  });

  it("reloads on a pid.json edge once ensureWatcherInstalled armed a watcher installed earlier by watchLifecycleRecords", async () => {
    const { lifecycle, pidBasename } = await newLifecycle();
    await lifecycle.watchLifecycleRecords();

    emitEdge(pidBasename);
    await settle();
    expect(fsState.pidReads).toBe(0);

    lifecycle.ensureWatcherInstalled();
    // Still the single shared watcher; arming did not install a second one.
    expect(fsState.watchers).toHaveLength(1);

    emitEdge(pidBasename);
    await vi.waitFor(() => {
      expect(fsState.pidReads).toBeGreaterThan(0);
    });
  });

  it("does not arm the pid reload on a lifecycle whose local tracking is disabled", async () => {
    const { lifecycle, pidBasename } = await newLifecycle();
    lifecycle.disableLocalHostTracking();
    await lifecycle.watchLifecycleRecords();
    lifecycle.ensureWatcherInstalled();

    emitEdge(pidBasename);
    await settle();
    expect(fsState.pidReads).toBe(0);
  });
});
