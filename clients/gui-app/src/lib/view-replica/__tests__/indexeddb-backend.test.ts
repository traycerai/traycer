import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { viewReplicaKey } from "@traycer-clients/shared/view-replica/identity";
import { ACCOUNT_ROW_SCOPE } from "@traycer-clients/shared/view-replica/row-scope";
import type {
  ViewReplicaBackend,
  ViewReplicaAccountMeta,
  ViewReplicaStoredRecord,
} from "@traycer-clients/shared/view-replica/store";

function record(
  accountId: string,
  requestScope: string,
): ViewReplicaStoredRecord {
  const identity = {
    accountId,
    service: "test.list",
    servingTier: "host-1",
    requestScope,
    sourceEpoch: null,
    canonicalVersion: "1.0",
  };
  return {
    version: 1,
    key: viewReplicaKey(identity),
    identity,
    shell: { hasMore: false },
    rows: [{ scope: ACCOUNT_ROW_SCOPE, value: { id: requestScope } }],
    withdrawnScopes: [],
    savedAt: 10,
    sourceGeneration: null,
  };
}

function meta(accountId: string): ViewReplicaAccountMeta {
  return {
    accountId,
    epochs: { "host-1": { source: "pool", value: "e1" } },
    floors: { "test.list": 5 },
    withdrawals: [{ scope: { kind: "organization", id: "team-1" }, at: 7 }],
  };
}

function setup(): ViewReplicaBackend {
  const factory = new IDBFactory();
  return createIndexedDbViewReplicaBackend(() => factory, "backend-test");
}

describe("createIndexedDbViewReplicaBackend", () => {
  it("round-trips records and meta, per account", async () => {
    const backend = setup();
    const first = record("user-a", "one");
    const other = record("user-b", "two");
    await backend.write([first, other], [], meta("user-a"));

    const loaded = await backend.load("user-a");

    expect(loaded.records).toEqual([first]);
    expect(loaded.meta).toEqual(meta("user-a"));
    expect((await backend.load("user-b")).meta).toBeNull();
  });

  it("deletes named records in the same transaction as a write", async () => {
    const backend = setup();
    const old = record("user-a", "old");
    const next = record("user-a", "next");
    await backend.write([old], [], null);

    await backend.write([next], [old.key], null);

    expect((await backend.load("user-a")).records).toEqual([next]);
  });

  it("deleteAccount removes that account's records and meta only", async () => {
    const backend = setup();
    await backend.write(
      [record("user-a", "one"), record("user-b", "two")],
      [],
      meta("user-a"),
    );

    await backend.deleteAccount("user-a");

    expect(await backend.load("user-a")).toEqual({ records: [], meta: null });
    expect((await backend.load("user-b")).records).toHaveLength(1);
  });

  it("clear removes every account", async () => {
    const backend = setup();
    await backend.write(
      [record("user-a", "one"), record("user-b", "two")],
      [],
      meta("user-b"),
    );

    await backend.clear();

    expect(await backend.load("user-a")).toEqual({ records: [], meta: null });
    expect(await backend.load("user-b")).toEqual({ records: [], meta: null });
  });

  it("reads as empty and drops writes when no IndexedDB exists", async () => {
    const backend = createIndexedDbViewReplicaBackend(() => undefined, "none");

    await backend.write([record("user-a", "one")], [], null);

    expect(await backend.load("user-a")).toEqual({ records: [], meta: null });
  });
});
