import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
  },
  session: {
    defaultSession: {
      registerPreloadScript: vi.fn(),
    },
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info", resolvePathFn: null },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { ipcMain, session } from "electron";
import {
  parseDevSharedLocalStorageEntries,
  readDevSharedLocalStorageSnapshotSync,
  registerDevSharedLocalStorage,
  resolveDevSharedLocalStorageFilePath,
  resolveDevSharedLocalStorageSeedPreloadPath,
  writeDevSharedLocalStorageSnapshot,
  type LocalStorageSource,
} from "../dev-shared-local-storage";

async function tempFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-shared-local-storage-test-"));
  return join(dir, "local-storage.json");
}

// `devRendererOriginFromEnv` falls back to this when the test's `env` option
// (as with every test below except the origin-check ones) carries no
// `TRAYCER_DESKTOP_DEV_URL`.
const DEFAULT_DEV_RENDERER_ORIGIN = "http://localhost:5173";

interface FakeWebFrameMain {
  readonly url: string;
  readonly top: FakeWebFrameMain | null;
}

interface FakeSyncEvent {
  returnValue: unknown;
  readonly senderFrame: FakeWebFrameMain | null;
}

// A frame that is its own top (i.e. not embedded in another frame) - the
// shape `isTrustedDevRendererSender` requires of a legitimate top-level
// renderer window.
function frameWithSelfTop(origin: string): FakeWebFrameMain {
  const frame: { url: string; top: FakeWebFrameMain | null } = {
    url: `${origin}/`,
    top: null,
  };
  frame.top = frame;
  return frame;
}

function fakeSyncEvent(senderFrame: FakeWebFrameMain | null): FakeSyncEvent {
  return { returnValue: undefined, senderFrame };
}

function lastRegisteredSyncListener(): (event: FakeSyncEvent) => void {
  const [, listener] = vi.mocked(ipcMain.on).mock.calls.at(-1) ?? [];
  return listener as (event: FakeSyncEvent) => void;
}

describe("resolveDevSharedLocalStorageFilePath", () => {
  it("resolves under ~/.traycer/desktop/dev, parallel to cli/dev and host/dev", () => {
    expect(resolveDevSharedLocalStorageFilePath()).toBe(
      join(homedir(), ".traycer", "desktop", "dev", "local-storage.json"),
    );
  });
});

describe("resolveDevSharedLocalStorageSeedPreloadPath", () => {
  it("resolves as a sibling of the main bundle's own dist/preload dir", () => {
    const path = resolveDevSharedLocalStorageSeedPreloadPath();
    expect(path.endsWith(join("preload-dev-shared-storage", "index.js"))).toBe(
      true,
    );
  });
});

describe("parseDevSharedLocalStorageEntries", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      parseDevSharedLocalStorageEntries({
        version: 1,
        exportedBySlot: "some-slot",
        exportedAt: "2026-01-01T00:00:00.000Z",
        entries: { "traycer.token": "abc", "traycer-gui-app:settings": "{}" },
      }),
    ).toEqual({ "traycer.token": "abc", "traycer-gui-app:settings": "{}" });
  });

  it.each([
    ["null", null],
    ["a string", "not an object"],
    ["an array", []],
    ["missing version", { entries: {} }],
    ["wrong version", { version: 2, entries: {} }],
    ["missing entries", { version: 1 }],
    ["null entries", { version: 1, entries: null }],
    ["a non-string entry value", { version: 1, entries: { key: 123 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseDevSharedLocalStorageEntries(value)).toBeNull();
  });
});

describe("readDevSharedLocalStorageSnapshotSync", () => {
  it("returns null when the file is absent", async () => {
    const filePath = await tempFilePath();
    expect(readDevSharedLocalStorageSnapshotSync(filePath)).toBeNull();
  });

  it("returns null on corrupt JSON rather than throwing", async () => {
    const filePath = await tempFilePath();
    await writeFile(filePath, "{not json", "utf8");
    expect(readDevSharedLocalStorageSnapshotSync(filePath)).toBeNull();
  });

  it("round-trips entries written by writeDevSharedLocalStorageSnapshot", async () => {
    const filePath = await tempFilePath();
    const entries = { "traycer.token": "abc", theme: "dark" };
    await writeDevSharedLocalStorageSnapshot(filePath, "my-slot", entries);
    expect(readDevSharedLocalStorageSnapshotSync(filePath)).toEqual(entries);
  });

  it("writes atomically (no partial file left behind) and mode 0600", async () => {
    const filePath = await tempFilePath();
    await writeDevSharedLocalStorageSnapshot(filePath, "my-slot", { a: "b" });
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.exportedBySlot).toBe("my-slot");
    expect(parsed.entries).toEqual({ a: "b" });
  });
});

