import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  DesktopAppUpdateSnapshot,
  DesktopCompatRecoveryPlan,
} from "../../../ipc-contracts/app-update-types";

type UpdaterModule = typeof import("../updater");

class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  // electron-updater auto-derives this to `true` for a prerelease app version;
  // installAutoUpdater must force it back to `false`.
  allowPrerelease = true;
  requestHeaders: Record<string, string> | null = null;
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
  vi.unstubAllGlobals();
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
  // Only the architecture-selection test sets this; clean up unconditionally
  // so it can never leak into a later test's `platformChannelFile()` call.
  Reflect.deleteProperty(process.env, "TEST_UPDATER_ARCH");
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

  it("publishes the in-flight install to the renderer without leaving ready", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    const readySequence = updater.getAppUpdateSnapshot().sequence;
    expect(updater.getAppUpdateSnapshot().installInFlight).toBe(false);

    updater.installDownloadedUpdate();

    // A successful install emits nothing further - it ends the process - so
    // this is the renderer's only signal that the restart it asked for is
    // under way, and the only thing that disarms the restart affordances.
    // Status stays "ready": the artifact is still staged, and the updater's
    // own "ready" guards key on that.
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      sequence: readySequence + 1,
      status: "ready",
      installInFlight: true,
    });
  });

  it("ignores a repeat install request while one is already in flight", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    updater.installDownloadedUpdate();

    // The quit is bounded but not instant, and the restart affordances live in
    // every window - so a second request can arrive mid-quit. Status is still
    // "ready" then, so the readiness guard can't catch it.
    updater.installDownloadedUpdate();

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "ready",
      installInFlight: true,
    });
  });

  it("surfaces an install handoff that throws synchronously", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    autoUpdater.quitAndInstall.mockImplementation(() => {
      throw new Error("Cannot update while running on a read-only volume.");
    });

    updater.installDownloadedUpdate();

    // A synchronous throw never reaches the "error" event, so without an
    // explicit catch the renderer would never learn the install died - every
    // restart affordance would stay disabled with no way back.
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      errorMessage:
        "Move Traycer to your Applications folder to install updates.",
      installInFlight: false,
    });
    expect(updater.isInstallingUpdate()).toBe(false);
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
      installInFlight: false,
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

  it("defaults allowPrerelease off so RC builds use the stable feed", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    expect(autoUpdater.allowPrerelease).toBe(true);

    await updater.installAutoUpdater(true, makeDeps(true));

    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it("persists an explicit prerelease opt-in and selects only desktop-tagged releases", async () => {
    const { autoUpdater, preferences, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          { tag_name: "host-v9.0.0-rc.1", draft: false, prerelease: true },
          { tag_name: "cli-v8.0.0-rc.1", draft: false, prerelease: true },
          macReleaseFixture("desktop-v1.3.0-rc.2", true),
          macReleaseFixture("desktop-v1.3.0-rc.1", true),
          macReleaseFixture("desktop-v1.2.0", false),
        ],
        {
          "desktop-v1.3.0-rc.2": manifestYamlForTag(
            "desktop-v1.3.0-rc.2",
            macZipAssetName("desktop-v1.3.0-rc.2"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(preferences.allowPrerelease).toBe(true);
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.3.0-rc.2/",
    });
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
      latestCompatibilityEpoch: null,
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

  it("recovers from a synchronous throw inside downloadUpdate, taking the same error transition as an async rejection (finding 7)", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "2.0.0" });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    // Simulates an updater implementation that throws synchronously while
    // resolving the download (e.g. during file resolution) rather than
    // returning a rejected promise.
    autoUpdater.downloadUpdate.mockImplementation(() => {
      throw new Error("cannot resolve update file");
    });

    const snapshot = updater.startUpdateDownload();
    expect(snapshot.status).toBe("downloading");

    // The synchronous throw is funneled into the same async `.catch` as a
    // rejection, so it lands on a later tick.
    await flushPromises();
    await flushPromises();

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "error",
      downloadProgress: null,
    });

    // The stuck-`downloading` flag must not survive the synchronous throw: a
    // fresh check can surface "available" again, and a retry must actually
    // reach `downloadUpdate` rather than silently no-op on a stale
    // `downloadInProgress`.
    autoUpdater.downloadUpdate.mockImplementation((): Promise<string[]> =>
      Promise.resolve([]),
    );
    await updater.checkForUpdatesNow(false, "automatic");
    expect(updater.getAppUpdateSnapshot().status).toBe("available");

    const retry = updater.startUpdateDownload();

    expect(retry.status).toBe("downloading");
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("updater initialization readiness barrier", () => {
  it("parks a pre-init manual check until installAutoUpdater completes, then proceeds (finding 1)", async () => {
    const hydrationControl: DeferredHydrationControl = { resolve: null };
    const { autoUpdater, updater } = await loadUpdaterWithHydration(
      NOT_LINUX_GUIDANCE,
      { kind: "deferred", control: hydrationControl },
    );

    const installPromise = updater.installAutoUpdater(true, makeDeps(true));
    await flushPromises();

    const checkPromise = updater.checkForUpdatesNow(false, "manual");
    await flushPromises();

    // Parked: initialization hasn't completed, so the check must not have
    // touched electron-updater or emitted any terminal snapshot yet.
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.getAppUpdateSnapshot().status).toBe("idle");

    const resolveHydration = hydrationControl.resolve;
    if (resolveHydration === null) {
      throw new Error("Expected hydration to be pending");
    }
    resolveHydration();
    await installPromise;
    await checkPromise;

    // Once initialization completes, the parked check proceeds against the
    // now-authoritative channel/feed.
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("settles the barrier as failed when initialization rejects, refusing checks and downloads without hanging (finding 1)", async () => {
    const initError = new Error("preferences store unavailable");
    const { autoUpdater, updater } = await loadUpdaterWithHydration(
      NOT_LINUX_GUIDANCE,
      { kind: "rejects", error: initError },
    );

    // installAutoUpdater must resolve (not hang or throw) even though a
    // configuration step rejected partway through.
    await updater.installAutoUpdater(true, makeDeps(true));

    const snapshot = await updater.checkForUpdatesNow(false, "manual");
    expect(snapshot.status).toBe("error");
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    const downloadSnapshot = updater.startUpdateDownload();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(downloadSnapshot.status).toBe("error");
  });
});

describe("RC release discovery and channel safety", () => {
  it("filters alpha/beta/nightly prereleases and drafts/inconsistent-metadata entries, selecting the eligible rc", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macReleaseFixture("desktop-v2.0.0-alpha.1", true),
          macReleaseFixture("desktop-v2.0.0-beta.1", true),
          macReleaseFixture("desktop-v2.0.0-nightly.1", true),
          {
            ...macReleaseFixture("desktop-v1.6.0-rc.1", true),
            draft: true,
          },
          {
            ...macReleaseFixture("desktop-v1.7.0-rc.1", true),
            prerelease: false,
          },
          macReleaseFixture("desktop-v1.5.0-rc.1", true),
          macReleaseFixture("desktop-v1.4.0", false),
        ],
        {
          "desktop-v1.5.0-rc.1": manifestYamlForTag(
            "desktop-v1.5.0-rc.1",
            macZipAssetName("desktop-v1.5.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.5.0-rc.1/",
    });
  });

  it("selects the global maximum across pagination, not just the first page", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const page1 = [
      macReleaseFixture("desktop-v1.2.0", false),
      ...Array.from({ length: 99 }, (_, index) => fillerRelease(index)),
    ];
    const page2 = [macReleaseFixture("desktop-v1.5.0-rc.1", true)];
    const manifests: Record<string, string> = {
      "desktop-v1.5.0-rc.1": manifestYamlForTag(
        "desktop-v1.5.0-rc.1",
        macZipAssetName("desktop-v1.5.0-rc.1"),
      ),
    };
    let paginationCalls = 0;
    const fetchMock = vi.fn((input: unknown) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page");
      if (page !== null) {
        paginationCalls += 1;
        const body = page === "2" ? page2 : page1;
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }
      const tag = Object.keys(manifests).find(
        (candidateTag) =>
          url.pathname.includes(`/releases/download/${candidateTag}/`) ||
          url.pathname.endsWith(`/${candidateTag}-manifest`),
      );
      if (tag === undefined) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      return Promise.resolve(new Response(manifests[tag], { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    // Exactly the two pagination pages were fetched - pagination correctly
    // stopped once the short (non-full) second page signaled the end, and did
    // not spin further pages. The manifest fetch for the winning candidate is
    // a separate call, counted independently.
    expect(paginationCalls).toBe(2);
    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.5.0-rc.1/",
    });
  });

  it("surfaces a discovery error (not up-to-date) when pagination exceeds the safety cap", async () => {
    const { updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      fillerRelease(index),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(fullPage), { status: 200 }),
        ),
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    const snapshot = updater.getAppUpdateSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.status).not.toBe("up-to-date");
  });

  it("falls back to an older release that carries the running platform's assets", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          windowsReleaseFixture("desktop-v1.5.0-rc.2", true),
          macReleaseFixture("desktop-v1.4.0-rc.1", true),
        ],
        {
          // The newer Windows-only release fails the cheap platform gate
          // (darwin has no `latest.yml`) before any manifest fetch, so it
          // deliberately gets no manifest entry here.
          "desktop-v1.4.0-rc.1": manifestYamlForTag(
            "desktop-v1.4.0-rc.1",
            macZipAssetName("desktop-v1.4.0-rc.1"),
          ),
        },
      ),
    );
    // Default test platform is darwin (see the top-level `beforeEach`).
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.4.0-rc.1/",
    });
  });

  it("routes a private RC feed through the authenticated custom provider, never the public generic feed", async () => {
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO = "traycerai/private-traycer";
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN = "test-token";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v1.5.0-rc.1", true)], {
        "desktop-v1.5.0-rc.1": manifestYamlForTag(
          "desktop-v1.5.0-rc.1",
          macZipAssetName("desktop-v1.5.0-rc.1"),
        ),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    const feedArg = autoUpdater.setFeedURL.mock.calls.at(-1)?.[0];
    if (!isRecord(feedArg)) {
      throw new Error("Expected setFeedURL to receive an object");
    }
    expect(feedArg.provider).toBe("custom");
    expect(typeof feedArg.updateProvider).toBe("function");
    expect(Array.isArray(feedArg.assets)).toBe(true);
    expect(feedArg.token).toBe("test-token");
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "generic" }),
    );
  });

  it("fails closed and never falls back to the public feed when the private repo coordinate is malformed", async () => {
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO = "not-a-coordinate";
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN = "test-token";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot().status).toBe("error");
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("drops a stale RC discovery result and lands on the stable channel after an opt-out mid-check", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const discoveryControl: { resolve: ((response: Response) => void) | null } =
      {
        resolve: null,
      };
    // The releases-list fetch is deferred so the test can control exactly
    // when discovery observes the RC release; a manifest fetch for whichever
    // candidate discovery lands on resolves immediately with a valid
    // manifest, so the (now generation-stale) result still fully resolves
    // rather than hanging on a second unresolved fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = new URL(String(input));
        if (url.searchParams.has("per_page")) {
          return new Promise<Response>((resolve) => {
            discoveryControl.resolve = resolve;
          });
        }
        return Promise.resolve(
          new Response(
            manifestYamlForTag(
              "desktop-v1.9.0-rc.9",
              macZipAssetName("desktop-v1.9.0-rc.9"),
            ),
            { status: 200 },
          ),
        );
      }),
    );
    const allowPrereleaseAtCheckTime: boolean[] = [];
    autoUpdater.checkForUpdates.mockImplementation(() => {
      allowPrereleaseAtCheckTime.push(autoUpdater.allowPrerelease);
      autoUpdater.emit("update-not-available", { version: "1.4.0" });
      return Promise.resolve(null);
    });
    const snapshots: DesktopAppUpdateSnapshot[] = [];
    await updater.installAutoUpdater(true, makeDeps(true));
    updater.onAppUpdateChange((snapshot) => snapshots.push(snapshot));
    await updater.setAllowPrereleaseUpdates(true);

    const rcCheck = updater.checkForUpdatesNow(false, "automatic");
    await flushPromises();

    // Opt back out to stable while the RC discovery fetch above is still
    // pending, then request a fresh check - it must be queued behind the
    // stale RC check rather than dropped.
    await updater.setAllowPrereleaseUpdates(false);
    void updater.checkForUpdatesNow(false, "manual");

    const release = discoveryControl.resolve;
    if (release === null) {
      throw new Error("Expected the RC discovery fetch to be pending");
    }
    release(
      new Response(
        JSON.stringify([macReleaseFixture("desktop-v1.9.0-rc.9", true)]),
        { status: 200 },
      ),
    );
    await rcCheck;
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "generic",
        url: expect.stringContaining("desktop-v1.9.0-rc.9"),
      }),
    );
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "traycerai",
      repo: "traycer",
    });
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.status === "available" &&
          snapshot.latestVersion === "1.9.0-rc.9",
      ),
    ).toBe(false);
    expect(allowPrereleaseAtCheckTime).toContain(false);
    expect(updater.getAppUpdateSnapshot().status).toBe("up-to-date");
  });

  it("resets to idle and refuses a download when opting out while an update is available", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v1.6.0-rc.1", true)], {
        "desktop-v1.6.0-rc.1": manifestYamlForTag(
          "desktop-v1.6.0-rc.1",
          macZipAssetName("desktop-v1.6.0-rc.1"),
        ),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "1.6.0-rc.1" });
      return Promise.resolve(null);
    });
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot().status).toBe("available");

    await updater.setAllowPrereleaseUpdates(false);

    expect(updater.getAppUpdateSnapshot().status).toBe("idle");
    updater.startUpdateDownload();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("ignores an update-available event whose check generation was superseded", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const discoveryControl: { resolve: ((response: Response) => void) | null } =
      {
        resolve: null,
      };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            discoveryControl.resolve = resolve;
          }),
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    const rcCheck = updater.checkForUpdatesNow(false, "automatic");
    await flushPromises();

    // Bumps channelGeneration, superseding the in-flight RC check.
    await updater.setAllowPrereleaseUpdates(false);
    autoUpdater.emit("update-available", { version: "9.9.9-rc.1" });

    expect(updater.getAppUpdateSnapshot().status).not.toBe("available");

    const release = discoveryControl.resolve;
    if (release === null) {
      throw new Error("Expected the RC discovery fetch to be pending");
    }
    release(new Response(JSON.stringify([]), { status: 200 }));
    await rcCheck;
  });

  it("refuses a channel change while a download is in progress, leaving the RC channel and download intact", async () => {
    const { autoUpdater, preferences, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v1.6.0-rc.1", true)], {
        "desktop-v1.6.0-rc.1": manifestYamlForTag(
          "desktop-v1.6.0-rc.1",
          macZipAssetName("desktop-v1.6.0-rc.1"),
        ),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "1.6.0-rc.1" });
      return Promise.resolve(null);
    });
    await updater.checkForUpdatesNow(false, "manual");
    updater.startUpdateDownload();
    expect(updater.getAppUpdateSnapshot().status).toBe("downloading");
    autoUpdater.setFeedURL.mockClear();

    const change = await updater.setAllowPrereleaseUpdates(false);

    // Rejected before persistence: channel unchanged, download untouched, and
    // the stable feed is never configured (so no stale RC artifact can strand).
    // The refusal is reported explicitly so the IPC layer raises it as an
    // error instead of reading an unchanged snapshot as success.
    expect(change.outcome).toBe("refused-update-pending");
    expect(change.snapshot.allowPrerelease).toBe(true);
    expect(preferences.allowPrerelease).toBe(true);
    expect(updater.getAppUpdateSnapshot().status).toBe("downloading");
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("refuses a channel change while an update is ready to install", async () => {
    // darwin: a natively staged artifact cannot be discarded, so the refusal
    // STANDS. Windows/AppImage take the discard-then-switch path instead
    // (see "compat recovery" below).
    const { autoUpdater, preferences, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v1.6.0-rc.1", true)], {
        "desktop-v1.6.0-rc.1": manifestYamlForTag(
          "desktop-v1.6.0-rc.1",
          macZipAssetName("desktop-v1.6.0-rc.1"),
        ),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "1.6.0-rc.1" });
      return Promise.resolve(null);
    });
    await updater.checkForUpdatesNow(false, "manual");
    updater.startUpdateDownload();
    autoUpdater.emit("update-downloaded", { version: "1.6.0-rc.1" });
    expect(updater.getAppUpdateSnapshot().status).toBe("ready");

    const change = await updater.setAllowPrereleaseUpdates(false);

    expect(change.outcome).toBe("refused-update-pending");
    expect(change.snapshot.allowPrerelease).toBe(true);
    expect(preferences.allowPrerelease).toBe(true);
    expect(updater.getAppUpdateSnapshot().status).toBe("ready");
  });

  it("fails closed on the stable channel when the private repo coordinate is malformed (no network, no public fallback)", async () => {
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO = "not-a-coordinate";
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN = "test-token";
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("[]", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    // Stable channel (allowPrerelease defaults off) - no opt-in.
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot().status).toBe("error");
    // Neither the stable electron-updater check nor RC discovery runs, and no
    // packaged/public feed is configured as a fallback.
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("skips a newer macOS release shipping only the install-only DMG and falls back to an older updatable release", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macDmgOnlyReleaseFixture("desktop-v1.7.0-rc.1", true),
          macReleaseFixture("desktop-v1.6.0-rc.1", true),
        ],
        {
          // The DMG-only release fails the cheap platform gate (no `.zip`
          // asset) before any manifest fetch, so it deliberately gets no
          // manifest entry here.
          "desktop-v1.6.0-rc.1": manifestYamlForTag(
            "desktop-v1.6.0-rc.1",
            macZipAssetName("desktop-v1.6.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.6.0-rc.1/",
    });
  });

  it("keeps a channel switch refused after an install attempt on a staged artifact errors (finding 2)", async () => {
    const { autoUpdater, preferences, updater } =
      await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v1.6.0-rc.1", true)], {
        "desktop-v1.6.0-rc.1": manifestYamlForTag(
          "desktop-v1.6.0-rc.1",
          macZipAssetName("desktop-v1.6.0-rc.1"),
        ),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", { version: "1.6.0-rc.1" });
      return Promise.resolve(null);
    });
    await updater.checkForUpdatesNow(false, "manual");
    updater.startUpdateDownload();
    autoUpdater.emit("update-downloaded", { version: "1.6.0-rc.1" });
    expect(updater.getAppUpdateSnapshot().status).toBe("ready");

    updater.installDownloadedUpdate();
    // The install attempt fails (e.g. macOS read-only volume) - the artifact
    // stays staged on disk even though status drops to "error".
    autoUpdater.emit(
      "error",
      new Error("Cannot update while running on a read-only volume."),
    );
    expect(updater.getAppUpdateSnapshot().status).toBe("error");
    autoUpdater.setFeedURL.mockClear();

    const change = await updater.setAllowPrereleaseUpdates(false);

    // Still refused: the blocker is the staged artifact, not the "ready"
    // status, so an install error must not reopen the channel-switch gap.
    expect(change.outcome).toBe("refused-update-pending");
    expect(change.snapshot.allowPrerelease).toBe(true);
    expect(preferences.allowPrerelease).toBe(true);
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("falls back to an older RC release when the newest RC's channel manifest is broken (finding 4)", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macReleaseFixture("desktop-v1.6.0-rc.2", true),
          macReleaseFixture("desktop-v1.6.0-rc.1", true),
        ],
        {
          // Unparseable YAML - the newest RC's manifest is broken.
          "desktop-v1.6.0-rc.2": "version: 1.6.0-rc.2\nfiles: [1, 2",
          "desktop-v1.6.0-rc.1": manifestYamlForTag(
            "desktop-v1.6.0-rc.1",
            macZipAssetName("desktop-v1.6.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.6.0-rc.1/",
    });
  });

  it("falls back to an older release when the newest release's manifest version disagrees with its tag (finding 4)", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macReleaseFixture("desktop-v1.8.0-rc.1", true),
          macReleaseFixture("desktop-v1.7.0-rc.1", true),
        ],
        {
          // Publishing error: the manifest names a different version than
          // the release tag it was fetched from.
          "desktop-v1.8.0-rc.1": manifestYamlForTag(
            "desktop-v1.8.0-rc.2",
            macZipAssetName("desktop-v1.8.0-rc.1"),
          ),
          "desktop-v1.7.0-rc.1": manifestYamlForTag(
            "desktop-v1.7.0-rc.1",
            macZipAssetName("desktop-v1.7.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.7.0-rc.1/",
    });
  });

  it("never selects a tag with a leading-zero identifier, falling back to a strict-SemVer release", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          // Malformed strict SemVer (leading-zero rc identifier) - never a
          // candidate, even though it is the highest-looking tag.
          macReleaseFixture("desktop-v2.0.0-rc.01", true),
          macReleaseFixture("desktop-v1.9.0-rc.1", true),
        ],
        {
          "desktop-v1.9.0-rc.1": manifestYamlForTag(
            "desktop-v1.9.0-rc.1",
            macZipAssetName("desktop-v1.9.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.9.0-rc.1/",
    });
  });

  it("does not let a stale RC check's discovery error overwrite the current (stable) channel's snapshot (finding 8)", async () => {
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const discoveryControl: { reject: ((err: unknown) => void) | null } = {
      reject: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            discoveryControl.reject = reject;
          }),
      ),
    );
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-not-available", { version: "1.4.0" });
      return Promise.resolve(null);
    });
    const snapshots: DesktopAppUpdateSnapshot[] = [];
    await updater.installAutoUpdater(true, makeDeps(true));
    updater.onAppUpdateChange((snapshot) => snapshots.push(snapshot));
    await updater.setAllowPrereleaseUpdates(true);

    const rcCheck = updater.checkForUpdatesNow(false, "automatic");
    await flushPromises();

    // Opt back out to stable while the RC discovery fetch is still pending
    // (bumps channelGeneration), then queue a fresh check for the new
    // channel.
    await updater.setAllowPrereleaseUpdates(false);
    void updater.checkForUpdatesNow(false, "manual");

    const rejectDiscovery = discoveryControl.reject;
    if (rejectDiscovery === null) {
      throw new Error("Expected the RC discovery fetch to be pending");
    }
    rejectDiscovery(new Error("network blip during stale RC discovery"));
    await rcCheck;
    await flushPromises();
    await flushPromises();
    await flushPromises();

    // The stale RC check's discovery failure belongs to a superseded
    // channel and must never surface as an error - the queued check for the
    // current (stable) channel owns the outcome.
    expect(snapshots.some((snapshot) => snapshot.status === "error")).toBe(
      false,
    );
    expect(updater.getAppUpdateSnapshot().status).toBe("up-to-date");
  });
});

