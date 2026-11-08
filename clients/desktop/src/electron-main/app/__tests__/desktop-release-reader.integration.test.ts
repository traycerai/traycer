import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { NsisUpdater } from "electron-updater/out/NsisUpdater";

interface FixtureRelease {
  readonly tag: string;
  readonly version: string;
  readonly channel: "stable" | "rc" | "staging";
  readonly assetName: string;
  readonly installer: Buffer;
  readonly blockmap: Buffer;
}

interface FixtureState {
  readonly requests: Array<{
    readonly origin: string;
    readonly path: string;
    readonly query: string;
    readonly range: string | null;
    readonly authorization: string | null;
  }>;
  readonly assets: Map<string, Buffer>;
  readonly manifests: Map<string, string>;
  readonly githubManifestOverrides: Map<string, string>;
  readonly githubReleases: Map<string, unknown>;
  readonly githubReleasePages: Map<number, readonly unknown[]>;
  readonly releaseList: unknown[];
  index: string;
  latest: string;
  failCdnInstaller: boolean;
  failGithubInstaller: boolean;
  failIndex: boolean;
  failCdnManifest: boolean;
  failCdnUpdaterManifest: boolean;
  failGithubUpdaterManifest: boolean;
  visibilityProbeStatus: number;
  visibilityProbe: { readonly gate: Promise<void> } | null;
}

class FixtureHttpExecutor extends ElectronHttpExecutor {
  constructor(private readonly serverUrl: string) {
    super(() => undefined);
  }

  override createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest {
    const headers: Record<string, string | number | readonly string[]> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        Array.isArray(value)
      ) {
        headers[key] = value;
      }
    }
    const host =
      typeof options.hostname === "string" ? options.hostname : "unknown";
    headers["x-fixture-origin"] = host;
    headers["x-fixture-client"] = "electron-updater";
    const path = typeof options.path === "string" ? options.path : "/";
    return httpRequest(
      new URL(path, this.serverUrl),
      {
        method: typeof options.method === "string" ? options.method : "GET",
        headers,
      },
      callback,
    );
  }
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalResourcesPath = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
const originalRepo = process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO;
const originalToken = process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN;
const originalArch = process.env.TEST_UPDATER_ARCH;
const originalStagingToken = process.env.TRAYCER_STAGING_RELEASE_TOKEN;
const originalFetch = globalThis.fetch;
let fixtureServer: Server | null = null;
let fixtureDirectory: string | null = null;

afterEach(async () => {
  fixtureServer?.closeAllConnections();
  await new Promise<void>(
    (resolve) => fixtureServer?.close(() => resolve()) ?? resolve(),
  );
  fixtureServer = null;
  if (fixtureDirectory !== null)
    rmSync(fixtureDirectory, { recursive: true, force: true });
  fixtureDirectory = null;
  if (originalPlatform !== undefined)
    Object.defineProperty(process, "platform", originalPlatform);
  if (originalResourcesPath !== undefined)
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  restoreEnv("VITE_TRAYCER_DESKTOP_UPDATE_REPO", originalRepo);
  restoreEnv("VITE_TRAYCER_DESKTOP_UPDATE_TOKEN", originalToken);
  restoreEnv("TEST_UPDATER_ARCH", originalArch);
  restoreEnv("TRAYCER_STAGING_RELEASE_TOKEN", originalStagingToken);
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("electron");
  vi.doUnmock("electron-updater");
  vi.doUnmock("../logger");
  vi.doUnmock("../linux-update-guidance");
  vi.doUnmock("../update-preferences");
  vi.doUnmock("../../notifications");
  vi.doUnmock("../staging-release-auth");
  vi.doUnmock("../../../config");
});