describe("registerDevSharedLocalStorage", () => {
  it("returns null and registers nothing when no DEV_DESKTOP_SLOT is set", async () => {
    const filePath = await tempFilePath();
    const handle = registerDevSharedLocalStorage({
      environment: "dev",
      env: {},
      filePath,
    });
    expect(handle).toBeNull();
    expect(ipcMain.on).not.toHaveBeenCalled();
    expect(session.defaultSession.registerPreloadScript).not.toHaveBeenCalled();
  });

  it("returns null for a non-dev environment even with a slot set", async () => {
    const filePath = await tempFilePath();
    const handle = registerDevSharedLocalStorage({
      environment: "production",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    expect(handle).toBeNull();
    expect(ipcMain.on).not.toHaveBeenCalled();
  });

  it("registers the sync IPC channel and the seed preload when a slot is active", async () => {
    const filePath = await tempFilePath();
    const handle = registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    expect(handle).not.toBeNull();
    expect(ipcMain.on).toHaveBeenCalledWith(
      "devSharedLocalStorage:sync:snapshot",
      expect.any(Function),
    );
    expect(session.defaultSession.registerPreloadScript).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "frame",
        id: "traycer-dev-shared-local-storage-seed",
      }),
    );
  });

  it("the registered sync handler serves the snapshot to the trusted dev renderer's top frame", async () => {
    const filePath = await tempFilePath();
    await writeDevSharedLocalStorageSnapshot(filePath, "sibling-slot", {
      "traycer.token": "inherited",
    });
    registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    const listener = lastRegisteredSyncListener();
    const event = fakeSyncEvent(frameWithSelfTop(DEFAULT_DEV_RENDERER_ORIGIN));
    listener(event);
    expect(event.returnValue).toEqual({ "traycer.token": "inherited" });
  });

  it("the sync handler withholds the snapshot from an untrusted sender", async () => {
    const filePath = await tempFilePath();
    await writeDevSharedLocalStorageSnapshot(filePath, "sibling-slot", {
      "traycer.token": "inherited",
    });
    registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    const listener = lastRegisteredSyncListener();

    // Wrong origin - a different frame that happens to share the session.
    const wrongOrigin = fakeSyncEvent(frameWithSelfTop("http://example.com/"));
    listener(wrongOrigin);
    expect(wrongOrigin.returnValue).toBeNull();

    // Right origin, but not its own top frame (an embedded sub-frame).
    const notTopFrame = fakeSyncEvent({
      url: DEFAULT_DEV_RENDERER_ORIGIN + "/",
      top: frameWithSelfTop(DEFAULT_DEV_RENDERER_ORIGIN),
    });
    listener(notTopFrame);
    expect(notTopFrame.returnValue).toBeNull();

    // No sender frame at all (disposed by the time the handler runs).
    const noSenderFrame = fakeSyncEvent(null);
    listener(noSenderFrame);
    expect(noSenderFrame.returnValue).toBeNull();

    // Regression: an unparsable frame URL (`new URL("/")` throws) must fail
    // closed rather than crash the ipcMain listener.
    const unparsableUrl = fakeSyncEvent(frameWithSelfTop(""));
    expect(() => listener(unparsableUrl)).not.toThrow();
    expect(unparsableUrl.returnValue).toBeNull();
  });

  it("flush() writes the dumped localStorage minus the seeded marker, skips a null webContents", async () => {
    const filePath = await tempFilePath();
    const handle = registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    expect(handle).not.toBeNull();

    // No live window yet - must no-op, not throw.
    await handle?.flush(() => null);
    expect(readDevSharedLocalStorageSnapshotSync(filePath)).toBeNull();

    const fakeWebContents: LocalStorageSource = {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(() =>
        Promise.resolve({
          "traycer.token": "abc",
          "traycer-desktop:dev-seeded": "1",
        }),
      ),
    };
    await handle?.flush(() => fakeWebContents);
    expect(readDevSharedLocalStorageSnapshotSync(filePath)).toEqual({
      "traycer.token": "abc",
    });
  });

  it("flush() skips the write when the dump is unchanged from the last export", async () => {
    const filePath = await tempFilePath();
    const handle = registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    const executeJavaScript = vi.fn(() =>
      Promise.resolve({ "traycer.token": "abc" }),
    );
    const fakeWebContents: LocalStorageSource = {
      isDestroyed: () => false,
      executeJavaScript,
    };
    const getWebContents = () => fakeWebContents;

    await handle?.flush(getWebContents);
    const firstRaw = await readFile(filePath, "utf8");

    await handle?.flush(getWebContents);
    const secondRaw = await readFile(filePath, "utf8");

    // Unchanged content: the file must not have been rewritten (exportedAt
    // would differ on a second write).
    expect(secondRaw).toBe(firstRaw);
  });
});

describe("writeDevSharedLocalStorageSnapshot concurrency and failure handling", () => {
  it("two concurrent writes to the same path never collide on the temp file", async () => {
    const filePath = await tempFilePath();
    await Promise.all([
      writeDevSharedLocalStorageSnapshot(filePath, "slot-a", { a: "1" }),
      writeDevSharedLocalStorageSnapshot(filePath, "slot-b", { b: "2" }),
    ]);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    // Last-write-wins is expected and fine (see the tech plan's concurrency
    // note) - what this guards against is either write throwing, or the file
    // being left corrupt/partial, because both picked the same temp path.
    expect(["slot-a", "slot-b"]).toContain(parsed.exportedBySlot);
  });

  it("flush() propagates a write failure - the periodic poller must catch it rather than let it surface as an unhandled rejection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-shared-local-storage-test-"));
    const blockerFile = join(dir, "blocker");
    await writeFile(blockerFile, "not a directory", "utf8");
    // dirname(filePath) === blockerFile, an existing regular file, so
    // writeDevSharedLocalStorageSnapshot's mkdir(dirname(filePath)) rejects.
    const filePath = join(blockerFile, "local-storage.json");
    const handle = registerDevSharedLocalStorage({
      environment: "dev",
      env: { DEV_DESKTOP_SLOT: "some-slot" },
      filePath,
    });
    const fakeWebContents: LocalStorageSource = {
      isDestroyed: () => false,
      executeJavaScript: vi.fn(() =>
        Promise.resolve({ "traycer.token": "abc" }),
      ),
    };
    await expect(handle?.flush(() => fakeWebContents)).rejects.toThrow();
  });
});
