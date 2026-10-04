import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  PROFILE_SYNC_MAX_ITEMS,
  PROFILE_SYNC_MAX_LIST_ITEMS,
  profileSyncListSchema,
  type ProfileSyncBatch,
  type ProfileSyncItem,
  type ProfileSyncList,
  type ProfileSyncRule,
} from "@traycer/protocol/host/profile-sync-schemas";
import { createAppQueryClient } from "@/lib/query-client";
import {
  profileSyncListKey,
  writeProfileSyncBatch,
  writeProfileSyncSavedRule,
  writeProfileSyncStoppedRule,
} from "@/hooks/providers/profile-sync-cache";

const SOURCE = "source-host";

function uuid(n: number): string {
  return `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function item(n: number): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: uuid(100_000 + n),
    name: "Work",
    destinationHostId: "dest-host",
    operationId: uuid(200_000 + n),
    preview: null,
    outcome: null,
    state: "synced",
    sourceSettings: { name: "Work", color: "#ef4444", enabled: true },
    sourceIdentityStamp: "c".repeat(64),
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

function batch(n: number, items: readonly ProfileSyncItem[]): ProfileSyncBatch {
  return {
    batchId: uuid(n),
    sourceHostId: SOURCE,
    createdAt: n,
    automatic: false,
    items: [...items],
  };
}

function rule(n: number, revision: number): ProfileSyncRule {
  return {
    ruleId: uuid(300_000 + n),
    sourceHostId: SOURCE,
    destinationHostId: `dest-${String(n)}`,
    scope: { kind: "all" },
    paused: false,
    revision,
    lastCheckedAt: null,
    batchId: null,
    status: "waiting",
  };
}

function seeded(list: ProfileSyncList) {
  const queryClient = createAppQueryClient();
  queryClient.setQueryData<ProfileSyncList>(profileSyncListKey(SOURCE), list);
  return queryClient;
}
const read = (queryClient: QueryClient) =>
  queryClient.getQueryData<ProfileSyncList>(profileSyncListKey(SOURCE));

describe("writeProfileSyncBatch", () => {
  it("adds a batch beside its siblings and the rules, creating the list when absent", () => {
    const first = batch(1, [item(1)]);
    const second = batch(2, [item(2)]);
    const r = rule(1, 1);
    const queryClient = seeded({ batches: [first], rules: [r] });
    writeProfileSyncBatch(queryClient, second);
    expect(read(queryClient)).toEqual({ batches: [first, second], rules: [r] });

    const empty = createAppQueryClient();
    writeProfileSyncBatch(empty, first);
    expect(read(empty)).toEqual({ batches: [first], rules: [] });
  });

  it("replaces the same batch id with the accepted batch, without duplicating it", () => {
    const first = batch(1, [item(1)]);
    const other = batch(2, [item(2)]);
    const accepted = batch(1, [item(1), item(3)]);
    const queryClient = seeded({ batches: [first, other], rules: [] });
    writeProfileSyncBatch(queryClient, accepted);
    const batches = read(queryClient)?.batches ?? [];
    expect(batches.filter((b) => b.batchId === accepted.batchId)).toEqual([
      accepted,
    ]);
    expect(batches).toHaveLength(2);
    expect(batches).toContainEqual(other);
  });

  it("keeps the full history within the schema budget when an accepted whole batch is added", () => {
    const full = Array.from({ length: PROFILE_SYNC_MAX_ITEMS }, (_unused, n) =>
      item(n),
    );
    const history = Array.from({ length: 8 }, (_unused, n) =>
      batch(n + 1, full),
    );
    expect(history.reduce((total, b) => total + b.items.length, 0)).toBe(
      PROFILE_SYNC_MAX_LIST_ITEMS,
    );
    const accepted = batch(99, [item(900_000)]);
    const queryClient = seeded({ batches: history, rules: [] });
    writeProfileSyncBatch(queryClient, accepted);
    const result = read(queryClient);
    if (result === undefined) throw new Error("list was not written");
    // Whole batches only: the oldest one makes room, and the new one is kept.
    expect(result.batches.at(-1)).toEqual(accepted);
    expect(result.batches).not.toContainEqual(history[0]);
    expect(result.batches.slice(0, -1)).toEqual(history.slice(1));
    expect(
      result.batches.reduce((total, b) => total + b.items.length, 0),
    ).toBeLessThanOrEqual(PROFILE_SYNC_MAX_LIST_ITEMS);
    expect(profileSyncListSchema.safeParse(result).success).toBe(true);
  });
});

describe("writeProfileSyncSavedRule", () => {
  it("adds a rule beside its siblings and the batches", () => {
    const b = batch(1, [item(1)]);
    const first = rule(1, 1);
    const second = rule(2, 1);
    const queryClient = seeded({ batches: [b], rules: [first] });
    writeProfileSyncSavedRule(queryClient, second, undefined);
    expect(read(queryClient)).toEqual({
      batches: [b],
      rules: [first, second],
    });
  });

  it("replaces the same rule with its accepted newer revision", () => {
    const old = rule(1, 1);
    const accepted = { ...old, paused: true, revision: 2 };
    const queryClient = seeded({ batches: [], rules: [old] });
    writeProfileSyncSavedRule(queryClient, accepted, old);
    expect(read(queryClient)?.rules).toEqual([accepted]);
  });

  it("does not regress a rule already at a higher revision", () => {
    const newer = { ...rule(1, 5), paused: true };
    const queryClient = seeded({ batches: [], rules: [newer] });
    writeProfileSyncSavedRule(
      queryClient,
      {
        ...newer,
        paused: false,
        revision: 3,
      },
      newer,
    );
    expect(read(queryClient)?.rules).toEqual([newer]);
  });
});

describe("writeProfileSyncStoppedRule", () => {
  it("removes only the stopped rule and keeps a newer sibling and the batches", () => {
    const b = batch(1, [item(1)]);
    const stopped = rule(1, 1);
    const sibling = rule(2, 4);
    const queryClient = seeded({ batches: [b], rules: [stopped, sibling] });
    // The response may predate the sibling's newer write; it is not trusted
    // for anything but the one removal.
    writeProfileSyncStoppedRule(queryClient, SOURCE, stopped.ruleId, {
      batches: [],
      rules: [{ ...sibling, revision: 1 }],
    });
    expect(read(queryClient)).toEqual({ batches: [b], rules: [sibling] });
  });

  it("falls back to the response when nothing is cached, still without the stopped rule", () => {
    const stopped = rule(1, 1);
    const other = rule(2, 1);
    const queryClient = createAppQueryClient();
    writeProfileSyncStoppedRule(queryClient, SOURCE, stopped.ruleId, {
      batches: [],
      rules: [stopped, other],
    });
    expect(read(queryClient)?.rules).toEqual([other]);
  });
});

describe("writeProfileSyncSavedRule against what changed since dispatch", () => {
  const submitted = rule(1, 1);
  const accepted = { ...submitted, paused: true, revision: 2 };

  it("keeps a different rule that now holds the destination and does not add the late answer", () => {
    const current: ProfileSyncRule = {
      ...rule(1, 1),
      ruleId: uuid(399_999),
    };
    const queryClient = seeded({ batches: [], rules: [current] });
    writeProfileSyncSavedRule(queryClient, accepted, submitted);
    expect(read(queryClient)?.rules).toEqual([current]);
  });

  it("does not resurrect a submitted rule that was observed removed", () => {
    const sibling = rule(2, 1);
    const queryClient = seeded({ batches: [], rules: [sibling] });
    writeProfileSyncSavedRule(queryClient, accepted, submitted);
    expect(read(queryClient)?.rules).toEqual([sibling]);
  });

  it("still applies the answer when the submitted rule is the one cached", () => {
    const queryClient = seeded({ batches: [], rules: [submitted] });
    writeProfileSyncSavedRule(queryClient, accepted, submitted);
    expect(read(queryClient)?.rules).toEqual([accepted]);
  });
});
