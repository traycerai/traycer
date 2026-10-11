import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  type GitGetFileDiffResponse,
  type GitStage,
} from "@traycer/protocol/host";
import { createAppQueryClient } from "@/lib/query-client";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeBatchedDiffResponses } from "@/lib/git/write-batched-diff-responses";

// `installDiffBodyCacheRetention` runs off aggregate UTF-16 byte accounting
// (`patch.length * 2`), so these fixtures build patches at a size relative to
// its 32 MiB budget rather than asserting exact numbers.
const MAX_DIFF_BODY_BYTES = 32 * 1024 * 1024;

const HOST_ID = "host-1";
const RUNNING_DIR = "/repo";
const STAGE: GitStage = "unstaged";

function diffResponse(args: {
  readonly filePath: string;
  readonly headSha: string;
  readonly stagedOid?: string | null;
  readonly worktreeOid?: string | null;
  readonly patch: string;
}): GitGetFileDiffResponse {
  return {
    filePath: args.filePath,
    headSha: args.headSha,
    stagedOid: args.stagedOid ?? null,
    worktreeOid: args.worktreeOid ?? "wt-1",
    patch: args.patch,
    isTruncated: false,
    truncatedAfterBytes: null,
    isBinary: false,
  };
}

function fileDiffKey(args: {
  readonly filePath: string;
  readonly previousPath?: string | null;
  readonly headSha: string;
  readonly stagedOid?: string | null;
  readonly worktreeOid?: string | null;
  readonly ignoreWhitespace?: boolean;
  readonly byteBudget?: number | null;
}) {
  return gitQueryKeys.fileDiff(
    HOST_ID,
    RUNNING_DIR,
    args.filePath,
    args.previousPath ?? null,
    STAGE,
    args.headSha,
    args.stagedOid ?? null,
    args.worktreeOid ?? "wt-1",
    args.ignoreWhitespace ?? false,
    args.byteBudget ?? DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  );
}

/** A patch string whose UTF-16 accounted size (`length * 2`) is `bytes`. */
function patchOfBytes(bytes: number): string {
  return "p".repeat(Math.ceil(bytes / 2));
}

/** Writes one diff body via `setQueryData`, the direct cache-write path a
 * reconciled read or an optimistic patch uses. Returns its key. */
function writeDiff(
  client: QueryClient,
  args: Parameters<typeof fileDiffKey>[0] & { readonly patch: string },
): readonly unknown[] {
  const key = fileDiffKey(args);
  client.setQueryData(key, diffResponse(args));
  return key;
}

/** Writes one diff body via `fetchQuery`, the real unary-query write path. */
async function fetchDiff(
  client: QueryClient,
  args: Parameters<typeof fileDiffKey>[0] & { readonly patch: string },
): Promise<readonly unknown[]> {
  const key = fileDiffKey(args);
  await client.fetchQuery({
    queryKey: key,
    queryFn: () => Promise.resolve(diffResponse(args)),
  });
  return key;
}

/** Attaches a live, non-fetching observer to `key` so its query counts as
 * actively read. Returns the detach function. */
function observe(client: QueryClient, key: readonly unknown[]): () => void {
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => Promise.resolve(undefined),
    enabled: false,
  });
  return observer.subscribe(() => undefined);
}