describe("desktop release reader against electron-updater 6.8.9", () => {
  it.each([false, true])(
    "follows stableHead and downloads differentially with versionlessAsset=%s",
    async (versionlessAsset) => {
      const previous = makeRelease(
        "1.0.0",
        "stable",
        Buffer.from("oldZIP"),
        versionlessAsset ? "Traycer.exe" : null,
      );
      const selected = makeRelease(
        "1.2.0",
        "stable",
        Buffer.from("oldNEW"),
        versionlessAsset ? "Traycer.exe" : null,
      );
      const higherStable = makeRelease(
        "2.0.0",
        "stable",
        Buffer.from("newest"),
        versionlessAsset ? "Traycer.exe" : null,
      );
      const state = makeFixtureState(
        [previous, selected, higherStable],
        selected.version,
        "stable",
      );
      const { serverUrl, stop } = await startFixtureServer(state);
      const { updater, autoUpdater } = await loadRealUpdater(
        serverUrl,
        "1.0.0",
        { environment: "production" },
      );
      const cacheDir = join(
        fixtureDirectory ?? tmpdir(),
        "cache",
        "test-updater-cache",
      );
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

      await updater.installAutoUpdater(true, updateDeps());
      autoUpdater.autoInstallOnAppQuit = false;
      await updater.checkForUpdatesNow(false, "manual");

      expect(updater.getAppUpdateSnapshot()).toMatchObject({
        status: "available",
        latestVersion: selected.version,
      });
      updater.startUpdateDownload();
      await waitForReady(updater);

      expect(autoUpdater.constructor.name).toBe("NsisUpdater");
      expect(
        state.requests.some((request) => request.origin === "github.com"),
      ).toBe(false);
      expect(
        state.requests.some((request) => request.range === "bytes=3-5"),
        JSON.stringify(state.requests),
      ).toBe(true);
      expect(
        state.requests.some(
          (request) =>
            request.path ===
            `/desktop/${selected.version}/${selected.assetName}`,
        ),
      ).toBe(true);
      await stop();
    },
  );

  it("downloads an RC candidate differentially from the CDN index", async () => {
    const stableHead = makeRelease(
      "1.1.0",
      "stable",
      Buffer.from("oldstable"),
      null,
    );
    const previousRc = makeRelease(
      "1.2.0-rc.1",
      "rc",
      Buffer.from("oldZIP"),
      null,
    );
    const selectedRc = makeRelease(
      "1.2.0-rc.2",
      "rc",
      Buffer.from("oldNEW"),
      null,
    );
    const nextLineRc = makeRelease(
      "1.3.0-rc.1",
      "rc",
      Buffer.from("nextline"),
      null,
    );
    const state = makeFixtureState(
      [stableHead, previousRc, selectedRc, nextLineRc],
      stableHead.version,
      "rc",
    );
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater } = await loadRealUpdater(
      serverUrl,
      previousRc.version,
      { environment: "production" },
    );
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), previousRc.installer);

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: selectedRc.version,
    });
    updater.startUpdateDownload();
    await waitForReady(updater);

    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.traycer.ai" &&
          request.path === "/desktop/rc/index.json",
      ),
    ).toBe(true);
    expect(
      state.requests.some((request) => request.range === "bytes=3-5"),
    ).toBe(true);
    expect(
      state.requests.some((request) =>
        request.path.endsWith(`/${selectedRc.assetName}`),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" ||
          request.origin === "api.github.com",
      ),
    ).toBe(false);
    await stop();
  });

  it("downloads fully when the installed version is outside the CDN index", async () => {
    const selected = makeRelease(
      "1.2.0",
      "stable",
      Buffer.from("currentInstaller"),
      "Traycer.exe",
    );
    const state = makeFixtureState([selected], selected.version, "stable");
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater } = await loadRealUpdater(serverUrl, "0.9.0", {
      environment: "production",
    });
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), Buffer.from("outsideIndex"));

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");
    updater.startUpdateDownload();
    await waitForReady(updater);

    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.traycer.ai" &&
          request.path ===
            `/desktop/${selected.version}/${selected.assetName}` &&
          request.range === null,
      ),
    ).toBe(true);
    expect(
      state.requests.some((request) => request.path.endsWith(".blockmap")),
    ).toBe(false);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" ||
          request.origin === "api.github.com",
      ),
    ).toBe(false);
    await stop();
  });

  it("lets an implicit RC follower graduate to its stable release", async () => {
    const previousRc = makeRelease(
      "1.2.0-rc.1",
      "rc",
      Buffer.from("oldZIP"),
      null,
    );
    const stable = makeRelease("1.2.0", "stable", Buffer.from("oldNEW"), null);
    const nextLineRc = makeRelease(
      "1.3.0-rc.1",
      "rc",
      Buffer.from("newest"),
      null,
    );
    const state = makeFixtureState(
      [previousRc, stable, nextLineRc],
      stable.version,
      "rc",
    );
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater } = await loadRealUpdater(serverUrl, "1.2.0-rc.1", {
      environment: "production",
    });

    await updater.installAutoUpdater(true, updateDeps());
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: stable.version,
    });
    expect(
      state.requests.some(
        (request) => request.path === "/desktop/rc/index.json",
      ),
    ).toBe(true);
    expect(
      state.requests.some((request) => request.origin === "github.com"),
    ).toBe(false);
    await stop();
  });

  it("uses the staging CDN without resolving credentials or sending authorization", async () => {
    const previous = makeRelease(
      "1.2.3-staging.3.gabc1234",
      "staging",
      Buffer.from("oldZIP"),
      null,
    );
    const candidate = makeRelease(
      "1.2.3-staging.4.gdef5678",
      "staging",
      Buffer.from("oldNEW"),
      null,
    );
    const state = makeFixtureState([previous, candidate], null, "staging");
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, credentialCalls } = await loadRealUpdater(
      serverUrl,
      previous.version,
      {
        environment: "staging",
        token: null,
      },
    );

    await updater.installAutoUpdater(true, updateDeps());
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: candidate.version,
    });
    expect(credentialCalls()).toBe(0);
    expect(
      state.requests.some(
        (request) =>
          request.path === "/desktop/staging/index.json" &&
          request.origin === "releases.dev.traycer.ai",
      ),
    ).toBe(true);
    expect(
      state.requests
        .filter((request) => request.origin.startsWith("releases.dev."))
        .every((request) => request.authorization === null),
    ).toBe(true);
    expect(
      state.requests.some((request) => request.origin === "api.github.com"),
    ).toBe(false);
    await stop();
  });

  it("does not probe GitHub visibility for a CDN manifest 404 before authenticated fallback", async () => {
    const previous = makeRelease(
      "1.2.3-staging.3.gabc1234",
      "staging",
      Buffer.from("oldZIP"),
      null,
    );
    const candidate = makeRelease(
      "1.2.3-staging.4.gdef5678",
      "staging",
      Buffer.from("private"),
      null,
    );
    const state = makeFixtureState([previous, candidate], null, "staging");
    state.failIndex = true;
    state.failGithubUpdaterManifest = true;
    state.failCdnUpdaterManifest = true;
    state.failCdnManifest = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, credentialCalls } = await loadRealUpdater(
      serverUrl,
      previous.version,
      {
        environment: "staging",
        token: "test-staging-token",
      },
    );

    await updater.installAutoUpdater(true, updateDeps());
    // Prime the staging token through the authenticated discovery fallback,
    // then leave it cached after a visible repository's private manifest 404.
    // The following CDN-only 404 must not spend that lease on a visibility
    // probe before it legitimately advances to the authenticated GitHub feed.
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot().status).toBe("error");
    const probesBeforeCdnManifest = state.requests.filter(
      (request) => request.path === "/repos/traycerai/traycer-internal",
    ).length;
    state.failIndex = false;
    state.failGithubUpdaterManifest = false;
    state.failCdnUpdaterManifest = false;
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: candidate.version,
    });
    expect(credentialCalls()).toBeGreaterThan(0);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.dev.traycer.ai" &&
          request.path === `/desktop/${candidate.version}/latest.yml` &&
          request.authorization === null,
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.path ===
            `/repos/traycerai/traycer-internal/releases/tags/${candidate.tag}` &&
          request.authorization === "token test-staging-token",
      ),
    ).toBe(true);
    expect(
      state.requests.filter(
        (request) => request.path === "/repos/traycerai/traycer-internal",
      ),
    ).toHaveLength(probesBeforeCdnManifest);
    await stop();
  });

  it("awaits and settles a revoked private staging credential before finishing its check", async () => {
    const candidate = makeRelease(
      "1.2.3-staging.4.gdef5678",
      "staging",
      Buffer.from("private"),
      null,
    );
    const state = makeFixtureState([candidate], null, "staging");
    state.failIndex = true;
    state.failGithubUpdaterManifest = true;
    state.failCdnUpdaterManifest = true;
    state.visibilityProbeStatus = 404;
    let releaseProbe = (): void => {};
    state.visibilityProbe = {
      gate: new Promise<void>((resolve) => {
        releaseProbe = resolve;
      }),
    };
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater } = await loadRealUpdater(
      serverUrl,
      "1.2.3-staging.3.gabc1234",
      {
        environment: "staging",
        token: "first-token",
      },
    );

    await updater.installAutoUpdater(true, updateDeps());
    const statuses: string[] = [];
    const unsubscribe = updater.onAppUpdateChange((snapshot) => {
      statuses.push(snapshot.status);
    });
    let checkSettled = false;
    const check = updater.checkForUpdatesNow(false, "manual").finally(() => {
      checkSettled = true;
    });
    await vi.waitFor(
      () =>
        expect(
          state.requests.filter(
            (request) => request.path === "/repos/traycerai/traycer-internal",
          ),
        ).toHaveLength(1),
      { timeout: 1_000 },
    );
    expect(checkSettled).toBe(false);
    expect(
      state.requests.filter(
        (request) =>
          request.path === "/repos/traycerai/traycer-internal" &&
          request.authorization === "token first-token",
      ),
    ).toHaveLength(1);

    releaseProbe();
    await check;
    expect(checkSettled).toBe(true);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "unavailable",
      errorMessage: "Updates are not available for this build.",
    });
    expect(statuses.filter((status) => status === "unavailable")).toHaveLength(
      1,
    );
    unsubscribe();

    state.failGithubUpdaterManifest = false;
    state.failCdnUpdaterManifest = false;
    process.env.TRAYCER_STAGING_RELEASE_TOKEN = "second-token";
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot().status).toBe("available");
    expect(
      state.requests.some(
        (request) =>
          request.path === "/repos/traycerai/traycer-internal/releases" &&
          request.authorization === "token second-token",
      ),
    ).toBe(true);
    await stop();
  });

  it("uses the authenticated private release when the staging index is unavailable", async () => {
    const candidate = makeRelease(
      "1.2.3-staging.4.gdef5678",
      "staging",
      Buffer.from("private"),
      null,
    );
    const state = makeFixtureState([candidate], null, "staging");
    state.failIndex = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, credentialCalls } = await loadRealUpdater(
      serverUrl,
      "1.2.3-staging.3.gabc1234",
      {
        environment: "staging",
        token: "test-staging-token",
      },
    );

    await updater.installAutoUpdater(true, updateDeps());
    await updater.checkForUpdatesNow(false, "manual");

    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: candidate.version,
    });
    expect(credentialCalls()).toBeGreaterThan(0);
    expect(
      state.requests.some(
        (request) =>
          request.path === "/repos/traycerai/traycer-internal/releases" &&
          request.authorization === "token test-staging-token",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.path ===
            `/repos/traycerai/traycer-internal/releases/assets/${candidate.tag}-manifest` &&
          request.authorization === "token test-staging-token",
      ),
    ).toBe(true);
    expect(
      state.requests
        .filter((request) => request.origin.startsWith("releases.dev."))
        .every((request) => request.authorization === null),
    ).toBe(true);
    await stop();
  });

  it("recovers a staging CDN installer failure from the same authenticated private release", async () => {
    const previous = makeRelease(
      "1.2.3-staging.3.gabc1234",
      "staging",
      Buffer.from("oldZIP"),
      null,
    );
    const candidate = makeRelease(
      "1.2.3-staging.4.gdef5678",
      "staging",
      Buffer.from("oldNEW"),
      null,
    );
    const state = makeFixtureState([previous, candidate], null, "staging");
    state.failCdnInstaller = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater, credentialCalls } = await loadRealUpdater(
      serverUrl,
      previous.version,
      {
        environment: "staging",
        token: "test-staging-token",
      },
    );
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: candidate.version,
    });
    updater.startUpdateDownload();
    await waitForReady(updater);

    expect(credentialCalls()).toBeGreaterThan(0);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.dev.traycer.ai" &&
          request.path.endsWith(`/${candidate.assetName}`),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.path ===
            `/repos/traycerai/traycer-internal/releases/tags/${candidate.tag}` &&
          request.authorization === "token test-staging-token",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.path ===
            `/repos/traycerai/traycer-internal/releases/assets/${candidate.tag}-manifest` &&
          request.authorization === "token test-staging-token",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.path.endsWith(`/${candidate.tag}-installer`) &&
          request.authorization === "token test-staging-token",
      ),
      JSON.stringify(state.requests),
    ).toBe(true);
    expect(
      state.requests
        .filter((request) => request.origin.startsWith("releases.dev."))
        .every((request) => request.authorization === null),
    ).toBe(true);
    await stop();
  });

  it.each([
    {
      label: "stable",
      channel: "stable" as const,
      installed: "1.0.0",
      version: "1.2.0",
    },
    {
      label: "RC",
      channel: "rc" as const,
      installed: "1.2.0-rc.1",
      version: "1.2.0-rc.2",
    },
  ])(
    "retries a failed $label CDN installer through its exact GitHub tag",
    async ({ channel, installed, version }) => {
      const oldVersion = channel === "stable" ? "1.0.0" : "1.2.0-rc.1";
      const previous = makeRelease(
        oldVersion,
        channel,
        Buffer.from("oldZIP"),
        null,
      );
      const candidate = makeRelease(
        version,
        channel,
        Buffer.from("oldNEW"),
        null,
      );
      const releases =
        channel === "stable"
          ? [previous, candidate]
          : [
              makeRelease("1.1.0", "stable", Buffer.from("stable"), null),
              previous,
              candidate,
            ];
      const stableHead = channel === "stable" ? candidate.version : "1.1.0";
      const state = makeFixtureState(releases, stableHead, channel);
      state.failCdnInstaller = true;
      const { serverUrl, stop } = await startFixtureServer(state);
      const { updater, autoUpdater } = await loadRealUpdater(
        serverUrl,
        installed,
        { environment: "production" },
      );
      const cacheDir = join(
        fixtureDirectory ?? tmpdir(),
        "cache",
        "test-updater-cache",
      );
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

      await updater.installAutoUpdater(true, updateDeps());
      autoUpdater.autoInstallOnAppQuit = false;
      await updater.checkForUpdatesNow(false, "manual");
      expect(updater.getAppUpdateSnapshot()).toMatchObject({
        status: "available",
        latestVersion: version,
      });
      updater.startUpdateDownload();
      await waitForReady(updater);

      expect(
        state.requests.some(
          (request) =>
            request.origin === "releases.traycer.ai" &&
            request.path.endsWith(`/${candidate.assetName}`),
        ),
      ).toBe(true);
      expect(
        state.requests.some(
          (request) =>
            request.origin === "github.com" &&
            request.path ===
              `/traycerai/traycer/releases/download/${candidate.tag}/latest.yml`,
        ),
      ).toBe(true);
      expect(
        state.requests.some(
          (request) =>
            request.origin === "github.com" &&
            request.path ===
              `/traycerai/traycer/releases/download/${previous.tag}/${previous.assetName}.blockmap`,
        ),
      ).toBe(true);
      expect(
        state.requests.some(
          (request) =>
            request.origin === "github.com" &&
            request.path.endsWith(`/${candidate.assetName}`) &&
            request.range === "bytes=3-5",
        ),
      ).toBe(true);
      await stop();
    },
  );

  it("uses the CDN as the retry origin after GitHub Latest discovery", async () => {
    const previous = makeRelease(
      "1.0.0",
      "stable",
      Buffer.from("oldZIP"),
      "Traycer.exe",
    );
    const candidate = makeRelease(
      "1.2.0",
      "stable",
      Buffer.from("oldNEW"),
      "Traycer.exe",
    );
    const state = makeFixtureState(
      [previous, candidate],
      candidate.version,
      "stable",
    );
    state.failIndex = true;
    state.failGithubInstaller = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater } = await loadRealUpdater(
      serverUrl,
      previous.version,
      { environment: "production" },
    );
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: candidate.version,
    });
    updater.startUpdateDownload();
    await waitForReady(updater);

    expect(
      state.requests.some(
        (request) =>
          request.path === "/repos/traycerai/traycer/releases/latest" &&
          request.origin === "api.github.com",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" &&
          request.path.endsWith(`/${candidate.assetName}`),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.traycer.ai" &&
          request.path.endsWith(`/${candidate.assetName}`),
      ),
    ).toBe(true);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "ready",
      latestVersion: candidate.version,
    });
    await stop();
  });

  it("uses the CDN as the retry origin after paginated GitHub RC discovery", async () => {
    const previousRc = makeRelease(
      "1.2.0-rc.1",
      "rc",
      Buffer.from("oldZIP"),
      "Traycer.exe",
    );
    const selectedRc = makeRelease(
      "1.2.0-rc.2",
      "rc",
      Buffer.from("oldNEW"),
      "Traycer.exe",
    );
    const state = makeFixtureState([previousRc, selectedRc], "1.1.0", "rc");
    const firstPage = Array.from({ length: 100 }, (_, index): unknown => ({
      tag_name: `desktop-v9.0.0-beta.${index + 1}`,
      draft: false,
      prerelease: true,
      assets: [],
    }));
    state.githubReleasePages.set(1, firstPage);
    state.githubReleasePages.set(2, [
      githubRelease(previousRc),
      githubRelease(selectedRc),
    ]);
    state.failIndex = true;
    state.failGithubInstaller = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater } = await loadRealUpdater(
      serverUrl,
      previousRc.version,
      { environment: "production" },
    );
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), previousRc.installer);

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: selectedRc.version,
    });
    updater.startUpdateDownload();
    await waitForReady(updater);

    expect(
      state.requests.some(
        (request) =>
          request.origin === "api.github.com" &&
          request.path === "/repos/traycerai/traycer/releases" &&
          request.query === "?per_page=100&page=1",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "api.github.com" &&
          request.path === "/repos/traycerai/traycer/releases" &&
          request.query === "?per_page=100&page=2",
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" &&
          request.path.endsWith(`/${selectedRc.assetName}`),
      ),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.traycer.ai" &&
          request.path ===
            `/desktop/${selectedRc.version}/${selectedRc.assetName}`,
      ),
    ).toBe(true);
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "ready",
      latestVersion: selectedRc.version,
    });
    await stop();
  });

  it.each(["version", "name", "size", "sha512"] as const)(
    "refuses a GitHub retry with a different %s and keeps the original installer error",
    async (mismatch) => {
      const previous = makeRelease(
        "1.0.0",
        "stable",
        Buffer.from("oldZIP"),
        null,
      );
      const candidate = makeRelease(
        "1.2.0",
        "stable",
        Buffer.from("oldNEW"),
        null,
      );
      const state = makeFixtureState(
        [previous, candidate],
        candidate.version,
        "stable",
      );
      state.failCdnInstaller = true;
      state.githubManifestOverrides.set(
        candidate.tag,
        alternateManifest(candidate, mismatch),
      );
      const { serverUrl, stop } = await startFixtureServer(state);
      const { updater, autoUpdater, logger } = await loadRealUpdater(
        serverUrl,
        previous.version,
        { environment: "production" },
      );
      const cacheDir = join(
        fixtureDirectory ?? tmpdir(),
        "cache",
        "test-updater-cache",
      );
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

      await updater.installAutoUpdater(true, updateDeps());
      autoUpdater.autoInstallOnAppQuit = false;
      await updater.checkForUpdatesNow(false, "manual");
      updater.startUpdateDownload();
      await waitForStatus(updater, "error");

      expect(updater.getAppUpdateSnapshot()).toMatchObject({
        status: "error",
        latestVersion: candidate.version,
      });
      expect(
        state.requests.some(
          (request) =>
            request.origin === "github.com" &&
            request.path.endsWith("/latest.yml"),
        ),
      ).toBe(true);
      expect(
        state.requests.some(
          (request) =>
            request.origin === "github.com" &&
            request.path.endsWith(`/${candidate.assetName}`),
        ),
      ).toBe(false);
      expect(
        logger.warn.mock.calls
          .flat()
          .some(
            (value) =>
              value instanceof Error && /503|unavailable/i.test(value.message),
          ),
      ).toBe(true);
      await stop();
    },
  );

  it("retries the selected stable tag after Latest moves and uses the new head on the next check", async () => {
    const previous = makeRelease(
      "1.0.0",
      "stable",
      Buffer.from("oldZIP"),
      null,
    );
    const selected = makeRelease(
      "1.2.0",
      "stable",
      Buffer.from("oldNEW"),
      null,
    );
    const moved = makeRelease("1.3.0", "stable", Buffer.from("newest"), null);
    const state = makeFixtureState(
      [previous, selected],
      selected.version,
      "stable",
    );
    state.failCdnInstaller = true;
    const { serverUrl, stop } = await startFixtureServer(state);
    const { updater, autoUpdater } = await loadRealUpdater(
      serverUrl,
      previous.version,
      { environment: "production" },
    );
    const cacheDir = join(
      fixtureDirectory ?? tmpdir(),
      "cache",
      "test-updater-cache",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "installer.exe"), previous.installer);

    await updater.installAutoUpdater(true, updateDeps());
    autoUpdater.autoInstallOnAppQuit = false;
    await updater.checkForUpdatesNow(false, "manual");
    expect(updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: selected.version,
    });
    addRelease(state, moved);
    setIndex(state, [previous, selected, moved], moved.version, "stable");
    updater.startUpdateDownload();
    await waitForReady(updater);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" &&
          request.path ===
            `/traycerai/traycer/releases/download/${selected.tag}/latest.yml`,
      ),
      JSON.stringify(state.requests),
    ).toBe(true);
    expect(
      state.requests.some(
        (request) =>
          request.origin === "github.com" &&
          request.path ===
            `/traycerai/traycer/releases/download/${moved.tag}/latest.yml`,
      ),
    ).toBe(false);

    if (fixtureDirectory !== null)
      rmSync(fixtureDirectory, { recursive: true, force: true });
    fixtureDirectory = null;
    const nextProcess = await loadRealUpdater(serverUrl, previous.version, {
      environment: "production",
    });
    await nextProcess.updater.installAutoUpdater(true, updateDeps());
    await nextProcess.updater.checkForUpdatesNow(false, "manual");
    expect(nextProcess.updater.getAppUpdateSnapshot()).toMatchObject({
      status: "available",
      latestVersion: moved.version,
    });
    expect(
      state.requests.some(
        (request) =>
          request.origin === "releases.traycer.ai" &&
          request.path === `/desktop/${moved.version}/latest.yml`,
      ),
    ).toBe(true);
    await stop();
  });
});

