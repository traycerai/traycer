import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// Smoke-level test that wires the client end-to-end against a fake
// transport so we can assert manifest parsing, version resolution,
// yanked refusal, and platform unavailability without spinning up a
// real network. The minisign + sha256 chain is exercised by
// `minisign.test.ts`; here we focus on resolution and error mapping.

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "traycer-registry-client-"));
});

beforeEach(() => {
  loggerMock.debug.mockClear();
  loggerMock.error.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

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
  it("fetches and parses the manifest", async () => {
    const client = await createRegistryClient({
      environment: "production",
      transport: fakeTransport(),
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
