import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { DesktopAppUpdateSnapshot } from "../../../ipc-contracts/app-update-types";

type UpdaterModule = typeof import("../updater");

class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  // electron-updater auto-derives this to `true` for a prerelease app version;
  // installAutoUpdater must force it back to `false`.
  allowPrerelease = true;
  readonly setFeedURL = vi.fn((_options: unknown): void => undefined);
  readonly checkForUpdates = vi.fn((): Promise<null> => Promise.resolve(null));
  readonly downloadUpdate = vi.fn((): Promise<string[]> => Promise.resolve([]));
  readonly quitAndInstall = vi.fn(
    (_isSilent: boolean, _isForceRunAfter: boolean): void => undefined,
  );
}

// Window-focus deps the updater needs. Default focused=true so the OS
// notification path stays dormant unless a test opts into the unfocused case.
function makeDeps(focused: boolean) {
  return {
    isAnyWindowFocused: () => focused,
    focusPrimaryWindow: vi.fn(),
    installBlockedReason: () => null,
  };
}

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

const originalPrivateUpdateRepo = process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO;
const originalPrivateUpdateToken =
  process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN;

beforeEach(() => {
  Reflect.deleteProperty(process.env, "VITE_TRAYCER_DESKTOP_UPDATE_REPO");
  Reflect.deleteProperty(process.env, "VITE_TRAYCER_DESKTOP_UPDATE_TOKEN");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/traycer-test-resources",
    writable: true,
  });
  // Default to macOS so the read-only-volume message mapping is exercised;
  // platform-specific tests override this.
  setPlatform("darwin");
});

afterEach(() => {
  if (originalResourcesPathDescriptor === undefined) {
    Reflect.deleteProperty(process, "resourcesPath");
  } else {
    Object.defineProperty(
      process,
      "resourcesPath",
      originalResourcesPathDescriptor,
    );
  }
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("electron");
  vi.doUnmock("electron-updater");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("../logger");
  vi.doUnmock("../linux-update-guidance");
  restoreEnvValue(
    "VITE_TRAYCER_DESKTOP_UPDATE_REPO",
    originalPrivateUpdateRepo,
  );
  restoreEnvValue(
    "VITE_TRAYCER_DESKTOP_UPDATE_TOKEN",
    originalPrivateUpdateToken,
  );
});

