import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import {
  __resetRichSlotOrderingForTesting,
  bumpRichSlotOwnershipEpoch,
  bumpRichSlotStreamGeneration,
  createRichSlotRequest,
  readRichSlotOrdering,
  richSlotLastWriter,
  richSlotOrderingKey,
} from "../git-rich-slot-ordering";

const SLOT = {
  hostId: "host-1",
  runningDir: "/repo",
  ignoreWhitespace: false,
};

function snapshot(fingerprint: string): GitListChangedFilesResponseV11 {
  return {
    runningDir: SLOT.runningDir,
    headSha: "head",
    branch: "main",
    files: [],
    fingerprint,
    repoMode: "normal",
    repoState: { kind: "clean" },
    submodules: [],
  };
}

describe("createRichSlotRequest", () => {
  beforeEach(() => {
    __resetRichSlotOrderingForTesting();
  });

  it("returns the newer stream-written value when a unary response races it", async () => {
    const queryClient = new QueryClient();
    let resolveRequest = (_value: GitListChangedFilesResponseV11): void =>
      undefined;
    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    });
    const pending = request({ signal: new AbortController().signal });
    const key = richSlotOrderingKey(SLOT);
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      SLOT.hostId,
      SLOT.runningDir,
      SLOT.ignoreWhitespace,
    );
    const newer = snapshot("B");
    bumpRichSlotStreamGeneration(key);
    queryClient.setQueryData(richKey, newer);
    resolveRequest(snapshot("A"));

    await expect(pending).resolves.toEqual(newer);
  });

  it("reissues after an ownership epoch bump - cache is NOT authoritative for epoch drift", async () => {
    const queryClient = new QueryClient();
    const key = richSlotOrderingKey(SLOT);
    // A cached value exists, but an epoch bump (ownership/client transition)
    // proves nothing about its freshness - unlike stream-generation drift,
    // where the stream demonstrably wrote the slot mid-flight. The wrapper
    // must re-issue the request rather than resurrect the cache OR return
    // the proven-superseded first response.
    queryClient.setQueryData(
      gitQueryKeys.listChangedFilesWithSubmodules(
        SLOT.hostId,
        SLOT.runningDir,
        SLOT.ignoreWhitespace,
      ),
      snapshot("stale-cache"),
    );
    const responses = [snapshot("pre-transition"), snapshot("post-transition")];
    let calls = 0;
    const requestMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) bumpRichSlotOwnershipEpoch(key);
      return Promise.resolve(responses[calls - 1]);
    });
    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: requestMock,
    });

    await expect(
      request({ signal: new AbortController().signal }),
    ).resolves.toEqual(responses[1]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("returns the unary response when ordering is unchanged", async () => {
    const queryClient = new QueryClient();
    const response = snapshot("A");
    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: () => Promise.resolve(response),
    });

    await expect(
      request({ signal: new AbortController().signal }),
    ).resolves.toEqual(response);
  });

  it("re-issues a superseded request when the rich cache is empty", async () => {
    const queryClient = new QueryClient();
    const responses: Array<(value: GitListChangedFilesResponseV11) => void> =
      [];
    const requestMock = vi.fn(
      () =>
        new Promise<GitListChangedFilesResponseV11>((resolve) => {
          responses.push(resolve);
        }),
    );
    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: requestMock,
    });
    const pending = request({ signal: new AbortController().signal });
    bumpRichSlotOwnershipEpoch(richSlotOrderingKey(SLOT));
    responses[0](snapshot("first"));
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(responses).toHaveLength(2);
    responses[1](snapshot("second"));

    await expect(pending).resolves.toEqual(snapshot("second"));
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("throws after supersession attempts are exhausted instead of returning a proven-stale response", async () => {
    const queryClient = new QueryClient();
    const key = richSlotOrderingKey(SLOT);
    const responses = [snapshot("first"), snapshot("second"), snapshot("last")];
    let responseIndex = 0;
    const requestMock = vi.fn(() => {
      bumpRichSlotOwnershipEpoch(key);
      const response = responses[responseIndex];
      responseIndex += 1;
      return Promise.resolve(response);
    });
    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: requestMock,
    });

    // Every attempt is superseded by a fresh epoch bump and the cache stays
    // empty: the wrapper must never hand back a response it just proved
    // superseded - it throws into TanStack's retry/error machinery instead.
    await expect(
      request({ signal: new AbortController().signal }),
    ).rejects.toThrow(/superseded/u);
    expect(requestMock).toHaveBeenCalledTimes(3);
    // No accepted unary write happened, so provenance must not claim one.
    expect(richSlotLastWriter(key)).toBeNull();
  });

  it("tracks the last accepted writer across stream and unary writes", async () => {
    const queryClient = new QueryClient();
    const key = richSlotOrderingKey(SLOT);
    expect(richSlotLastWriter(key)).toBeNull();
    bumpRichSlotStreamGeneration(key);
    expect(richSlotLastWriter(key)).toBe("stream");

    const request = createRichSlotRequest({
      queryClient,
      ...SLOT,
      request: () => Promise.resolve(snapshot("unary")),
    });
    await request({ signal: new AbortController().signal });
    expect(richSlotLastWriter(key)).toBe("unary");
  });

  it("evicts the oldest rich slot ordering after the 256-slot LRU bound", () => {
    const oldest = richSlotOrderingKey({
      hostId: "host-1",
      runningDir: "/repo/0",
      ignoreWhitespace: false,
    });
    bumpRichSlotStreamGeneration(oldest);

    for (let index = 1; index <= 256; index += 1) {
      bumpRichSlotStreamGeneration(
        richSlotOrderingKey({
          hostId: "host-1",
          runningDir: `/repo/${index}`,
          ignoreWhitespace: false,
        }),
      );
    }

    expect(readRichSlotOrdering(oldest)).toEqual({
      streamGeneration: 0,
      ownershipEpoch: 0,
    });
  });

  it("never aliases two distinct slots whose fields could collide under delimiter concatenation", () => {
    // A naive `${hostId}|${runningDir}|...` join would alias these two -
    // runningDir is a filesystem path and can legitimately contain "|".
    const keyA = richSlotOrderingKey({
      hostId: "a|b",
      runningDir: "c",
      ignoreWhitespace: false,
    });
    const keyB = richSlotOrderingKey({
      hostId: "a",
      runningDir: "b|c",
      ignoreWhitespace: false,
    });
    expect(keyA).not.toBe(keyB);
  });
});
