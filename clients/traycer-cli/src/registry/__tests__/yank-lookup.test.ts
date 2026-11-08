import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSignedFeedMock: vi.fn(),
  createCliLoggerMock: vi.fn(),
}));

vi.mock("../signed-feed", () => ({
  readSignedFeed: mocks.readSignedFeedMock,
}));

vi.mock("../../logger", () => ({
  createCliLogger: mocks.createCliLoggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const { readSignedFeedMock, createCliLoggerMock } = mocks;

import { createRegistryYankLookup } from "../client";

const feedGeneratedAt = Date.now();
const VALID_MANIFEST = {
  schemaVersion: 2,
  feed: "host",
  target: "production",
  policyRevision: 1,
  policyDigest: "a".repeat(64),
  generatedAt: new Date(feedGeneratedAt).toISOString(),
  expiresAt: new Date(feedGeneratedAt + 90 * 24 * 60 * 60 * 1000).toISOString(),
  latest: "2.0.0",
  versions: [
    {
      version: "2.0.0",
      releasedAt: "2026-05-15T12:00:00Z",
      releaseNotesUrl: "https://example.com/notes/2.0.0",
      yanked: true,
      deprecationReason: "test",
      requiredCliVersion: null,
      platforms: {},
    },
    {
      version: "1.7.2",
      releasedAt: "2026-04-01T00:00:00Z",
      releaseNotesUrl: "https://example.com/notes/1.7.2",
      yanked: false,
      deprecationReason: null,
      requiredCliVersion: null,
      platforms: {},
    },
  ],
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  createCliLoggerMock.mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  });
  readSignedFeedMock.mockResolvedValue(VALID_MANIFEST);
});

describe("createRegistryYankLookup", () => {
  it("returns the manifest's yank state and fails open for an absent entry", async () => {
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(true);
    await expect(lookup.isVersionYanked("9.9.9")).resolves.toBe(false);
    expect(readSignedFeedMock).toHaveBeenCalledTimes(1);
  });

  it("fails open on network failure", async () => {
    readSignedFeedMock.mockRejectedValue(new Error("offline"));
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(false);
  });

  it("fails open on invalid manifest", async () => {
    readSignedFeedMock.mockResolvedValue({ schemaVersion: 3 });
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(false);
  });

  it("fails open when a blackholed request is ended by the lookup watchdog", async () => {
    vi.useFakeTimers();
    let signalAborted = false;
    readSignedFeedMock.mockImplementation(
      (opts: { readonly signal: AbortSignal }) => {
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          if (opts.signal.aborted) {
            signalAborted = true;
            reject(new Error("aborted"));
            return;
          }
          opts.signal.addEventListener(
            "abort",
            () => {
              signalAborted = opts.signal.aborted;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    );
    const lookup = createRegistryYankLookup("production");
    const result = lookup.isVersionYanked("2.0.0");

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe(false);
    expect(signalAborted).toBe(true);
  });
});
