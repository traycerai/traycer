import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents, WebPreferences } from "electron";

const { sessions, createdListeners, gate, registered } = vi.hoisted(() => ({
  sessions: new Map<string, object>(),
  createdListeners: [] as Array<(event: unknown, contents: unknown) => void>,
  gate: {
    calls: [] as number[],
    disposers: [] as Array<() => void>,
  },
  registered: [] as number[],
}));

vi.mock("electron", () => ({
  app: {
    getPath: (): string => "/tmp/traycer-desktop-test",
    on: (
      event: string,
      listener: (event: unknown, contents: unknown) => void,
    ): void => {
      if (event === "web-contents-created") createdListeners.push(listener);
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

vi.mock("../browser-session", () => ({
  ensureBrowserViewSessionForPartition: (partition: string): object => {
    const existing = sessions.get(partition);
    if (existing !== undefined) return existing;
    const session = { partition };
    sessions.set(partition, session);
    return session;
  },
  gateBrowserViewGuestRequests: (webContentsId: number): (() => void) => {
    const dispose = vi.fn();
    gate.calls.push(webContentsId);
    gate.disposers.push(dispose);
    return dispose;
  },
  registerBrowserViewWebContents: (webContents: {
    readonly id: number;
  }): void => {
    registered.push(webContents.id);
  },
}));

import { ensureBrowserViewSessionForPartition } from "../browser-session";
import {
  clearAllAttachmentGrants,
  installWebviewAttachGuards,
  mintAttachmentGrant,
  releaseAttachmentGrant,
} from "../webview-guest-birth";

const WINDOW_A = "window-a";
const WINDOW_B = "window-b";
const PARTITION = "persist:traycer-test";

type TestPrefs = WebPreferences & { disablePopups?: boolean };

class FakeHost extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

class FakeGuest extends EventEmitter {
  type = "webview";
  destroyed = false;
  close = vi.fn((): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  });

  constructor(
    readonly id: number,
    public hostWebContents: FakeHost | null,
    public session: object,
  ) {
    super();
  }

  getType(): string {
    return this.type;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function sessionFor(partition: string): object {
  return ensureBrowserViewSessionForPartition(partition);
}

function attachedOk(): Promise<void> {
  return Promise.resolve();
}

function lastDispose(): () => void {
  const dispose = gate.disposers.at(-1);
  if (dispose === undefined) throw new Error("gate disposer missing");
  return dispose;
}

function hostFor(id: number, windowId: string): FakeHost {
  const host = new FakeHost(id);
  installWebviewAttachGuards(host as WebContents, windowId);
  return host;
}

function mintGranted(
  windowId: string,
  onAttached: (guest: WebContents) => Promise<void>,
  onExpired: ((release: { registrationId: string }) => void) | null,
) {
  return mintAttachmentGrant({
    windowId,
    partition: PARTITION,
    onAttached,
    onExpired,
  });
}

function mint(
  windowId: string,
  onAttached: (guest: WebContents) => Promise<void>,
  onExpired: ((release: { registrationId: string }) => void) | null,
) {
  return mintGranted(windowId, onAttached, onExpired).mount;
}

function prefs(): TestPrefs {
  return {
    preload: "file:///evil.js",
    additionalArguments: ["--evil"],
    enableBlinkFeatures: "Evil",
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    sandbox: false,
    contextIsolation: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    webviewTag: true,
  };
}

function willAttach(
  host: FakeHost,
  registrationId: string,
  extraPrefs: Partial<TestPrefs>,
  extraParams: Record<string, string>,
) {
  const webPreferences = { ...prefs(), ...extraPrefs };
  const params = {
    src: `about:blank#${registrationId}`,
    partition: PARTITION,
    ...extraParams,
  };
  const event = { preventDefault: vi.fn() };
  host.emit("will-attach-webview", event, webPreferences, params);
  return { event, webPreferences };
}

function bind(host: FakeHost, registrationId: string, guest: FakeGuest): void {
  const { event } = willAttach(host, registrationId, {}, {});
  expect(event.preventDefault).not.toHaveBeenCalled();
  for (const listener of createdListeners) listener({}, guest);
  expect(gate.calls.at(-1)).toBe(guest.id);
}

afterEach(() => {
  clearAllAttachmentGrants();
  sessions.clear();
  gate.calls.length = 0;
  gate.disposers.length = 0;
  registered.length = 0;
  vi.useRealTimers();
});

describe("webview guest birth", () => {
  it("hardens guest webPreferences and does not gate on mint", () => {
    const host = hostFor(1, WINDOW_A);
    const mount = mint(WINDOW_A, attachedOk, null);
    const { event, webPreferences } = willAttach(
      host,
      mount.registrationId,
      {},
      {},
    );

    expect(gate.calls).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(webPreferences).toEqual(
      expect.objectContaining({
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        partition: PARTITION,
        disablePopups: true,
      }),
    );
    expect(webPreferences.preload).toBeUndefined();
    expect(webPreferences.additionalArguments).toBeUndefined();
    expect(webPreferences.enableBlinkFeatures).toBeUndefined();
  });

  it("consumes partition and did-attach type/host/session mismatch; does not consume no-grant, wrong-window or an unnamed src", () => {
    const hostA = hostFor(1, WINDOW_A);
    const hostB = hostFor(2, WINDOW_B);

    const noGrant = mint(WINDOW_A, attachedOk, null);
    expect(
      willAttach(hostA, "missing", {}, {}).event.preventDefault,
    ).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(noGrant.registrationId)).toEqual({
      registrationId: noGrant.registrationId,
      windowId: WINDOW_A,
    });

    const wrongWindow = mint(WINDOW_A, attachedOk, null);
    expect(
      willAttach(hostB, wrongWindow.registrationId, {}, {}).event
        .preventDefault,
    ).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(wrongWindow.registrationId)).toEqual({
      registrationId: wrongWindow.registrationId,
      windowId: WINDOW_A,
    });

    const badSrc = mint(WINDOW_A, attachedOk, null);
    expect(
      willAttach(hostA, badSrc.registrationId, {}, { src: "https://evil/" })
        .event.preventDefault,
    ).toHaveBeenCalledOnce();
    // A src outside `about:blank#…` names no grant at all, so the mint the
    // renderer was handed is still live until its TTL.
    expect(releaseAttachmentGrant(badSrc.registrationId)).toEqual({
      registrationId: badSrc.registrationId,
      windowId: WINDOW_A,
    });

    const badPartition = mint(WINDOW_A, attachedOk, null);
    expect(
      willAttach(
        hostA,
        badPartition.registrationId,
        { partition: "persist:evil" },
        {},
      ).event.preventDefault,
    ).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(badPartition.registrationId)).toBeNull();

    const mismatches: Array<(guest: FakeGuest) => void> = [
      (guest) => {
        guest.session = sessionFor("persist:evil");
      },
      (guest) => {
        guest.type = "window";
      },
      (guest) => {
        guest.hostWebContents = new FakeHost(99);
      },
    ];
    for (const [index, tweak] of mismatches.entries()) {
      const onAttached = vi.fn(attachedOk);
      const mount = mint(WINDOW_A, onAttached, null);
      const guest = new FakeGuest(10 + index, hostA, sessionFor(PARTITION));
      bind(hostA, mount.registrationId, guest);
      expect(registered).toEqual([]);
      tweak(guest);
      hostA.emit("did-attach-webview", {}, guest);
      expect(onAttached).not.toHaveBeenCalled();
      expect(registered).not.toContain(guest.id);
      expect(guest.close).toHaveBeenCalledOnce();
      expect(lastDispose()).toHaveBeenCalledOnce();
      expect(releaseAttachmentGrant(mount.registrationId)).toBeNull();
    }
  });

  it("calls onAttached once on did-attach, not on web-contents-created", async () => {
    const host = hostFor(1, WINDOW_A);
    const onAttached = vi.fn(async (attachedGuest: WebContents) => {
      expect(registered).toEqual([attachedGuest.id]);
    });
    const mount = mint(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(11, host, sessionFor(PARTITION));

    expect(gate.calls).toEqual([]);
    bind(host, mount.registrationId, guest);
    expect(registered).toEqual([]);
    expect(onAttached).not.toHaveBeenCalled();
    expect(lastDispose()).not.toHaveBeenCalled();

    host.emit("did-attach-webview", {}, guest);
    expect(onAttached).toHaveBeenCalledOnce();
    expect(onAttached).toHaveBeenCalledWith(guest);
    expect(registered).toEqual([guest.id]);
    host.emit("did-attach-webview", {}, guest);
    expect(onAttached).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(guest.close).not.toHaveBeenCalled();
  });

  it("timeout, release, and host reset close the exact guest", () => {
    vi.useFakeTimers();
    const host = hostFor(1, WINDOW_A);

    const onExpired = vi.fn();
    const timed = mint(WINDOW_A, attachedOk, onExpired);
    const timedGuest = new FakeGuest(21, host, sessionFor(PARTITION));
    bind(host, timed.registrationId, timedGuest);
    vi.runAllTimers();
    expect(onExpired).toHaveBeenCalledWith({
      registrationId: timed.registrationId,
    });
    expect(timedGuest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(timed.registrationId)).toBeNull();

    const released = mint(WINDOW_A, attachedOk, null);
    const releasedGuest = new FakeGuest(22, host, sessionFor(PARTITION));
    bind(host, released.registrationId, releasedGuest);
    expect(releaseAttachmentGrant(released.registrationId)).toEqual({
      registrationId: released.registrationId,
      windowId: WINDOW_A,
    });
    expect(releasedGuest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();

    const reset = mint(WINDOW_A, attachedOk, null);
    const resetGuest = new FakeGuest(23, host, sessionFor(PARTITION));
    bind(host, reset.registrationId, resetGuest);
    host.emit("did-start-navigation", {}, "app://renderer/", false, true);
    expect(resetGuest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(reset.registrationId)).toBeNull();
  });

  it("does not let a late did-attach steal a later birth", () => {
    vi.useFakeTimers();
    const host = hostFor(1, WINDOW_A);
    const onA = vi.fn(attachedOk);
    const onB = vi.fn(attachedOk);
    const mountA = mint(WINDOW_A, onA, vi.fn());
    const guestA = new FakeGuest(31, host, sessionFor(PARTITION));
    bind(host, mountA.registrationId, guestA);
    vi.runAllTimers();
    expect(guestA.close).toHaveBeenCalledOnce();

    const mountB = mint(WINDOW_A, onB, null);
    const guestB = new FakeGuest(32, host, sessionFor(PARTITION));
    bind(host, mountB.registrationId, guestB);
    host.emit("did-attach-webview", {}, guestA);
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
    expect(guestB.close).not.toHaveBeenCalled();

    host.emit("did-attach-webview", {}, guestB);
    expect(onB).toHaveBeenCalledOnce();
    expect(onB).toHaveBeenCalledWith(guestB);
  });

  it("drops on onAttached throw", () => {
    const host = hostFor(1, WINDOW_A);
    const onAttached = vi.fn((): Promise<void> => {
      throw new Error("attach failed");
    });
    const mount = mint(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(41, host, sessionFor(PARTITION));
    bind(host, mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    expect(onAttached).toHaveBeenCalledOnce();
    expect(guest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(mount.registrationId)).toBeNull();
  });

  it("drops on onAttached reject", async () => {
    const host = hostFor(1, WINDOW_A);
    const onAttached = vi.fn((): Promise<void> =>
      Promise.reject(new Error("attach failed")),
    );
    const mount = mint(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(42, host, sessionFor(PARTITION));
    bind(host, mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    await Promise.resolve();
    expect(guest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(mount.registrationId)).toBeNull();
  });

  it("keeps a pending onAttached gated until timeout", () => {
    vi.useFakeTimers();
    const host = hostFor(1, WINDOW_A);
    const onExpired = vi.fn();
    const onAttached = vi.fn((): Promise<void> => new Promise(() => {}));
    const mount = mint(WINDOW_A, onAttached, onExpired);
    const guest = new FakeGuest(43, host, sessionFor(PARTITION));
    bind(host, mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    expect(onAttached).toHaveBeenCalledOnce();
    expect(guest.close).not.toHaveBeenCalled();
    expect(lastDispose()).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(onExpired).toHaveBeenCalledWith({
      registrationId: mount.registrationId,
    });
    expect(guest.close).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(mount.registrationId)).toBeNull();
  });

  it("disposes the gate on onAttached resolve and keeps the guest until release", async () => {
    const host = hostFor(1, WINDOW_A);
    const onAttached = vi.fn(attachedOk);
    const mount = mint(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(44, host, sessionFor(PARTITION));
    bind(host, mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    await Promise.resolve();
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(guest.close).not.toHaveBeenCalled();
    expect(releaseAttachmentGrant(mount.registrationId)).toEqual({
      registrationId: mount.registrationId,
      windowId: WINDOW_A,
    });
    expect(guest.close).toHaveBeenCalledOnce();
  });

  it("denies replay of a ready guest without closing", async () => {
    const host = hostFor(1, WINDOW_A);
    const onAttached = vi.fn(attachedOk);
    const mount = mint(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(45, host, sessionFor(PARTITION));
    bind(host, mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    await Promise.resolve();
    expect(onAttached).toHaveBeenCalledOnce();
    expect(lastDispose()).toHaveBeenCalledOnce();

    expect(
      willAttach(host, mount.registrationId, {}, {}).event.preventDefault,
    ).toHaveBeenCalledOnce();
    expect(guest.close).not.toHaveBeenCalled();
    expect(onAttached).toHaveBeenCalledOnce();
    expect(releaseAttachmentGrant(mount.registrationId)).toEqual({
      registrationId: mount.registrationId,
      windowId: WINDOW_A,
    });
    expect(guest.close).toHaveBeenCalledOnce();
  });

  it("fulfills ready only after did-attach, onAttached resolve, and gate dispose", async () => {
    const host = hostFor(1, WINDOW_A);
    const attached = Promise.withResolvers<void>();
    const onAttached = vi.fn(() => attached.promise);
    const granted = mintGranted(WINDOW_A, onAttached, null);
    const guest = new FakeGuest(50, host, sessionFor(PARTITION));
    let readyDone = false;
    void granted.ready.then(() => {
      readyDone = true;
    });

    bind(host, granted.mount.registrationId, guest);
    host.emit("did-attach-webview", {}, guest);
    await Promise.resolve();
    expect(onAttached).toHaveBeenCalledOnce();
    expect(onAttached).toHaveBeenCalledWith(guest);
    expect(readyDone).toBe(false);
    expect(lastDispose()).not.toHaveBeenCalled();

    attached.resolve();
    await granted.ready;
    expect(readyDone).toBe(true);
    expect(lastDispose()).toHaveBeenCalledOnce();
    expect(guest.close).not.toHaveBeenCalled();
  });

  it("rejects ready on timeout and on drop", async () => {
    vi.useFakeTimers();
    const timed = mintGranted(WINDOW_A, attachedOk, null);
    vi.runAllTimers();
    await expect(timed.ready).rejects.toThrow("webview guest birth failed");

    vi.useRealTimers();
    const dropped = mintGranted(WINDOW_A, attachedOk, null);
    expect(releaseAttachmentGrant(dropped.mount.registrationId)).toEqual({
      registrationId: dropped.mount.registrationId,
      windowId: WINDOW_A,
    });
    await expect(dropped.ready).rejects.toThrow("webview guest birth failed");
  });
});
