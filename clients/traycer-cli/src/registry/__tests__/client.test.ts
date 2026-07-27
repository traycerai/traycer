import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRegistryClient } from "../client";
import type { RegistryTransport } from "../client";
import { CliError } from "../../runner/errors";
import {
  closeFaultServer,
  sha256,
  startFaultServer,
} from "./fault-server-test-helpers";

const manifestUrlMock = vi.hoisted(() => ({
  url: "https://registry.example.test/versions.json",
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock("../manifest-url", () => ({
  resolveManifestUrl: () => ({ url: manifestUrlMock.url }),
}));

// Smoke-level test that wires the client end-to-end against a fake
// transport so we can assert manifest parsing, version resolution,
// yanked refusal, and platform unavailability without spinning up a
// real network. The minisign + sha256 chain is exercised by
// `minisign.test.ts`; here we focus on resolution and error mapping.

let tmpRoot: string;
const faultServers: Server[] = [];

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "traycer-registry-client-"));
});

beforeEach(() => {
  loggerMock.debug.mockClear();
  loggerMock.error.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  manifestUrlMock.url = "https://registry.example.test/versions.json";
});

afterAll(async () => {
  vi.useRealTimers();
  await Promise.all(
    faultServers.splice(0).map((server) => closeFaultServer(server)),
  );
  rmSync(tmpRoot, { recursive: true, force: true });
});

function faultManifest(baseUrl: string) {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-05-15T12:00:00Z",
    latest: "1.5.0",
    versions: [
      {
        version: "1.5.0",
        releasedAt: "2026-05-15T12:00:00Z",
        releaseNotesUrl: "https://example.com/notes/1.5.0",
        yanked: false,
        deprecationReason: null,
        requiredCliVersion: null,
        platforms: {
          "darwin-arm64": {
            available: true,
            unavailableReason: null,
            url: `${baseUrl}/archive`,
            sizeBytes: 6,
            sha256: sha256("abcdef"),
            signatureUrl: `${baseUrl}/archive.minisig`,
            signatureAlgorithm: "minisign",
            publicKeyId: "deadbeefdeadbeef",
          },
        },
      },
    ],
  });
}

const MANIFEST_DATA = {
  schemaVersion: 1,
  generatedAt: "2026-05-15T12:00:00Z",
  latest: "1.5.0",
  versions: [
    {
      version: "1.5.0",
      releasedAt: "2026-05-15T12:00:00Z",
      releaseNotesUrl: "https://example.com/notes/1.5.0",
      yanked: false,
      deprecationReason: null,
      requiredCliVersion: null,
      platforms: {
        "darwin-arm64": {
          available: true,
          unavailableReason: null,
          url: "https://example.com/d.tar.gz",
          sizeBytes: 16,
          sha256: "a".repeat(64),
          signatureUrl: "https://example.com/d.tar.gz.minisig",
          signatureAlgorithm: "minisign",
          publicKeyId: "deadbeefdeadbeef",
        },
        "linux-x64": {
          available: false,
          unavailableReason: "not built",
          url: "",
          sizeBytes: 0,
          sha256: "",
          signatureUrl: "",
          signatureAlgorithm: "minisign",
          publicKeyId: "",
        },
      },
    },
    {
      version: "1.4.0",
      releasedAt: "2026-04-01T00:00:00Z",
      releaseNotesUrl: "https://example.com/notes/1.4.0",
      yanked: true,
      deprecationReason: "CVE-2026-1234",
      requiredCliVersion: null,
      platforms: {
        "darwin-arm64": {
          available: true,
          unavailableReason: null,
          url: "https://example.com/d-1.4.0.tar.gz",
          sizeBytes: 16,
          sha256: "b".repeat(64),
          signatureUrl: "https://example.com/d-1.4.0.tar.gz.minisig",
          signatureAlgorithm: "minisign",
          publicKeyId: "deadbeefdeadbeef",
        },
      },
    },
  ],
};

const MANIFEST_BODY = JSON.stringify(MANIFEST_DATA);

function fakeTransport(): RegistryTransport {
  return {
    fetchText: async () => MANIFEST_BODY,
    downloadToFile: async (opts) => {
      writeFileSync(opts.destPath, Buffer.alloc(opts.expectedSizeBytes));
      opts.onProgress({
        downloadedBytes: opts.expectedSizeBytes,
        totalBytes: opts.expectedSizeBytes,
      });
      return {
        downloadedBytes: opts.expectedSizeBytes,
        sha256: opts.expectedSha256,
      };
    },
  };
}