describe("architecture-specific channel manifest selection", () => {
  it("selects the arm64 channel manifest over an x64-only release on Linux arm64 (finding 4)", async () => {
    setPlatform("linux");
    process.env.TEST_UPDATER_ARCH = "arm64";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const x64Only = linuxReleaseFixture(
      "desktop-v1.9.0-rc.2",
      true,
      "latest-linux.yml",
      "traycer-1.9.0-rc.2-x86_64.appimage",
    );
    const arm64 = linuxReleaseFixture(
      "desktop-v1.9.0-rc.1",
      true,
      "latest-linux-arm64.yml",
      "traycer-1.9.0-rc.1-arm64.appimage",
    );
    vi.stubGlobal(
      "fetch",
      fetchRouter([x64Only, arm64], {
        // The newer x64-only release fails the cheap platform gate (no
        // `latest-linux-arm64.yml` manifest asset), so it deliberately gets
        // no manifest entry here.
        "desktop-v1.9.0-rc.1": [
          "version: 1.9.0-rc.1",
          "files:",
          "  - url: traycer-1.9.0-rc.1-arm64.appimage",
          "    sha512: aGVsbG8=",
          "    size: 1024",
          "path: traycer-1.9.0-rc.1-arm64.appimage",
          "sha512: aGVsbG8=",
          "releaseDate: '2026-01-01T00:00:00.000Z'",
        ].join("\n"),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.9.0-rc.1/",
    });
  });

  it("skips an arm64-only newest release on an x64 Mac and falls back to an older applicable release (finding 4)", async () => {
    setPlatform("darwin");
    process.env.TEST_UPDATER_ARCH = "x64";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macArm64OnlyReleaseFixture("desktop-v1.9.0-rc.2", true),
          macReleaseFixture("desktop-v1.9.0-rc.1", true),
        ],
        {
          "desktop-v1.9.0-rc.2": manifestYamlForTag(
            "desktop-v1.9.0-rc.2",
            macArm64ZipAssetName("desktop-v1.9.0-rc.2"),
          ),
          "desktop-v1.9.0-rc.1": manifestYamlForTag(
            "desktop-v1.9.0-rc.1",
            macZipAssetName("desktop-v1.9.0-rc.1"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    // MacUpdater would drop the arm64 ZIP on an x64 Mac and throw
    // ZIP_FILE_NOT_FOUND, so discovery rejects the newest and falls back.
    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.9.0-rc.1/",
    });
  });

  it("selects an arm64-only newest release on an arm64 Mac (finding 4)", async () => {
    setPlatform("darwin");
    process.env.TEST_UPDATER_ARCH = "arm64";
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter(
        [
          macArm64OnlyReleaseFixture("desktop-v1.9.0-rc.2", true),
          macReleaseFixture("desktop-v1.9.0-rc.1", true),
        ],
        {
          "desktop-v1.9.0-rc.2": manifestYamlForTag(
            "desktop-v1.9.0-rc.2",
            macArm64ZipAssetName("desktop-v1.9.0-rc.2"),
          ),
        },
      ),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await updater.setAllowPrereleaseUpdates(true);
    await updater.checkForUpdatesNow(false, "manual");

    expect(autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/traycerai/traycer/releases/download/desktop-v1.9.0-rc.2/",
    });
  });
});

