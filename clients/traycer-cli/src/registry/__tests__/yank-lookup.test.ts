import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTextMock: vi.fn(),
  createCliLoggerMock: vi.fn(),
}));

vi.mock("../fetch-resource", () => ({
  fetchText: mocks.fetchTextMock,
  downloadToFile: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: mocks.createCliLoggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const { fetchTextMock, createCliLoggerMock } = mocks;

import { createRegistryYankLookup } from "../client";

const VALID_MANIFEST = {
  schemaVersion: 1,
  generatedAt: "2026-05-15T12:00:00Z",
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
  fetchTextMock.mockResolvedValue(JSON.stringify(VALID_MANIFEST));
});

describe("createRegistryYankLookup", () => {
  it("returns the manifest's yank state and fails open for an absent entry", async () => {
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(true);
    await expect(lookup.isVersionYanked("9.9.9")).resolves.toBe(false);
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
  });

  it("fails open on network failure", async () => {
    fetchTextMock.mockRejectedValue(new Error("offline"));
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(false);
  });

  it("fails open on invalid JSON", async () => {
    fetchTextMock.mockResolvedValue("not-json");
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(false);
  });

  it("fails open on invalid manifest", async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ schemaVersion: 2 }));
    const lookup = createRegistryYankLookup("production");

    await expect(lookup.isVersionYanked("2.0.0")).resolves.toBe(false);
  });

  it("fails open when a blackholed request is ended by the lookup watchdog", async () => {
    vi.useFakeTimers();
    let signalAborted = false;
    fetchTextMock.mockImplementation(
      (_url: string, opts: { readonly signal: AbortSignal }) => {
        return new Promise<string>((_resolve, reject) => {
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
