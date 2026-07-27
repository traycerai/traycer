import { describe, expect, it, vi } from "vitest";
import type {
  HostInstallResult,
  LocalHostSnapshot,
} from "../../platform/runner-host";
import { mockLocalHostEntry } from "../mock/mock-host-directory";
import { MockRunnerHost } from "../mock/mock-runner-host";

function makeSnapshot(hostId: string): LocalHostSnapshot {
  return {
    hostId,
    websocketUrl: `ws://127.0.0.1:4917/${hostId}`,
    version: "0.0.0-mock",
    pid: 4242,
    systemHostName: hostId,
    displayName: hostId,
  };
}

describe("MockRunnerHost - IRunnerHost contract", () => {
  it("emits the current local-host snapshot synchronously on subscribe", () => {
    const snapshot = makeSnapshot("mock-1");
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: snapshot,
      hosts: [mockLocalHostEntry],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const handler = vi.fn();
    const subscription = host.onLocalHostChange(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(snapshot);

    subscription.dispose();
  });

  it("emits `null` synchronously when no local host is present", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const handler = vi.fn();
    host.onLocalHostChange(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(null);
  });

  it("forwards subsequent local-host transitions to live subscribers", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const handler = vi.fn();
    host.onLocalHostChange(handler);
    handler.mockClear();

    const snapshot = makeSnapshot("mock-2");
    host.setLocalHost(snapshot);
    host.setLocalHost(null);

    expect(handler).toHaveBeenNthCalledWith(1, snapshot);
    expect(handler).toHaveBeenNthCalledWith(2, null);
  });

  it("stops delivering transitions once the subscription is disposed", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const handler = vi.fn();
    const subscription = host.onLocalHostChange(handler);
    subscription.dispose();
    handler.mockClear();

    host.setLocalHost(makeSnapshot("mock-3"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("fans out the payload-free browser-return signal to every subscriber", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const handler = vi.fn();
    host.onAuthCallback(handler);

    host.emitAuthCallback();
    host.emitAuthCallback();

    // Payload-free: it only signals "the browser returned"; the device poll
    // carries the token, not this callback.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1);
  });

  it("tracks hostPicker open/close/onChange transitions", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const onChange = vi.fn();
    host.hostPicker.onChange(onChange);

    expect(host.hostPicker.isOpen).toBe(false);

    host.hostPicker.requestOpen();
    expect(host.hostPicker.isOpen).toBe(true);
    expect(onChange).toHaveBeenNthCalledWith(1, true);

    // Repeated open is idempotent.
    host.hostPicker.requestOpen();
    expect(onChange).toHaveBeenCalledTimes(1);

    host.hostPicker.requestClose();
    expect(host.hostPicker.isOpen).toBe(false);
    expect(onChange).toHaveBeenNthCalledWith(2, false);

    host.hostPicker.requestClose();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("exposes no-op tray and notification surfaces that never fire", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    const traySelection = vi.fn();
    const notificationClick = vi.fn();
    host.tray.onEpicSelected(traySelection);
    host.notifications.onClick(notificationClick);

    await host.tray.setIndicator("attention");
    await host.tray.setEpics([
      { epicId: "e1", title: "Epic 1", subtitle: "2 hours ago" },
    ]);
    await host.notifications.show(
      "Title",
      "Body",
      { kind: "info" },
      null,
      "delivery-1",
    );

    expect(host.tray.indicator).toBe("attention");
    expect(host.tray.epics).toHaveLength(1);
    expect(host.notificationsSent).toEqual([
      {
        title: "Title",
        body: "Body",
        payload: { kind: "info" },
        replaceKey: null,
        deliveryKey: "delivery-1",
      },
    ]);
    expect(traySelection).not.toHaveBeenCalled();
    expect(notificationClick).not.toHaveBeenCalled();
  });

  it("persists secure-storage writes in memory across get/delete", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    await host.secureStorage.set("traycer.token", "tok");
    await expect(host.secureStorage.get("traycer.token")).resolves.toBe("tok");
    await host.secureStorage.delete("traycer.token");
    await expect(host.secureStorage.get("traycer.token")).resolves.toBe(null);
  });

  it("exposes a configurable mock host list", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [mockLocalHostEntry],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    expect(host.hosts).toEqual([mockLocalHostEntry]);
    host.setHosts([]);
    expect(host.hosts).toEqual([]);
  });

  it("returns configured workspace-folder picker selections", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: ["/tmp/project-a"],
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    await expect(host.workspaceFolders.pickFolders()).resolves.toEqual([
      "/tmp/project-a",
    ]);
    host.setWorkspaceFolderPickerPaths(["/tmp/project-b", "/tmp/project-c"]);
    await expect(host.workspaceFolders.pickFolders()).resolves.toEqual([
      "/tmp/project-b",
      "/tmp/project-c",
    ]);
  });

  it("does not expose a remoteHosts surface on the runner host", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [mockLocalHostEntry],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    expect("remoteHosts" in host).toBe(false);
  });

  it("round-trips the tokenStore through signIn/get/delete", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    await expect(host.tokenStore.get()).resolves.toBe(null);

    await host.tokenStore.signIn(
      { token: "foo", refreshToken: "foo-refresh" },
      { id: "u1", email: "u1@example.com", name: "U One" },
    );
    await expect(host.tokenStore.get()).resolves.toEqual({
      token: "foo",
      refreshToken: "foo-refresh",
      authnBaseUrl: "http://localhost:5005",
      savedAt: expect.any(String),
      user: { id: "u1", email: "u1@example.com", name: "U One" },
    });

    await host.tokenStore.delete();
    await expect(host.tokenStore.get()).resolves.toBe(null);
  });

  it("resolves requestHostRespawn and increments the test counter", async () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    expect(host.requestHostRespawnCalls).toBe(0);

    await expect(host.requestHostRespawn()).resolves.toBeUndefined();
    expect(host.requestHostRespawnCalls).toBe(1);

    await host.requestHostRespawn();
    expect(host.requestHostRespawnCalls).toBe(2);
  });

  it("reflects the authnBaseUrl option on the constructed host", () => {
    const host = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });

    expect(host.authnBaseUrl).toBe("https://authn.traycer.invalid");
  });
});

describe("HostInstallResult.serviceLifecycle.postSwapAction shape", () => {
  it("accepts the exact literal union the CLI emits and nothing else", () => {
    // Type-level regression: each literal must compile. Adding or removing a
    // member here without updating `IHostManagement.installHost` callers
    // will surface as a compile error.
    const all: ReadonlyArray<
      HostInstallResult["serviceLifecycle"]["postSwapAction"]
    > = ["install", "restart", "start", "none"];
    expect(all).toEqual(["install", "restart", "start", "none"]);
  });
});