function updateDeps() {
  return {
    isAnyWindowFocused: () => true,
    focusPrimaryWindow: () => undefined,
    installBlockedReason: () => null,
  };
}

async function loadRealUpdater(
  serverUrl: string,
  appVersion: string,
  environment:
    | { readonly environment: "production" }
    | { readonly environment: "staging"; readonly token: string | null },
): Promise<{
  updater: typeof import("../updater");
  autoUpdater: import("electron-updater").AppUpdater;
  credentialCalls: () => number;
  logger: { readonly warn: Mock };
}> {
  vi.resetModules();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
  Reflect.deleteProperty(process.env, "VITE_TRAYCER_DESKTOP_UPDATE_REPO");
  Reflect.deleteProperty(process.env, "VITE_TRAYCER_DESKTOP_UPDATE_TOKEN");
  Reflect.deleteProperty(process.env, "TEST_UPDATER_ARCH");
  if (environment.environment === "staging") {
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO = "traycerai/traycer-internal";
    if (environment.token === null) {
      Reflect.deleteProperty(process.env, "TRAYCER_STAGING_RELEASE_TOKEN");
    } else {
      process.env.TRAYCER_STAGING_RELEASE_TOKEN = environment.token;
    }
  }
  fixtureDirectory = mkdtempSync(join(tmpdir(), "desktop-release-reader-"));
  const resourcesPath = join(fixtureDirectory, "resources");
  mkdirSync(resourcesPath, { recursive: true });
  writeFileSync(
    join(resourcesPath, "app-update.yml"),
    "provider: generic\nurl: https://example.invalid/\nupdaterCacheDirName: test-updater-cache\n",
  );
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: resourcesPath,
  });

  const appAdapter: AppAdapter = {
    version: appVersion,
    name: "Traycer",
    isPackaged: true,
    appUpdateConfigPath: join(resourcesPath, "app-update.yml"),
    userDataPath: join(fixtureDirectory, "user-data"),
    baseCachePath: join(fixtureDirectory, "cache"),
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };
  const nativeUpdater = {
    on: () => undefined,
    quitAndInstall: () => undefined,
    setFeedURL: () => undefined,
    checkForUpdates: () => undefined,
  };
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
  const autoUpdater = new NsisUpdater(null, appAdapter);
  autoUpdater["httpExecutor"] = new FixtureHttpExecutor(serverUrl);
  vi.doMock("electron-updater", () => ({ autoUpdater }));
  vi.doMock("electron", () => ({
    app: { getVersion: () => appVersion },
    autoUpdater: nativeUpdater,
  }));
  vi.doMock("../../../config", () => ({
    config: { environment: environment.environment },
    configuredDesktopReleaseRepo: () =>
      environment.environment === "staging"
        ? "traycerai/traycer-internal"
        : "traycerai/traycer",
    DESKTOP_RELEASE_CHANNEL: environment.environment,
  }));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  vi.doMock("../logger", () => ({ log: logger }));
  vi.doMock("../linux-update-guidance", () => ({
    readLinuxPackageType: () => null,
    resolveLinuxSilentInstallSupported: () => Promise.resolve(true),
    buildLinuxUpdateGuidance: () => null,
    isLinuxEscalationError: () => false,
  }));
  vi.doMock("../update-preferences", () => ({
    hydrateUpdatePreferences: () => Promise.resolve({ allowPrerelease: false }),
    prereleaseUpdatesEnabled: () => false,
    setPrereleaseUpdatesEnabled: (enabled: boolean) => Promise.resolve(enabled),
  }));
  vi.doMock("../../notifications", () => ({
    showSimpleNotification: () => undefined,
  }));
  let credentialCalls = 0;
  vi.doMock("../staging-release-auth", () => ({
    AUTHENTICATION_REQUIRED_MESSAGE: "staging authentication unavailable",
    cancelResponseBody: async (response: Response) => response.body?.cancel(),
    discardStagingUpdateToken: () => undefined,
    fetchStagingGitHubRelease: (url: string, init: RequestInit) =>
      globalThis.fetch(url, init),
    isRateLimited: () => false,
    prepareStagingUpdateToken: () => {
      credentialCalls += 1;
      return Promise.resolve(
        environment.environment === "staging"
          ? (process.env.TRAYCER_STAGING_RELEASE_TOKEN ?? null)
          : null,
      );
    },
    stagingAuthLogMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    stagingReleaseAuthRequired: () => environment.environment === "staging",
  }));

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init: RequestInit | undefined) => {
      const requestUrl = new URL(
        input instanceof URL ? input.href : String(input),
      );
      const headers = new Headers(init?.headers);
      headers.set("x-fixture-origin", requestUrl.hostname);
      const localUrl = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        serverUrl,
      );
      return originalFetch(localUrl, { ...init, headers });
    },
  );
  const updater = await import("../updater");
  autoUpdater.logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  autoUpdater.autoInstallOnAppQuit = false;
  return {
    updater,
    autoUpdater,
    credentialCalls: () => credentialCalls,
    logger,
  };
}