describe("channel-change queue ordering", () => {
  it("serializes concurrent channel changes so the last-admitted request wins, without interleaving idempotence checks", async () => {
    const persistControl: PersistPrereleaseControl = { calls: [], gate: null };
    const gateControl: { release: (() => void) | null } = { release: null };
    persistControl.gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const { autoUpdater, preferences, updater } =
      await loadUpdaterWithPersistControl(NOT_LINUX_GUIDANCE, persistControl);
    await updater.installAutoUpdater(true, makeDeps(true));

    // Fire both calls without awaiting between them - both are admitted onto
    // the serialized queue before either persist resolves.
    const a = updater.setAllowPrereleaseUpdates(true);
    const b = updater.setAllowPrereleaseUpdates(false);

    await flushPromises();
    await flushPromises();
    await flushPromises();
    // Only the first (admitted-first) request has reached persistence; the
    // second is queued behind it rather than racing its own idempotence
    // check against a stale pre-persist value.
    expect(persistControl.calls).toEqual([true]);

    const release = gateControl.release;
    if (release === null) {
      throw new Error("Expected the persist gate to be pending");
    }
    release();

    const [ra, rb] = await Promise.all([a, b]);

    // Admission order equals call order, and the last-admitted request
    // (false) is the final live state - it correctly saw the (now
    // persisted) `true` and proceeded to change rather than reading a stale
    // value and returning "unchanged".
    expect(persistControl.calls).toEqual([true, false]);
    expect(ra.outcome).toBe("changed");
    expect(rb.outcome).toBe("changed");
    expect(preferences.allowPrerelease).toBe(false);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "traycerai",
      repo: "traycer",
    });
    expect(updater.getAppUpdateSnapshot().status).not.toBe("downloading");

    // No stranded state: a subsequent download with no candidate is a no-op.
    const downloadSnapshot = updater.startUpdateDownload();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(downloadSnapshot.status).not.toBe("downloading");
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

describe("compat recovery: staged-artifact policy", () => {
  async function stageReadyBuild(
    updater: UpdaterModule,
    autoUpdater: FakeAutoUpdater,
  ): Promise<void> {
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", {
        version: "2.0.0",
        compatibilityEpoch: 1,
      });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    updater.startUpdateDownload();
    autoUpdater.emit("update-downloaded", {
      version: "2.0.0",
      compatibilityEpoch: 1,
    });
    expect(updater.getAppUpdateSnapshot().status).toBe("ready");
  }

  it("an idle updater on win32 does not disarm quit-install", async () => {
    // The dialog's common case: nothing is staged and nothing is downloading.
    // autoInstallOnAppQuit never comes back up within a process once lowered,
    // so disarming here would cost a later, perfectly good update its
    // quit-time install to defend against an artifact that does not exist.
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));
    expect(updater.getAppUpdateSnapshot().status).toBe("idle");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: false,
    });

    expect(plan.route).toBe("manual");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("disarms quit-install for an insufficient candidate that is only available", async () => {
    // The third of three quit-install outcomes on non-darwin, and the one with
    // no other coverage: nothing is staged yet, but a candidate IS held. The
    // artifact has not landed, so `updateArtifactStaged` is false and the
    // staged-discard branch does not run - only `holdsCandidate` reaches the
    // disarm. Deleting that branch keeps both neighbouring tests green.
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));
    autoUpdater.emit("update-available", {
      version: "2.0.0",
      compatibilityEpoch: 1,
    });
    expect(updater.getAppUpdateSnapshot().status).toBe("available");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: false,
    });

    expect(plan.route).toBe("manual");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    // The snapshot is NOT transitioned here - nothing was staged to discard.
    expect(updater.getAppUpdateSnapshot().status).toBe("available");
  });

  it("discards an insufficient staged build on non-darwin: disarms quit-install and leaves ready", async () => {
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await stageReadyBuild(updater, autoUpdater);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: false,
    });

    expect(plan.route).toBe("manual");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(updater.getAppUpdateSnapshot().status).toBe("idle");
    expect(updater.getAppUpdateSnapshot().latestCompatibilityEpoch).toBeNull();
  });

  it("on darwin, an insufficient staged build routes restart-to-clear-staged and mutates nothing", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await stageReadyBuild(updater, autoUpdater);
    const before = updater.getAppUpdateSnapshot();

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });

    expect(plan.route).toBe("restart-to-clear-staged");
    expect(plan.stagedVersion).toBe("2.0.0");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "ready",
      latestVersion: before.latestVersion,
    });

    const change = await updater.setAllowPrereleaseUpdates(true);
    expect(change.outcome).toBe("refused-update-pending");
  });

  it("on non-darwin, discard-then-switch lets setAllowPrereleaseUpdates succeed", async () => {
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await stageReadyBuild(updater, autoUpdater);

    const change = await updater.setAllowPrereleaseUpdates(true);
    expect(change.outcome).toBe("changed");
    expect(updater.getAppUpdateSnapshot().status).toBe("idle");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it.each(["darwin", "win32", "linux"] as const)(
    "refuses a channel change while downloading on %s",
    async (platform) => {
      setPlatform(platform);
      const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
      autoUpdater.checkForUpdates.mockImplementation(() => {
        autoUpdater.emit("update-available", { version: "2.0.0" });
        return Promise.resolve(null);
      });
      await updater.installAutoUpdater(true, makeDeps(true));
      await updater.checkForUpdatesNow(false, "automatic");
      updater.startUpdateDownload();
      expect(updater.getAppUpdateSnapshot().status).toBe("downloading");

      const change = await updater.setAllowPrereleaseUpdates(true);
      expect(change.outcome).toBe("refused-update-pending");
      expect(updater.getAppUpdateSnapshot().status).toBe("downloading");
    },
  );

  it("discard is idempotent", async () => {
    setPlatform("win32");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await stageReadyBuild(updater, autoUpdater);

    const first = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: false,
    });
    const second = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: false,
    });
    expect(first.route).toBe("manual");
    expect(second.route).toBe("manual");
    expect(updater.getAppUpdateSnapshot().status).toBe("idle");
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });
});