describe("registry client", () => {
  it("fails closed after a default-transport manifest blackhole", async () => {
    vi.useFakeTimers();
    let requestReceived: (() => void) | null = null;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    const baseUrl = await startFaultServer(() => {
      if (requestReceived !== null) requestReceived();
    }, faultServers);
    manifestUrlMock.url = `${baseUrl}/versions.json`;
    const progress: string[] = [];
    let desktopInactivityExpired = false;
    let desktopInactivityTimer: NodeJS.Timeout | null = null;
    const resetDesktopInactivity = (): void => {
      if (desktopInactivityTimer !== null) {
        clearTimeout(desktopInactivityTimer);
      }
      desktopInactivityTimer = setTimeout(() => {
        desktopInactivityExpired = true;
      }, 45_000);
    };
    resetDesktopInactivity();
    const client = await createRegistryClient({
      environment: "production",
      transport: null,
      onProgress: (event) => {
        progress.push(event.stage);
        resetDesktopInactivity();
      },
      requireTrustedKeys: false,
    });
    const pending = client.fetchManifest();
    const outcome = pending.then(
      () => ({ kind: "ok" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    await received;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(750);
    }

    const settled = await outcome;
    expect(settled.kind).toBe("error");
    if (settled.kind === "error") {
      expect(settled.error).toMatchObject({
        name: "CliError",
        code: "E_REGISTRY_UNAVAILABLE",
      });
    }
    expect(progress).toContain("registry-manifest-watchdog");
    expect(desktopInactivityExpired).toBe(false);
  });

  it("fails closed after a default-transport signature blackhole following a complete archive", async () => {
    vi.useFakeTimers();
    let signatureRequested: (() => void) | null = null;
    const signatureRequest = new Promise<void>((resolve) => {
      signatureRequested = resolve;
    });
    let archiveCompleted = false;
    let baseUrl = "";
    baseUrl = await startFaultServer((request, response) => {
      if (request.url === "/versions.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(faultManifest(baseUrl));
        return;
      }
      if (request.url === "/archive") {
        response.writeHead(200, { "content-length": "6", etag: '"etag-1"' });
        response.end("abcdef", () => {
          archiveCompleted = true;
        });
        return;
      }
      if (request.url === "/archive.minisig") {
        if (signatureRequested !== null) signatureRequested();
      }
    }, faultServers);
    manifestUrlMock.url = `${baseUrl}/versions.json`;
    const progress: string[] = [];
    let desktopInactivityExpired = false;
    let desktopInactivityTimer: NodeJS.Timeout | null = null;
    const resetDesktopInactivity = (): void => {
      if (desktopInactivityTimer !== null) {
        clearTimeout(desktopInactivityTimer);
      }
      desktopInactivityTimer = setTimeout(() => {
        desktopInactivityExpired = true;
      }, 45_000);
    };
    resetDesktopInactivity();
    const client = await createRegistryClient({
      environment: "production",
      transport: null,
      onProgress: (event) => {
        progress.push(event.stage);
        resetDesktopInactivity();
      },
      requireTrustedKeys: false,
    });
    const { entry, asset } = await client.resolveAsset(
      "latest",
      "darwin-arm64",
    );
    const pending = client.downloadAndVerify(entry, asset, () => undefined);
    const outcome = pending.then(
      () => ({ kind: "ok" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    await signatureRequest;
    expect(archiveCompleted).toBe(true);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(750);
    }

    const settled = await outcome;
    expect(settled.kind).toBe("error");
    if (settled.kind === "error") {
      expect(settled.error).toMatchObject({
        name: "CliError",
        code: "E_REGISTRY_UNAVAILABLE",
      });
    }
    expect(progress).toContain("registry-signature-watchdog");
    expect(desktopInactivityExpired).toBe(false);
  });

  it("surfaces manifest watchdog heartbeats through CLI progress", async () => {
    const progress: Array<{ stage: string; message: string }> = [];
    const client = await createRegistryClient({
      environment: "production",
      transport: {
        fetchText: async ({ onHeartbeat }) => {
          onHeartbeat?.({ phase: "watchdog", attempt: 1, maxAttempts: 4 });
          return MANIFEST_BODY;
        },
        downloadToFile: async () => ({ downloadedBytes: 0, sha256: "" }),
      },
      onProgress: (event) => {
        if (event.message !== null) {
          progress.push({ stage: event.stage, message: event.message });
        }
      },
      requireTrustedKeys: false,
    });

    await client.fetchManifest();

    expect(progress).toContainEqual({
      stage: "registry-manifest-watchdog",
      message: "fetching manifest stalled; retrying",
    });
  });

  it("surfaces signature watchdog heartbeats before verification fails closed", async () => {
    const progress: Array<{ stage: string; message: string }> = [];
    const client = await createRegistryClient({
      environment: "production",
      transport: {
        fetchText: async ({ url, onHeartbeat }) => {
          if (url.endsWith(".minisig")) {
            onHeartbeat?.({ phase: "watchdog", attempt: 1, maxAttempts: 4 });
            return "";
          }
          return MANIFEST_BODY;
        },
        downloadToFile: async (opts) => {
          writeFileSync(opts.destPath, Buffer.alloc(opts.expectedSizeBytes));
          return {
            downloadedBytes: opts.expectedSizeBytes,
            sha256: opts.expectedSha256,
          };
        },
      },
      onProgress: (event) => {
        if (event.message !== null) {
          progress.push({ stage: event.stage, message: event.message });
        }
      },
      requireTrustedKeys: false,
    });
    const { entry, asset } = await client.resolveAsset(
      "latest",
      "darwin-arm64",
    );

    await expect(
      client.downloadAndVerify(entry, asset, () => undefined),
    ).rejects.toThrow();
    expect(progress).toContainEqual({
      stage: "registry-signature-watchdog",
      message: "fetching signature stalled; retrying",
    });
  });

  it("fetches and parses the manifest", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    const manifest = await client.fetchManifest();
    expect(manifest.latest).toBe("1.5.0");
    expect(manifest.versions).toHaveLength(2);
  });

  it("logs manifest parse warnings while returning the usable manifest", async () => {
    const manifestWithDupe = {
      ...MANIFEST_DATA,
      versions: [...MANIFEST_DATA.versions, MANIFEST_DATA.versions[0]],
    };
    const client = await createRegistryClient({
      environment: "production",
      transport: {
        fetchText: async () => JSON.stringify(manifestWithDupe),
        downloadToFile: async () => ({ downloadedBytes: 0, sha256: "" }),
      },
      onProgress: null,
      requireTrustedKeys: false,
    });

    const parsed = await client.fetchManifest();

    expect(parsed.versions).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Registry manifest entry skipped",
      expect.objectContaining({
        entryIndex: 2,
        warning: expect.stringContaining("duplicate version entry"),
      }),
    );
  });

  it("resolves 'latest' to the manifest's latest version", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    const { entry, asset } = await client.resolveAsset(
      "latest",
      "darwin-arm64",
    );
    expect(entry.version).toBe("1.5.0");
    expect(asset.available).toBe(true);
  });

  it("refuses to resolve a yanked version", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    await expect(client.resolveAsset("1.4.0", "darwin-arm64")).rejects.toThrow(
      /yanked/,
    );
  });

  it("refuses to resolve a platform marked unavailable", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    await expect(client.resolveAsset("latest", "linux-x64")).rejects.toThrow(
      /no available asset/,
    );
  });

  it("surfaces unknown version as REGISTRY_VERSION_NOT_FOUND", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    let caught: unknown = null;
    try {
      await client.resolveAsset("9.9.9", "darwin-arm64");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_REGISTRY_VERSION_NOT_FOUND");
    }
  });

  it("surfaces JSON parse errors as REGISTRY_UNAVAILABLE", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: {
        fetchText: async () => "{ not valid json",
        downloadToFile: async () => ({ downloadedBytes: 0, sha256: "" }),
      },
      onProgress: null,
      requireTrustedKeys: false,
    });
    let caught: unknown = null;
    try {
      await client.fetchManifest();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe("E_REGISTRY_UNAVAILABLE");
    }
  });

  it("does not lose a destination archive on a happy-path download", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
      onProgress: null,
      requireTrustedKeys: false,
    });
    const { entry, asset } = await client.resolveAsset(
      "latest",
      "darwin-arm64",
    );
    let receivedProgress = false;
    // downloadAndVerify also runs minisign verify against the URL we
    // never actually serve - we expect it to fail at the signature
    // step. Catch that and confirm we got the download progress event
    // first.
    try {
      await client.downloadAndVerify(entry, asset, () => {
        receivedProgress = true;
      });
    } catch {
      // expected: no signature provided by the fake transport
    }
    expect(receivedProgress).toBe(true);
  });
});

// Quick sanity check the test environment can construct readable temp
// files - guards against a CI where /tmp isn't writable.
describe("tmpRoot wiring", () => {
  it("creates a real temp directory", () => {
    const probe = join(tmpRoot, "probe");
    writeFileSync(probe, "ok");
    expect(statSync(probe).size).toBe(2);
  });
});