async function startFixtureServer(
  state: FixtureState,
): Promise<{ serverUrl: string; stop: () => Promise<void> }> {
  fixtureServer = createServer((request, response) => {
    void routeRequest(state, request, response);
  });
  await new Promise<void>((resolve) =>
    fixtureServer?.listen(0, "127.0.0.1", resolve),
  );
  const address = fixtureServer.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture server has no TCP address");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const server = fixtureServer;
  return {
    serverUrl,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fixtureServer === server) fixtureServer = null;
    },
  };
}

async function routeRequest(
  state: FixtureState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
  const path = requestUrl.pathname;
  const origin = String(request.headers["x-fixture-origin"] ?? "unknown");
  const range = request.headers.range ?? null;
  const updaterRequest =
    request.headers["x-fixture-client"] === "electron-updater";
  state.requests.push({
    origin,
    path,
    query: requestUrl.search,
    range,
    authorization:
      typeof request.headers.authorization === "string"
        ? request.headers.authorization
        : null,
  });
  if (
    path === "/repos/traycerai/traycer-internal" &&
    origin === "api.github.com"
  ) {
    if (state.visibilityProbe !== null) await state.visibilityProbe.gate;
    send(
      response,
      state.visibilityProbeStatus,
      Buffer.from("repository visibility"),
      "application/json",
    );
    return;
  }
  if (
    state.failCdnManifest &&
    origin === "releases.dev.traycer.ai" &&
    path.startsWith("/desktop/") &&
    path.endsWith("/latest.yml")
  ) {
    send(
      response,
      404,
      Buffer.from("manifest unavailable"),
      "application/octet-stream",
    );
    return;
  }
  if (
    updaterRequest &&
    state.failCdnUpdaterManifest &&
    origin === "releases.dev.traycer.ai" &&
    path.startsWith("/desktop/") &&
    path.endsWith("/latest.yml")
  ) {
    send(
      response,
      503,
      Buffer.from("manifest unavailable"),
      "application/octet-stream",
    );
    return;
  }
  if (
    updaterRequest &&
    state.failGithubUpdaterManifest &&
    origin === "api.github.com" &&
    path.endsWith("-manifest")
  ) {
    send(
      response,
      404,
      Buffer.from("private manifest unavailable"),
      "application/octet-stream",
    );
    return;
  }
  if (
    path === "/desktop/stable/index.json" ||
    path === "/desktop/rc/index.json" ||
    path === "/desktop/staging/index.json"
  ) {
    if (state.failIndex) {
      send(
        response,
        503,
        Buffer.from("index unavailable"),
        "application/octet-stream",
      );
      return;
    }
    send(response, 200, Buffer.from(state.index), "application/json");
    return;
  }
  if (path === "/repos/traycerai/traycer/releases/latest") {
    send(response, 200, Buffer.from(state.latest), "application/json");
    return;
  }
  if (path === "/repos/traycerai/traycer/releases") {
    const page = Number(requestUrl.searchParams.get("page") ?? "1");
    const releases = state.githubReleasePages.get(page) ?? [];
    send(
      response,
      200,
      Buffer.from(JSON.stringify(releases)),
      "application/json",
    );
    return;
  }
  if (path === "/repos/traycerai/traycer-internal/releases") {
    send(
      response,
      200,
      Buffer.from(JSON.stringify(state.releaseList)),
      "application/json",
    );
    return;
  }
  if (path.startsWith("/repos/traycerai/traycer-internal/releases/tags/")) {
    const tag = decodeURIComponent(
      path.slice("/repos/traycerai/traycer-internal/releases/tags/".length),
    );
    const release = state.githubReleases.get(tag);
    send(
      response,
      release === undefined ? 404 : 200,
      Buffer.from(JSON.stringify(release ?? {})),
      "application/json",
    );
    return;
  }
  const manifest = [...state.manifests].find(
    ([key]) =>
      path.endsWith(`/${key}/latest.yml`) || path.endsWith(`/${key}-manifest`),
  );
  if (manifest !== undefined) {
    const override =
      origin === "github.com" || origin === "api.github.com"
        ? state.githubManifestOverrides.get(manifest[0])
        : undefined;
    send(response, 200, Buffer.from(override ?? manifest[1]), "text/yaml");
    return;
  }
  const asset = state.assets.get(path);
  if (asset !== undefined) {
    if (
      path.endsWith(".exe") &&
      ((origin.startsWith("releases") && state.failCdnInstaller) ||
        (origin === "github.com" && state.failGithubInstaller))
    ) {
      send(
        response,
        503,
        Buffer.from("unavailable"),
        "application/octet-stream",
      );
      return;
    }
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) {
        send(response, 416, Buffer.alloc(0), "application/octet-stream");
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), asset.length - 1);
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${asset.length}`,
        "content-length": String(end - start + 1),
      });
      response.end(asset.subarray(start, end + 1));
      return;
    }
    send(response, 200, asset, "application/octet-stream");
    return;
  }
  send(response, 404, Buffer.from("not found"), "application/octet-stream");
}

function send(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
  });
  response.end(body);
}

function makeFixtureState(
  releases: readonly FixtureRelease[],
  stableHead: string | null,
  channel: "stable" | "rc" | "staging",
): FixtureState {
  const state: FixtureState = {
    requests: [],
    assets: new Map(),
    manifests: new Map(),
    githubManifestOverrides: new Map(),
    githubReleases: new Map(),
    githubReleasePages: new Map(),
    releaseList: [],
    index: "",
    latest: "",
    failCdnInstaller: false,
    failGithubInstaller: false,
    failIndex: false,
    failCdnManifest: false,
    failCdnUpdaterManifest: false,
    failGithubUpdaterManifest: false,
    visibilityProbeStatus: 200,
    visibilityProbe: null,
  };
  for (const release of releases) addRelease(state, release);
  state.releaseList.push(...releases.map(githubRelease));
  state.githubReleasePages.set(1, state.releaseList);
  setIndex(state, releases, stableHead, channel);
  state.latest = JSON.stringify(
    githubRelease(
      releases.find((release) => release.version === stableHead) ?? releases[0],
    ),
  );
  return state;
}

function addRelease(state: FixtureState, release: FixtureRelease): void {
  const fileName = release.assetName;
  const manifest = manifestYaml(release, fileName);
  state.manifests.set(release.tag, manifest);
  state.assets.set(
    `/desktop/${release.version}/latest.yml`,
    Buffer.from(manifest),
  );
  state.assets.set(
    `/desktop/${release.version}/${fileName}`,
    release.installer,
  );
  state.assets.set(
    `/desktop/${release.version}/${fileName}.blockmap`,
    release.blockmap,
  );
  state.assets.set(
    `/traycerai/traycer/releases/download/${release.tag}/latest.yml`,
    Buffer.from(manifest),
  );
  state.assets.set(
    `/traycerai/traycer/releases/download/${release.tag}/${fileName}`,
    release.installer,
  );
  state.assets.set(
    `/traycerai/traycer/releases/download/${release.tag}/${fileName}.blockmap`,
    release.blockmap,
  );
  state.assets.set(
    `/repos/traycerai/traycer-internal/releases/assets/${release.tag}-manifest`,
    Buffer.from(manifest),
  );
  state.assets.set(
    `/repos/traycerai/traycer-internal/releases/assets/${release.tag}-installer`,
    release.installer,
  );
  state.assets.set(
    `/repos/traycerai/traycer-internal/releases/assets/${release.tag}-blockmap`,
    release.blockmap,
  );
  state.githubReleases.set(release.tag, githubRelease(release));
}

function setIndex(
  state: FixtureState,
  releases: readonly FixtureRelease[],
  stableHead: string | null,
  channel: "stable" | "rc" | "staging",
): void {
  const cdnBase =
    channel === "staging"
      ? "https://releases.dev.traycer.ai"
      : "https://releases.traycer.ai";
  state.index = JSON.stringify({
    schemaVersion: 1,
    channel,
    generatedAt: "2026-11-08T00:00:00.000Z",
    stableHead: channel === "staging" ? null : stableHead,
    versions: releases.map((release) => ({
      tag: release.tag,
      version: release.version,
      channel: release.channel,
      publishedAt: "2026-11-07T00:00:00.000Z",
      draft: false,
      assets: [
        {
          name: "latest.yml",
          url: `${cdnBase}/desktop/${release.version}/latest.yml`,
          size: Buffer.byteLength(manifestYaml(release, release.assetName)),
        },
        {
          name: release.assetName,
          url: `${cdnBase}/desktop/${release.version}/${release.assetName}`,
          size: release.installer.length,
        },
        {
          name: `${release.assetName}.blockmap`,
          url: `${cdnBase}/desktop/${release.version}/${release.assetName}.blockmap`,
          size: release.blockmap.length,
        },
      ],
    })),
  });
}

function makeRelease(
  version: string,
  channel: "stable" | "rc" | "staging",
  zipPayload: Buffer,
  sharedAssetName: string | null,
): FixtureRelease {
  const blockmapObject = {
    version: "1",
    files: [
      {
        name: "file",
        offset: 0,
        sizes: [3, 3],
        checksums: ["shared", version],
      },
    ],
  };
  const mapJson = Buffer.from(JSON.stringify(blockmapObject));
  const blockmap = gzipSync(mapJson);
  return {
    tag: `desktop-v${version}`,
    version,
    channel,
    assetName: sharedAssetName ?? installerName(version),
    installer: zipPayload,
    blockmap,
  };
}

function manifestYaml(release: FixtureRelease, fileName: string): string {
  const digest = createHash("sha512")
    .update(release.installer)
    .digest("base64");
  return [
    `version: ${release.version}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${digest}`,
    `    size: ${release.installer.length}`,
    "path: " + fileName,
    `sha512: ${digest}`,
    "releaseDate: '2026-11-07T00:00:00.000Z'",
  ].join("\n");
}

function installerName(version: string): string {
  return `Traycer-${version}.exe`;
}

function githubRelease(release: FixtureRelease): unknown {
  return {
    tag_name: release.tag,
    draft: false,
    prerelease: release.channel !== "stable",
    assets: [
      {
        name: "latest.yml",
        url: `https://api.github.com/repos/traycerai/traycer-internal/releases/assets/${release.tag}-manifest`,
        size: Buffer.byteLength(manifestYaml(release, release.assetName)),
      },
      {
        name: release.assetName,
        url: `https://api.github.com/repos/traycerai/traycer-internal/releases/assets/${release.tag}-installer`,
        size: release.installer.length,
      },
      {
        name: `${release.assetName}.blockmap`,
        url: `https://api.github.com/repos/traycerai/traycer-internal/releases/assets/${release.tag}-blockmap`,
        size: release.blockmap.length,
      },
    ],
  };
}