describe("compat recovery: RC probe", () => {
  function stampedYaml(tag: string, epoch: number | null): string {
    const body = manifestYamlForTag(tag, macZipAssetName(tag));
    if (epoch === null) return body;
    return `${body}\ncompatibilityEpoch: ${epoch}\n`;
  }

  async function probe(
    updater: UpdaterModule,
    autoUpdater: FakeAutoUpdater,
    releases: ReadonlyArray<{
      readonly tag: string;
      readonly prerelease: boolean;
      readonly epoch: number | null;
    }>,
  ): Promise<DesktopCompatRecoveryPlan> {
    const fixtures = releases.map((entry) =>
      macReleaseFixture(entry.tag, entry.prerelease),
    );
    const manifests: Record<string, string> = {};
    for (const entry of releases) {
      manifests[entry.tag] = stampedYaml(entry.tag, entry.epoch);
    }
    vi.stubGlobal("fetch", fetchRouter(fixtures, manifests));
    await updater.installAutoUpdater(true, makeDeps(true));
    autoUpdater.setFeedURL.mockClear();
    const generationBefore = autoUpdater.setFeedURL.mock.calls.length;
    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(generationBefore);
    return plan;
  }

  it("waits for an in-flight selected-feed check before offering RC", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    let finishCheck = (): void => {
      throw new Error("check did not start");
    };
    autoUpdater.checkForUpdates.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          finishCheck = () => {
            autoUpdater.emit("update-available", {
              version: "2.0.0",
              compatibilityEpoch: 2,
            });
            resolve(null);
          };
        }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await updater.installAutoUpdater(true, makeDeps(true));

    const check = updater.checkForUpdatesNow(false, "automatic");
    await flushPromises();
    const recovery = updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    finishCheck();
    await check;
    await expect(recovery).resolves.toMatchObject({
      route: "update-available",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns manual when the probe's network wait exceeds its deadline", async () => {
    // A stalled request never rejects, so without a wall-clock ceiling the
    // `manual` fallback is unreachable and the blocking dialog sits on a
    // spinner forever - the one outcome every arm of this surface avoids.
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    await updater.installAutoUpdater(true, makeDeps(true));
    autoUpdater.setFeedURL.mockClear();
    let recoverySignal: AbortSignal | undefined;
    // Never settles on its own. It rejects only when the recovery deadline
    // aborts it, proving the fallback does not leave a live request behind.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init: RequestInit | undefined) =>
          new Promise((_resolve, reject) => {
            recoverySignal = init?.signal ?? undefined;
            recoverySignal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );

    vi.useFakeTimers();
    try {
      const pending = updater.resolveCompatRecovery({
        minimumEpoch: 2,
        hostAllowsRcRecovery: true,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      const plan = await pending;
      expect(plan.route).toBe("manual");
      expect(plan.rcCandidateVersion).toBeNull();
      expect(recoverySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Still read-only on the timeout path.
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("skips an RC that clears the floor but is not newer than the running build", async () => {
    // The running build is `1.0.0-test` (see the electron mock). A sufficient
    // RC that is OLDER by SemVer is a real shape - a release line predating an
    // epoch backport produces one - and this updater never sets
    // `allowDowngrade`, so electron-updater would report it as not available
    // AFTER the user had already consented to the RC channel. Offering it is
    // therefore a promise that cannot be kept.
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v1.0.0-rc.1", prerelease: true, epoch: 2 },
    ]);
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
  });

  it("still offers an RC that clears the floor and IS newer", async () => {
    // The control for the case above: same epoch, newer version, so the offer
    // is one electron-updater can actually honour.
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v2.0.0-rc.1", prerelease: true, epoch: 2 },
    ]);
    expect(plan.route).toBe("enable-rc");
    expect(plan.rcCandidateVersion).toBe("2.0.0-rc.1");
  });

  it("does not offer the RC hop while a download is in flight", async () => {
    // `performChannelChange` refuses unconditionally while a transfer is
    // active - no CancellationToken is plumbed - so an `enable-rc` button here
    // could only ever return `refused-update-pending`, which the dialog shows
    // as nothing happening at all.
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v2.0.0-rc.1", true)], {
        "desktop-v2.0.0-rc.1": stampedYaml("desktop-v2.0.0-rc.1", 2),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    autoUpdater.emit("update-available", {
      version: "1.5.0",
      compatibilityEpoch: 1,
    });
    updater.startUpdateDownload();
    expect(updater.getAppUpdateSnapshot().status).toBe("downloading");

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });

    expect(plan.route).toBe("manual");
  });

  it("short-circuits on the PERSISTED channel, not the snapshot's copy", async () => {
    // `currentSnapshot.allowPrerelease` can lag `prereleaseUpdatesEnabled()` -
    // `getAppUpdateSnapshot` reconciles them on every read for that reason.
    // Reading the unreconciled field would let the probe run against the feed
    // the user is ALREADY on and offer an opt-in they already have, whose
    // `setAllowPrereleaseUpdates(true)` then answers `unchanged`.
    const persistControl: PersistPrereleaseControl = { calls: [], gate: null };
    const gateControl: { release: (() => void) | null } = { release: null };
    persistControl.gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const { autoUpdater, preferences, updater } =
      await loadUpdaterWithPersistControl(NOT_LINUX_GUIDANCE, persistControl);
    vi.stubGlobal(
      "fetch",
      fetchRouter([macReleaseFixture("desktop-v2.0.0-rc.1", true)], {
        "desktop-v2.0.0-rc.1": stampedYaml("desktop-v2.0.0-rc.1", 2),
      }),
    );
    await updater.installAutoUpdater(true, makeDeps(true));
    const pendingChannelChange = updater.setAllowPrereleaseUpdates(true);
    await vi.waitFor(() => expect(persistControl.calls).toEqual([true]));
    // Persistence is already externally observable while performChannelChange
    // is still gated before its snapshot update: the exact split state this
    // test exists to exercise.
    preferences.allowPrerelease = true;

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });

    expect(plan.route).toBe("manual");
    const release = gateControl.release;
    if (release === null)
      throw new Error("Expected the persist gate to be pending");
    release();
    await pendingChannelChange;
  });

  it("a held sufficient candidate is update-available, even when the host is on RC", async () => {
    // The shorter path: no channel change, and the probe must not run. A
    // sufficient RC in the listing would otherwise become enable-rc.
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const fetchMock = fetchRouter(
      [macReleaseFixture("desktop-v1.2.0-rc.1", true)],
      {
        "desktop-v1.2.0-rc.1": stampedYaml("desktop-v1.2.0-rc.1", 2),
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    autoUpdater.checkForUpdates.mockImplementation(() => {
      autoUpdater.emit("update-available", {
        version: "1.2.0",
        compatibilityEpoch: 2,
      });
      return Promise.resolve(null);
    });
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.checkForUpdatesNow(false, "automatic");
    fetchMock.mockClear();

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    expect(plan.route).toBe("update-available");
    expect(plan.rcCandidateVersion).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls setFeedURL and never bumps channelGeneration", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v1.2.0-rc.1", prerelease: true, epoch: 2 },
    ]);
    expect(plan.route).toBe("enable-rc");
    expect(plan.rcCandidateVersion).toBe("1.2.0-rc.1");
    expect(updater.getAppUpdateSnapshot().allowPrerelease).toBe(false);
  });

  it("does not offer an RC channel switch when the post-opt-in selector chooses stable", async () => {
    // projectDesktopRelease accepts stable and RC alike. The probe must inspect
    // the same first usable candidate as the shipping selector, then refuse to
    // describe a stable build as the result of "Enable RC updates".
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v1.3.0", prerelease: false, epoch: 2 },
      { tag: "desktop-v1.2.0-rc.1", prerelease: true, epoch: 1 },
    ]);
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
  });

  it("does not offer an older sufficient RC when the post-opt-in selector chooses a newer insufficient stable", async () => {
    // Enabling prereleases makes the shipping resolver sort stable and RC
    // desktop tags together. The first usable build is therefore the stable
    // one, even though its epoch does not clear the host floor. Skipping it in
    // the probe would promise the older RC while the updater installs (or
    // offers) a different build.
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v1.3.0", prerelease: false, epoch: 1 },
      { tag: "desktop-v1.2.0-rc.1", prerelease: true, epoch: 2 },
    ]);
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
  });

  it("skips an unstamped RC candidate (never infers epoch 1)", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const plan = await probe(updater, autoUpdater, [
      { tag: "desktop-v1.2.0-rc.1", prerelease: true, epoch: null },
    ]);
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
  });

  it("stops at the 5-manifest budget, even if a later RC would clear the floor", async () => {
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const releases = [1, 2, 3, 4, 5, 6].map((n) => ({
      tag: `desktop-v1.2.0-rc.${n}`,
      prerelease: true,
      // Newest five (rc.6 … rc.2) are unstamped; the sixth is the sufficient
      // one. Newest-first means the budget truncates before it is fetched.
      epoch: n === 1 ? 2 : null,
    }));
    const plan = await probe(updater, autoUpdater, releases);
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
  });

  it("already following RC has no second line: insufficient feed → manual, probe not started", async () => {
    // A sufficient RC exists in the listing. If the already-on-RC short-circuit
    // were dropped, this would become enable-rc — opting into a channel the
    // user is already on, to reach a build their feed already could not.
    setPlatform("darwin");
    const { autoUpdater, updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const fetchMock = fetchRouter(
      [macReleaseFixture("desktop-v1.2.0-rc.1", true)],
      {
        "desktop-v1.2.0-rc.1": stampedYaml("desktop-v1.2.0-rc.1", 2),
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    await updater.installAutoUpdater(true, makeDeps(true));
    await updater.setAllowPrereleaseUpdates(true);
    fetchMock.mockClear();

    const plan = await updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    expect(plan.route).toBe("manual");
    expect(plan.rcCandidateVersion).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a probe failure is not a verdict about RC: route manual, do not throw", async () => {
    setPlatform("darwin");
    const { updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("GitHub unreachable"))),
    );
    await updater.installAutoUpdater(true, makeDeps(true));

    await expect(
      updater.resolveCompatRecovery({
        minimumEpoch: 2,
        hostAllowsRcRecovery: true,
      }),
    ).resolves.toEqual({
      route: "manual",
      rcCandidateVersion: null,
      stagedVersion: null,
    });
  });

  it("in-flight probes for the same floor share one GitHub walk", async () => {
    setPlatform("darwin");
    const { updater } = await loadUpdater(NOT_LINUX_GUIDANCE);
    const listingWaits: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: unknown) => {
      const url = new URL(String(input));
      if (url.searchParams.has("per_page")) {
        return new Promise<Response>((resolve) => {
          listingWaits.push(resolve);
        });
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await updater.installAutoUpdater(true, makeDeps(true));

    const first = updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    const second = updater.resolveCompatRecovery({
      minimumEpoch: 2,
      hostAllowsRcRecovery: true,
    });
    await flushPromises();
    expect(listingWaits).toHaveLength(1);

    listingWaits[0]?.(new Response(JSON.stringify([]), { status: 200 }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.route).toBe("manual");
    expect(b.route).toBe("manual");
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

interface LoadedUpdater {
  readonly autoUpdater: FakeAutoUpdater;
  readonly notify: Mock;
  readonly preferences: { allowPrerelease: boolean };
  readonly updater: UpdaterModule;
}

// Lets a test park a `hydrateUpdatePreferences()` call and resolve it on
// demand (finding 1's pre-init parking coverage). `resolve` is populated the
// moment the mocked `hydrateUpdatePreferences` is invoked.
interface DeferredHydrationControl {
  resolve: (() => void) | null;
}

// How the mocked `hydrateUpdatePreferences()` should behave for a given test:
// resolve immediately (the default for almost every test), stay pending until
// the test releases it via a `DeferredHydrationControl`, or reject to
// exercise `installAutoUpdater`'s initialization-failure path (finding 1).
type HydrationBehavior =
  | { readonly kind: "immediate" }
  | { readonly kind: "deferred"; readonly control: DeferredHydrationControl }
  | { readonly kind: "rejects"; readonly error: Error };

// Lets a test observe/gate `setPrereleaseUpdatesEnabled` (the persistence
// step `performChannelChange` awaits) without perturbing every other test,
// which relies on it resolving synchronously. `calls` records admission order
// (finding: last-admitted-request semantics for concurrent channel changes);
// `gate`, when set, is awaited before the mock resolves.
interface PersistPrereleaseControl {
  readonly calls: boolean[];
  gate: Promise<void> | null;
}

async function loadUpdater(
  linuxGuidance: LinuxGuidanceTestConfig,
): Promise<LoadedUpdater> {
  return loadUpdaterWithControls(linuxGuidance, { kind: "immediate" }, null);
}

async function loadUpdaterWithHydration(
  linuxGuidance: LinuxGuidanceTestConfig,
  hydration: HydrationBehavior,
): Promise<LoadedUpdater> {
  return loadUpdaterWithControls(linuxGuidance, hydration, null);
}

async function loadUpdaterWithPersistControl(
  linuxGuidance: LinuxGuidanceTestConfig,
  persistControl: PersistPrereleaseControl,
): Promise<LoadedUpdater> {
  return loadUpdaterWithControls(
    linuxGuidance,
    { kind: "immediate" },
    persistControl,
  );
}

async function loadUpdaterWithControls(
  linuxGuidance: LinuxGuidanceTestConfig,
  hydration: HydrationBehavior,
  persistControl: PersistPrereleaseControl | null,
): Promise<LoadedUpdater> {
  vi.resetModules();
  const autoUpdater = new FakeAutoUpdater();
  const notify = vi.fn();
  const preferences = { allowPrerelease: false };
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
  vi.doMock("../update-preferences", () => ({
    hydrateUpdatePreferences: vi.fn(
      (): Promise<{ allowPrerelease: boolean }> => {
        if (hydration.kind === "deferred") {
          const control = hydration.control;
          return new Promise((resolve) => {
            control.resolve = () => resolve(preferences);
          });
        }
        if (hydration.kind === "rejects") {
          return Promise.reject(hydration.error);
        }
        return Promise.resolve(preferences);
      },
    ),
    prereleaseUpdatesEnabled: vi.fn(() => preferences.allowPrerelease),
    setPrereleaseUpdatesEnabled: vi.fn(async (allowPrerelease: boolean) => {
      if (persistControl !== null) {
        persistControl.calls.push(allowPrerelease);
        if (persistControl.gate !== null) {
          await persistControl.gate;
        }
      }
      preferences.allowPrerelease = allowPrerelease;
      return allowPrerelease;
    }),
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
  return {
    autoUpdater,
    notify,
    preferences,
    updater: await import("../updater"),
  };
}

// A GitHub release payload carrying the macOS channel manifest + installer, so
// it passes the platform-compatibility filter under the default `darwin` test
// platform. `prerelease` must agree with the tag form or discovery rejects it.
function macReleaseFixture(
  tag: string,
  prerelease: boolean,
): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
} {
  const version = tag.replace(/^desktop-v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [
      {
        name: "latest-mac.yml",
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
      },
      // macOS updates apply from the ZIP; the DMG is install-only. Discovery
      // requires the ZIP, so it must be present for the release to be eligible.
      {
        name: `Traycer-${version}-mac.zip`,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-zip`,
      },
      {
        name: `Traycer-${version}-mac.dmg`,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-dmg`,
      },
    ],
  };
}

// A macOS release that ships only the install-only DMG (no updatable ZIP), so
// discovery must treat it as incompatible and fall back to an older release.
function macDmgOnlyReleaseFixture(
  tag: string,
  prerelease: boolean,
): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
} {
  const version = tag.replace(/^desktop-v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [
      {
        name: "latest-mac.yml",
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
      },
      {
        name: `Traycer-${version}-mac.dmg`,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-dmg`,
      },
    ],
  };
}

// The GitHub asset name for a mac release's arm64 Squirrel.Mac ZIP.
function macArm64ZipAssetName(tag: string): string {
  const version = tag.replace(/^desktop-v/, "");
  return `Traycer-${version}-arm64-mac.zip`;
}

// A macOS release publishing ONLY the arm64 ZIP (no x64/universal ZIP), so
// `MacUpdater.filterFilesForArch` drops it on an x64 Mac and discovery must fall
// back to an older release. It still carries the channel manifest + a `.zip`
// asset, so it passes the cheap platform-compatibility gate and only fails once
// the manifest is arch-filtered during validation.
function macArm64OnlyReleaseFixture(
  tag: string,
  prerelease: boolean,
): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
} {
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [
      {
        name: "latest-mac.yml",
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
      },
      {
        name: macArm64ZipAssetName(tag),
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-arm64-zip`,
      },
    ],
  };
}

// A non-desktop GitHub release (e.g. a sibling `cli-v*` tag) used purely to
// pad a discovery page out to 100 entries. `projectDesktopRelease` always
// rejects it, so its content doesn't matter - only `raw.length` does.
function fillerRelease(index: number): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly [];
} {
  return {
    tag_name: `cli-v1.0.${index}`,
    draft: false,
    prerelease: false,
    assets: [],
  };
}

// A GitHub release payload carrying the Windows channel manifest + installer
// only - used to exercise platform-fallback discovery under the default
// darwin test platform, where this release must be filtered out.
function windowsReleaseFixture(
  tag: string,
  prerelease: boolean,
): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
} {
  const version = tag.replace(/^desktop-v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [
      {
        name: "latest.yml",
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
      },
      {
        name: `Traycer-Setup-${version}.exe`,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-exe`,
      },
    ],
  };
}

// The GitHub asset name electron-updater/`macReleaseFixture` publishes for a
// mac release's Squirrel.Mac ZIP - the installer a valid channel manifest
// must reference for the release to validate.
function macZipAssetName(tag: string): string {
  const version = tag.replace(/^desktop-v/, "");
  return `Traycer-${version}-mac.zip`;
}

// Builds a minimal, fully valid electron-updater channel manifest (the same
// shape `validateDesktopReleaseManifest` parses via `parseUpdateInfo`) for a
// release whose tag is `tag` and whose installer asset is named
// `assetFileName`. `version` is derived from `tag` so it agrees with the
// release by default; tests exercising the version-mismatch rejection pass a
// different `assetFileName`/tag pairing or edit the returned string.
function manifestYamlForTag(tag: string, assetFileName: string): string {
  const version = tag.replace(/^desktop-v/, "");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${assetFileName}`,
    "    sha512: aGVsbG8=",
    "    size: 1024",
    `path: ${assetFileName}`,
    "sha512: aGVsbG8=",
    "releaseDate: '2026-01-01T00:00:00.000Z'",
  ].join("\n");
}

// Routes the desktop updater's two discovery-time fetch calls: the paginated
// `GET /releases` listing (any URL carrying `per_page`) always serves
// `releasesJson`, and a channel-manifest request (the public
// `releases/download/<tag>/<channelFile>` browser URL or the private
// `releases/assets/<tag>-manifest` asset URL used by `macReleaseFixture`) is
// looked up by tag in `manifestByTag` - a 404 for any tag not present, so a
// release intentionally left out of the map (e.g. one expected to be skipped
// by the cheap platform-compatibility gate before any manifest fetch) still
// fails safely if the production code fetches it unexpectedly.
function fetchRouter(
  releasesJson: readonly unknown[],
  manifestByTag: Readonly<Record<string, string>>,
): Mock {
  return vi.fn((input: unknown) => {
    const url = new URL(String(input));
    if (url.searchParams.has("per_page")) {
      return Promise.resolve(
        new Response(JSON.stringify(releasesJson), { status: 200 }),
      );
    }
    const tag = Object.keys(manifestByTag).find(
      (candidateTag) =>
        url.pathname.includes(`/releases/download/${candidateTag}/`) ||
        url.pathname.endsWith(`/${candidateTag}-manifest`),
    );
    if (tag === undefined) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    return Promise.resolve(new Response(manifestByTag[tag], { status: 200 }));
  });
}

// A GitHub release payload carrying a Linux channel manifest + AppImage under
// an explicit `channelFile`/`installerName` pair, so architecture-specific
// discovery (`latest-linux-arm64.yml` vs `latest-linux.yml`) can be exercised
// without a package-type install (mirrors the AppImage path - no `.deb`/
// `.rpm`).
function linuxReleaseFixture(
  tag: string,
  prerelease: boolean,
  channelFile: string,
  installerName: string,
): {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
} {
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    assets: [
      {
        name: channelFile,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-manifest`,
      },
      {
        name: installerName,
        url: `https://api.github.com/repos/traycerai/traycer/releases/assets/${tag}-appimage`,
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