describe("installDiffBodyCacheRetention", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = createAppQueryClient();
  });

  afterEach(() => {
    client.clear();
  });

  it("leaves an unrelated query and every diff body untouched while the aggregate budget is not exceeded", async () => {
    const unrelatedKey = gitQueryKeys.listChangedFiles(
      HOST_ID,
      RUNNING_DIR,
      false,
    );
    client.setQueryData(unrelatedKey, { tasks: [] });

    const keyA = writeDiff(client, {
      filePath: "a.ts",
      headSha: "head-1",
      patch: "small patch a",
    });
    const keyB = await fetchDiff(client, {
      filePath: "b.ts",
      headSha: "head-1",
      patch: "small patch b",
    });
    // The batched-diffs writer is a third real production write path into
    // the same cache; it must be governed by the same retention, not bypass it.
    const responseC = diffResponse({
      filePath: "c.ts",
      headSha: "head-1",
      patch: "small patch c",
    });
    writeBatchedDiffResponses({
      queryClient: client,
      hostId: HOST_ID,
      runningDir: RUNNING_DIR,
      requestFiles: [{ filePath: "c.ts", previousPath: null, stage: STAGE }],
      ignoreWhitespace: false,
      diffs: [responseC],
    });
    const keyC = fileDiffKey({
      filePath: "c.ts",
      headSha: responseC.headSha,
      stagedOid: responseC.stagedOid,
      worktreeOid: responseC.worktreeOid,
    });

    expect(client.getQueryState(unrelatedKey)?.data).toEqual({ tasks: [] });
    expect(client.getQueryState(keyA)?.data).toBeDefined();
    expect(client.getQueryState(keyB)?.data).toBeDefined();
    expect(client.getQueryState(keyC)?.data).toEqual(responseC);
  });

  it("evicts the least-recently-accessed inactive diff body once the aggregate budget is exceeded, sparing an actively observed one and an unrelated query", () => {
    const unrelatedKey = gitQueryKeys.listChangedFiles(
      HOST_ID,
      RUNNING_DIR,
      false,
    );
    client.setQueryData(unrelatedKey, { tasks: [] });

    // Three of these fit comfortably under the 32 MiB budget; a fourth pushes
    // the aggregate over it by design.
    const BODY_BYTES = 10_000_000;

    // Observed for the whole test - exempt from removal regardless of order
    // or size.
    const keyObserved = writeDiff(client, {
      filePath: "observed.ts",
      headSha: "head-1",
      patch: patchOfBytes(BODY_BYTES),
    });
    const detachObserved = observe(client, keyObserved);

    const keyA = writeDiff(client, {
      filePath: "a.ts",
      headSha: "head-1",
      patch: patchOfBytes(BODY_BYTES),
    });
    const keyB = writeDiff(client, {
      filePath: "b.ts",
      headSha: "head-1",
      patch: patchOfBytes(BODY_BYTES),
    });
    // observed + A + B is still under budget - nothing evicted yet.
    expect(client.getQueryState(keyA)?.data).toBeDefined();
    expect(client.getQueryState(keyB)?.data).toBeDefined();

    // A real reader looks at A and leaves. This must promote A ahead of B in
    // eviction order - a genuine LRU touch, not pure write-order FIFO.
    const detachA = observe(client, keyA);
    detachA();

    const keyC = writeDiff(client, {
      filePath: "c.ts",
      headSha: "head-1",
      patch: patchOfBytes(BODY_BYTES),
    });

    // Four bodies now exceed the budget. B is the least-recently-accessed
    // inactive one (A was touched after B was written), so it is the one
    // removed; A (touched) and C (newest) both survive, and so does the
    // actively observed body and the unrelated query.
    expect(client.getQueryState(keyB)).toBeUndefined();
    expect(client.getQueryState(keyA)?.data).toBeDefined();
    expect(client.getQueryState(keyC)?.data).toBeDefined();
    expect(client.getQueryState(keyObserved)?.data).toBeDefined();
    expect(client.getQueryState(unrelatedKey)?.data).toEqual({ tasks: [] });

    detachObserved();
  });

  it("keeps an oversized observed diff body cached despite exceeding the budget alone, then sweeps it once its last observer detaches", () => {
    const key = fileDiffKey({ filePath: "huge.ts", headSha: "head-1" });
    const detach = observe(client, key);

    client.setQueryData(
      key,
      diffResponse({
        filePath: "huge.ts",
        headSha: "head-1",
        // Alone, already over the aggregate budget.
        patch: patchOfBytes(MAX_DIFF_BODY_BYTES + 1_000_000),
      }),
    );
    expect(client.getQueryState(key)?.data).toBeDefined();

    detach();
    expect(client.getQueryState(key)).toBeUndefined();
  });

  it("supersedes and sweeps an older unobserved revision on the last-observer detach, while a same-revision whitespace/budget variant survives", () => {
    const keyRevisionOne = writeDiff(client, {
      filePath: "s.ts",
      headSha: "head-1",
      worktreeOid: "wt-1",
      patch: "revision one",
    });
    const detachRevisionOne = observe(client, keyRevisionOne);

    // A new revision for the SAME identity (host/root/path/stage) marks the
    // old one superseded, but it stays cached while actively observed.
    const keyRevisionTwo = writeDiff(client, {
      filePath: "s.ts",
      headSha: "head-2",
      worktreeOid: "wt-2",
      patch: "revision two",
    });
    expect(client.getQueryState(keyRevisionOne)?.data).toBeDefined();
    expect(client.getQueryState(keyRevisionTwo)?.data).toBeDefined();

    // Same OIDs as revision two, only `ignoreWhitespace` differs - a variant
    // of the SAME revision, not a supersede of it.
    const keyRevisionTwoVariant = writeDiff(client, {
      filePath: "s.ts",
      headSha: "head-2",
      worktreeOid: "wt-2",
      ignoreWhitespace: true,
      patch: "revision two, whitespace-ignored",
    });

    // Dropping revision one's last observer is the only thing that can sweep
    // it now - a superseded body with an active reader is never force-evicted.
    detachRevisionOne();
    expect(client.getQueryState(keyRevisionOne)).toBeUndefined();
    // The current revision and its variant are both untouched by that sweep.
    expect(client.getQueryState(keyRevisionTwo)?.data).toBeDefined();
    expect(client.getQueryState(keyRevisionTwoVariant)?.data).toBeDefined();
  });

  it("removes an invalidated diff body immediately while lease-free, but only on last-observer detach while active", () => {
    const keyInactive = writeDiff(client, {
      filePath: "inactive.ts",
      headSha: "head-1",
      patch: "inactive body",
    });
    const keyActive = writeDiff(client, {
      filePath: "active.ts",
      headSha: "head-1",
      patch: "active body",
    });
    const detachActive = observe(client, keyActive);

    void client.invalidateQueries({
      queryKey: keyInactive,
      exact: true,
      refetchType: "none",
    });
    expect(client.getQueryState(keyInactive)).toBeUndefined();

    void client.invalidateQueries({
      queryKey: keyActive,
      exact: true,
      refetchType: "none",
    });
    // Invalidated, but still read - survives until the last observer leaves.
    expect(client.getQueryState(keyActive)?.data).toBeDefined();

    detachActive();
    expect(client.getQueryState(keyActive)).toBeUndefined();
  });
});