function alternateManifest(
  release: FixtureRelease,
  mismatch: "version" | "name" | "size" | "sha512",
): string {
  const original = manifestYaml(release, release.assetName);
  if (mismatch === "version") {
    return original.replace(`version: ${release.version}`, "version: 1.9.0");
  }
  if (mismatch === "name") {
    return original.replaceAll(release.assetName, `Other-${release.assetName}`);
  }
  if (mismatch === "size") {
    return original.replace(
      `size: ${release.installer.length}`,
      `size: ${release.installer.length + 1}`,
    );
  }
  const digest = createHash("sha512")
    .update(release.installer)
    .digest("base64");
  return original.replaceAll(digest, "different");
}

async function waitForReady(
  updater: typeof import("../updater"),
): Promise<void> {
  if (updater.getAppUpdateSnapshot().status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Update did not become ready; current state: ${updater.getAppUpdateSnapshot().status}`,
        ),
      );
    }, 5000);
    const unsubscribe = updater.onAppUpdateChange((snapshot) => {
      if (snapshot.status === "ready") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

async function waitForStatus(
  updater: typeof import("../updater"),
  status: "error",
): Promise<void> {
  if (updater.getAppUpdateSnapshot().status === status) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Update did not reach ${status}; current state: ${updater.getAppUpdateSnapshot().status}`,
        ),
      );
    }, 5000);
    const unsubscribe = updater.onAppUpdateChange((snapshot) => {
      if (snapshot.status === status) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
