import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSignedFeedMock: vi.fn(),
}));

vi.mock("../signed-feed", () => ({
  readSignedFeed: mocks.readSignedFeedMock,
}));

const { readSignedFeedMock } = mocks;

import {
  fetchCliVersions,
  readCliFeedCompatibilityEpoch,
} from "../cli-versions";
import { CliError } from "../../runner/errors";

function acceptedPayload(
  compatibilityEpoch: unknown,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 2,
    feed: "cli",
    target: "production",
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    generatedAt: new Date(now).toISOString(),
    latest: "1.2.0",
    expiresAt: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(),
    versions: [
      {
        version: "1.2.0",
        compatibilityEpoch,
        releaseNotesUrl: "https://example.com/notes/1.2.0",
        platforms: {},
      },
    ],
    ...overrides,
  };
}

describe("fetchCliVersions compatibilityEpoch", () => {
  beforeEach(() => {
    readSignedFeedMock.mockReset();
  });

  it("returns a stamped positive integer epoch", async () => {
    readSignedFeedMock.mockResolvedValue(acceptedPayload(2, {}));
    expect((await fetchCliVersions()).compatibilityEpoch).toBe(2);
  });

  it("returns null for a malformed stamp rather than throwing", async () => {
    for (const stamp of ["3", 2.5, 0, -1, true, null]) {
      readSignedFeedMock.mockResolvedValueOnce(acceptedPayload(stamp, {}));
      expect((await fetchCliVersions()).compatibilityEpoch).toBeNull();
    }
  });

  it("returns null when the stamp is absent", async () => {
    readSignedFeedMock.mockResolvedValue(acceptedPayload(undefined, {}));
    expect((await fetchCliVersions()).compatibilityEpoch).toBeNull();
  });

  it("still throws on the existing shape violations", async () => {
    readSignedFeedMock.mockResolvedValue(
      acceptedPayload(undefined, { schemaVersion: 3 }),
    );
    await expect(fetchCliVersions()).rejects.toBeInstanceOf(CliError);
    readSignedFeedMock.mockResolvedValue({ schemaVersion: 2 });
    await expect(fetchCliVersions()).rejects.toBeInstanceOf(CliError);
  });
});

describe("readCliFeedCompatibilityEpoch", () => {
  beforeEach(() => {
    readSignedFeedMock.mockReset();
  });

  it("returns the stamp when the feed is readable", async () => {
    readSignedFeedMock.mockResolvedValue(acceptedPayload(2, {}));
    expect(
      await readCliFeedCompatibilityEpoch(new AbortController().signal),
    ).toBe(2);
  });

  it("returns null when the feed is unreachable, never throwing", async () => {
    readSignedFeedMock.mockRejectedValue(new Error("offline"));
    expect(
      await readCliFeedCompatibilityEpoch(new AbortController().signal),
    ).toBeNull();
  });
});