describe("desktop app updater", () => {
  it("does not override the generated update feed when no private token is baked", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("configures a private GitHub feed when the testing token is baked", async () => {
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO = "traycerai/private-traycer";
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN = "test-token";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "traycerai",
      repo: "private-traycer",
      private: true,
      token: "test-token",
    });
  });

  it("emits an error instead of staying stuck when a download fails", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "automatic");
    expect(updater.getAppUpdateSnapshot().status).toBe("available");

    updater.startUpdateDownload();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getAppUpdateSnapshot().status).toBe("downloading");

    autoUpdater.emit("error", new Error("download failed"));

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      downloadProgress: null,
      errorMessage:
        "Traycer ran into a problem while updating. Please try again in a little while.",
      // The download was user-initiated, so its failure is manual-intent.
      lastCheckIntent: "manual",
    });
  });

  it("does not start a second check when the user checks during a download", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    updater.startUpdateDownload();
    autoUpdater.checkForUpdates.mockClear();

    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "downloading",
      lastCheckIntent: "manual",
    });
  });

  it("lets a manual click claim an in-flight automatic check result", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const checkControl: { finish: (() => void) | null } = { finish: null };
    autoUpdater.checkForUpdates.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          checkControl.finish = () => resolve(null);
        }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    const automaticCheck = updater.checkForUpdatesNow(false, "automatic");
    await flushPromises();
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit("update-not-available", { version: "1.0.0" });
    const finishCheck = checkControl.finish;
    if (finishCheck === null) {
      throw new Error("Expected the update check to be in flight");
    }
    finishCheck();
    await automaticCheck;

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "up-to-date",
      lastCheckIntent: "manual",
    });
  });

  it("emits ready feedback for a manual check after an update is downloaded", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    const previousSequence = updater.getAppUpdateSnapshot().sequence;

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      sequence: previousSequence + 1,
      status: "ready",
      lastCheckIntent: "manual",
    });
  });

  it("does not flag an update install before the user requests a restart", async () => {
    const { updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));

    expect(updater.isInstallingUpdate()).toBe(false);
  });

  it("flags an in-progress install once a ready update is restarted", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    expect(updater.getAppUpdateSnapshot().status).toBe("ready");
    expect(updater.isInstallingUpdate()).toBe(false);

    updater.installDownloadedUpdate();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(updater.isInstallingUpdate()).toBe(true);
  });

  it("surfaces an install failure that arrives after the user chose Restart", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    updater.installDownloadedUpdate();
    expect(updater.isInstallingUpdate()).toBe(true);

    // quitAndInstall fails asynchronously (e.g. macOS read-only volume). This
    // must NOT be swallowed by the "ready" guard - the user needs feedback and
    // a chance to retry.
    autoUpdater.emit(
      "error",
      new Error("Cannot update while running on a read-only volume."),
    );

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage:
        "Move Traycer to your Applications folder to install updates.",
    });
    expect(updater.isInstallingUpdate()).toBe(false);
  });

  it("does not show the macOS 'move to Applications' message off macOS", async () => {
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    updater.installDownloadedUpdate();

    autoUpdater.emit(
      "error",
      new Error("Cannot update while running on a read-only volume."),
    );

    const message = updater.getAppUpdateSnapshot().errorMessage ?? "";
    expect(message).not.toContain("Applications folder");
    expect(updater.getAppUpdateSnapshot().status).toBe("error");
  });

  it("does not flag an install when no update is ready to restart", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));

    updater.installDownloadedUpdate();

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.isInstallingUpdate()).toBe(false);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage: "No downloaded update is ready to install.",
    });
  });

  it("emits one error snapshot when electron-updater both emits and rejects", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const snapshots: DesktopAppUpdateSnapshot[] = [];
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("error", new Error("feed failed"));
      return Promise.reject(new Error("feed failed"));
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    updater.onAppUpdateChange((snapshot) => {
      snapshots.push(snapshot);
    });

    await updater.checkForUpdatesNow(false, "manual");

    expect(
      snapshots.filter((snapshot) => snapshot.status === "error"),
    ).toHaveLength(1);
  });

  it("does not expose raw GitHub feed 404 details in manual-check feedback", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const rawGitHubError =
      '404 "method: GET url: https://github.com/traycerai/traycer/releases.atom\\n\\nPlease double check that your authentication token is correct." Headers: { "set-cookie": [ "_gh_sess=secret" ] }';
    autoUpdater.checkForUpdates.mockRejectedValue(new Error(rawGitHubError));
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage:
        "Traycer couldn't reach the update service right now. Please try again in a little while.",
      lastCheckIntent: "manual",
    });
    const leakedMessage = updater.getAppUpdateSnapshot().errorMessage ?? "";
    expect(leakedMessage).not.toContain("set-cookie");
    expect(leakedMessage).not.toContain("authentication token");
    expect(leakedMessage).not.toContain("releases.atom");
    expect(leakedMessage).not.toContain("github.com");
  });

  it("shows a connection-friendly message when the check fails offline", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockRejectedValue(
      new Error("net::ERR_INTERNET_DISCONNECTED"),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage:
        "Traycer couldn't connect to check for updates. Please check your internet connection and try again.",
      lastCheckIntent: "manual",
    });
  });

  it("shows a service message when the update feed returns an HTTP error", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockRejectedValue(
      new Error("HttpError: 503 Service Unavailable"),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot().errorMessage).toBe(
      "Traycer couldn't reach the update service right now. Please try again in a little while.",
    );
  });

  it("shows a download-failure message when verification fails mid-download", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    updater.startUpdateDownload();
    expect(updater.getAppUpdateSnapshot().status).toBe("downloading");

    autoUpdater.emit(
      "error",
      new Error("sha512 checksum mismatch, expected abc got def"),
    );

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage:
        "Traycer couldn't download and install the latest update. Please try again in a little while.",
    });
  });

  it("shows a generic message for an unrecognized update error", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockRejectedValue(
      new Error("Unexpected updater failure"),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot().errorMessage).toBe(
      "Traycer ran into a problem while updating. Please try again in a little while.",
    );
  });

  it("forces allowPrerelease off so RC builds use the stable feed", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    expect(autoUpdater.allowPrerelease).toBe(true);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it("treats 'no production release yet' as up-to-date (not an error) on a prerelease build", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      const err = new Error(
        "Unable to find latest version on GitHub (https://api.github.com/repos/o/r/releases/latest), please ensure a production release exists: HttpError: 404",
      );
      autoUpdater.emit("error", err);
      return Promise.reject(err);
    });
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "up-to-date",
      errorMessage: null,
    });
  });

  it("still surfaces a genuine error on a prerelease build", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      const err = new Error("Unexpected updater failure");
      autoUpdater.emit("error", err);
      return Promise.reject(err);
    });
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot().status).toBe("error");
  });

  it("surfaces an available update without auto-downloading it", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "automatic");

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: "2.0.0",
      downloadProgress: null,
    });
  });

  it("blocks downloads and surfaces the reason when the location is read-only", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, {
      isAnyWindowFocused: () => true,
      focusPrimaryWindow: vi.fn(),
      installBlockedReason: () => "Move Traycer to your Applications folder.",
    });
    await updater.checkForUpdatesNow(false, "automatic");
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      installBlockedReason: "Move Traycer to your Applications folder.",
    });

    updater.startUpdateDownload();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.getAppUpdateSnapshot().status).toBe("available");
  });

  it("downloads only on user request and tracks whole-percent progress", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");

    updater.startUpdateDownload();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "downloading",
      downloadProgress: 0,
    });

    autoUpdater.emit("download-progress", { percent: 42.7 });
    expect(updater.getAppUpdateSnapshot().downloadProgress).toBe(43);

    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "ready",
      downloadProgress: null,
    });
  });

  it("notifies on availability only when no window is focused", async () => {
    const { autoUpdater, notify, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(false));

    await updater.checkForUpdatesNow(false, "automatic");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Traycer update available",
      "Open Traycer to download v2.0.0.",
      expect.any(Function),
    );
  });

  it("does not notify on availability while a window is focused", async () => {
    const { autoUpdater, notify, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "automatic");

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("Linux deb/rpm silent-install gating", () => {
  it("keeps autoInstallOnAppQuit enabled off Linux", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("keeps autoInstallOnAppQuit enabled for a Linux AppImage build (no package-type)", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("disables autoInstallOnAppQuit for a Linux deb build regardless of registration", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "deb",
      silentInstallSupported: true,
      isEscalationError: false,
    });

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("disables autoInstallOnAppQuit for a Linux rpm build", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "rpm",
      silentInstallSupported: false,
      isEscalationError: false,
    });

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("populates installGuidance on ready when silent install isn't supported", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "deb",
      silentInstallSupported: false,
      isEscalationError: false,
    });
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");

    autoUpdater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: "/home/user/.cache/updater/pending/traycer.deb",
    });

    const snapshot = updater.getAppUpdateSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.installGuidance).toMatchObject({
      command: 'sudo dpkg -i "/home/user/.cache/updater/pending/traycer.deb"',
    });
  });

  it("leaves installGuidance null on ready when silent install is supported", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "deb",
      silentInstallSupported: true,
      isEscalationError: false,
    });
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");

    autoUpdater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: "/home/user/.cache/updater/pending/traycer.deb",
    });

    expect(updater.getAppUpdateSnapshot().installGuidance).toBeNull();
  });

  it("falls back to guidance when a live install click hits an escalation failure", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "deb",
      silentInstallSupported: true,
      isEscalationError: true,
    });
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: "/home/user/.cache/updater/pending/traycer.deb",
    });
    // Pre-flight said this should work (installGuidance is null here) - the
    // one-click path is offered, matching a normal desktop Linux session.
    expect(updater.getAppUpdateSnapshot().installGuidance).toBeNull();

    updater.installDownloadedUpdate();
    autoUpdater.emit("error", new Error("Command pkexec exited with code 127"));

    const snapshot = updater.getAppUpdateSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.errorMessage).toBe(
      "Traycer couldn't finish installing the update automatically. Follow the instructions below to finish it manually.",
    );
    expect(snapshot.installGuidance).toMatchObject({
      command: 'sudo dpkg -i "/home/user/.cache/updater/pending/traycer.deb"',
    });
  });

  it("does not misclassify an unrelated install failure as an escalation failure", async () => {
    setPlatform("linux");
    const { autoUpdater, updater } = await loadUpdater({
      packageType: "deb",
      silentInstallSupported: true,
      isEscalationError: false,
    });
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", {
      version: "2.0.0",
      downloadedFile: "/home/user/.cache/updater/pending/traycer.deb",
    });

    updater.installDownloadedUpdate();
    autoUpdater.emit("error", new Error("ENOSPC: no space left on device"));

    const snapshot = updater.getAppUpdateSnapshot();
    expect(snapshot.installGuidance).toBeNull();
    expect(snapshot.errorMessage).toBe(
      "Traycer couldn't download and install the latest update. Please try again in a little while.",
    );
  });
});

