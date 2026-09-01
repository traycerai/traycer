import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTextMock: vi.fn(),
}));

vi.mock("../fetch-resource", () => ({
  fetchText: mocks.fetchTextMock,
}));

const { fetchTextMock } = mocks;

import {
  fetchCliVersions,
  readCliFeedCompatibilityEpoch,
} from "../cli-versions";
import { CliError } from "../../runner/errors";

function body(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-05-15T12:00:00Z",
    latest: "1.2.0",
    version: "1.2.0",
    releaseNotesUrl: "https://example.com/notes/1.2.0",
    platforms: {},
    ...overrides,
  });
}

describe("fetchCliVersions compatibilityEpoch", () => {
  beforeEach(() => {
    fetchTextMock.mockReset();
  });

  it("returns a stamped positive integer epoch", async () => {
    fetchTextMock.mockResolvedValue(body({ compatibilityEpoch: 2 }));
    expect((await fetchCliVersions()).compatibilityEpoch).toBe(2);
  });

  it("returns null for a malformed stamp rather than throwing", async () => {
    for (const stamp of ["3", 2.5, 0, -1, true, null]) {
      fetchTextMock.mockResolvedValueOnce(body({ compatibilityEpoch: stamp }));
      expect((await fetchCliVersions()).compatibilityEpoch).toBeNull();
    }
  });

  it("returns null when the stamp is absent", async () => {
    fetchTextMock.mockResolvedValue(body({}));
    expect((await fetchCliVersions()).compatibilityEpoch).toBeNull();
  });

  it("still throws on the existing shape violations", async () => {
    fetchTextMock.mockResolvedValue(body({ schemaVersion: 2 }));
    await expect(fetchCliVersions()).rejects.toBeInstanceOf(CliError);
    fetchTextMock.mockResolvedValue("{ not json");
    await expect(fetchCliVersions()).rejects.toBeInstanceOf(CliError);
  });
});

describe("readCliFeedCompatibilityEpoch", () => {
  beforeEach(() => {
    fetchTextMock.mockReset();
  });

  it("returns the stamp when the feed is readable", async () => {
    fetchTextMock.mockResolvedValue(body({ compatibilityEpoch: 2 }));
    expect(
      await readCliFeedCompatibilityEpoch(new AbortController().signal),
    ).toBe(2);
  });

  it("returns null when the feed is unreachable, never throwing", async () => {
    fetchTextMock.mockRejectedValue(new Error("offline"));
    expect(
      await readCliFeedCompatibilityEpoch(new AbortController().signal),
    ).toBeNull();
  });
});