interface LinuxGuidanceTestConfig {
  readonly packageType: "deb" | "rpm" | null;
  readonly silentInstallSupported: boolean;
  readonly isEscalationError: boolean;
}

// Neutral config for every pre-existing (non-Linux-guidance-focused) test:
// `packageType: null` mirrors macOS/Windows/AppImage, where
// `installAutoUpdater` never touches the Linux guidance module at all.
const NOT_LINUX_GUIDANCE: LinuxGuidanceTestConfig = {
  packageType: null,
  silentInstallSupported: true,
  isEscalationError: false,
};

async function loadUpdater(linuxGuidance: LinuxGuidanceTestConfig): Promise<{
  readonly autoUpdater: FakeAutoUpdater;
  readonly notify: Mock;
  readonly updater: UpdaterModule;
}> {
  vi.resetModules();
  const autoUpdater = new FakeAutoUpdater();
  const notify = vi.fn();
  vi.doMock("electron", () => ({
    app: {
      getVersion: () => "1.0.0-test",
    },
  }));
  vi.doMock("electron-updater", () => ({
    autoUpdater,
  }));
  vi.doMock("../../notifications", () => ({
    showSimpleNotification: notify,
  }));
  vi.doMock("node:fs/promises", () => ({
    access: vi.fn((): Promise<void> => Promise.resolve()),
    default: {
      access: vi.fn((): Promise<void> => Promise.resolve()),
    },
  }));
  vi.doMock("../logger", () => ({
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock("../linux-update-guidance", () => ({
    readLinuxPackageType: vi.fn(() => linuxGuidance.packageType),
    resolveLinuxSilentInstallSupported: vi.fn(() =>
      Promise.resolve(linuxGuidance.silentInstallSupported),
    ),
    buildLinuxUpdateGuidance: vi.fn(
      (
        packageType: "deb" | "rpm",
        latestVersion: string | null,
        downloadedFile: string | null,
      ) => ({
        summary: `guidance for ${packageType} (${latestVersion ?? "unknown"})`,
        steps: ["Open a terminal.", "Run the command.", "Restart Traycer."],
        command:
          downloadedFile === null
            ? null
            : `sudo ${packageType === "deb" ? "dpkg -i" : "rpm -U"} "${downloadedFile}"`,
        releaseUrl: "https://example.test/releases",
      }),
    ),
    isLinuxEscalationError: vi.fn(() => linuxGuidance.isEscalationError),
  }));
  return { autoUpdater, notify, updater: await import("../updater") };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
