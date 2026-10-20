import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { organizationRowScope } from "@traycer-clients/shared/view-replica/row-scope";
import { ViewReplicaService } from "@traycer-clients/shared/view-replica/service";
import {
  viewReplicaKey,
  type ViewReplicaAddress,
} from "@traycer-clients/shared/view-replica/identity";
import type {
  ViewReplicaStore,
  ViewReplicaStoredRecord,
} from "@traycer-clients/shared/view-replica/store";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import {
  historyReplicaAddress,
  historyReplicaService,
} from "@/lib/view-replica/history-replica";
import {
  ACCOUNT,
  HOST,
  OTHER_ACCOUNT,
  TEAM,
  createReplicaRig,
  type ReplicaRig,
  historyPage,
  taskIds,
  taskLight,
} from "@/lib/view-replica/__tests__/replica-fixtures";

function addressFor(accountId: string): ViewReplicaAddress {
  const address = historyReplicaAddress(
    accountId,
    HOST,
    LIST_CLOUD_TASKS_REQUEST,
  );
  if (address === null) throw new Error("Expected a History address");
  return address;
}

function stamp(observedAt: number): {
  readonly observedAt: number;
  readonly sourceGeneration: null;
} {
  return { observedAt, sourceGeneration: null };
}

function readPage(
  store: ViewReplicaStore,
  accountId: string,
): ListTasksResponse | null {
  return store.read(historyReplicaService, addressFor(accountId))?.page ?? null;
}

function mixedPage(): ListTasksResponse {
  return historyPage([taskLight("mine", null), taskLight("teams", TEAM)]);
}

/** The History service as a client with another canonical version sees it. */
function historyServiceAtVersion(
  canonicalVersion: string,
): ViewReplicaService<ListTasksResponse> {
  return new ViewReplicaService<ListTasksResponse>({
    service: historyReplicaService.service,
    canonicalVersion,
    split: (page) => historyReplicaService.split(page),
    join: (shell, rows) => historyReplicaService.join(shell, rows),
    asCached: (page, withdrawn) =>
      historyReplicaService.asCached(page, withdrawn),
  });
}

async function warmedWithPage(accountId: string): Promise<ReplicaRig> {
  const rig = createReplicaRig();
  await rig.store.warm(accountId);
  rig.store.write(
    historyReplicaService,
    addressFor(accountId),
    mixedPage(),
    stamp(100),
  );
  await rig.store.drain();
  return rig;
}

describe("ViewReplicaStore: warm and first paint", () => {
  it("reads nothing before warm, and the persisted page after, with no serving tier", async () => {
    const seeded = await warmedWithPage(ACCOUNT);

    const cold = seeded.reopen();
    expect(readPage(cold, ACCOUNT)).toBeNull();

    await cold.warm(ACCOUNT);
    const page = readPage(cold, ACCOUNT);
    expect(page === null ? null : taskIds(page)).toEqual(["mine", "teams"]);
    expect(page?.completeness?.cloudPage).toBe("unavailable");
    expect(page?.nextCursor).toBeUndefined();
  });
});

describe("ViewReplicaStore: scope withdrawal", () => {
  it("removes a team's rows from the cached page, keeps the page, and survives a reload", async () => {
    const rig = await warmedWithPage(ACCOUNT);

    await rig.store.evict({
      kind: "scope-withdrawn",
      accountId: ACCOUNT,
      scope: organizationRowScope(TEAM),
      at: 200,
    });

    const after = readPage(rig.store, ACCOUNT);
    expect(after === null ? null : taskIds(after)).toEqual(["mine"]);
    expect(after?.completeness?.facets).toBe("partial");

    const reloaded = rig.reopen();
    await reloaded.warm(ACCOUNT);
    const persisted = readPage(reloaded, ACCOUNT);
    expect(persisted === null ? null : taskIds(persisted)).toEqual(["mine"]);
    expect(persisted?.completeness?.facets).toBe("partial");
  });

  it("fences an answer observed before the withdrawal, and admits one observed after", async () => {
    const rig = await warmedWithPage(ACCOUNT);
    await rig.store.evict({
      kind: "scope-withdrawn",
      accountId: ACCOUNT,
      scope: organizationRowScope(TEAM),
      at: 200,
    });

    rig.store.write(
      historyReplicaService,
      addressFor(ACCOUNT),
      mixedPage(),
      stamp(150),
    );
    const fenced = readPage(rig.store, ACCOUNT);
    expect(fenced === null ? null : taskIds(fenced)).toEqual(["mine"]);
    expect(fenced?.completeness?.facets).toBe("partial");

    rig.store.write(
      historyReplicaService,
      addressFor(ACCOUNT),
      mixedPage(),
      stamp(250),
    );
    const admitted = readPage(rig.store, ACCOUNT);
    expect(admitted === null ? null : taskIds(admitted)).toEqual([
      "mine",
      "teams",
    ]);
  });
});

describe("ViewReplicaStore: identity mismatch is a miss", () => {
  it("misses under another canonical version and still hits under the writer's", async () => {
    const rig = await warmedWithPage(ACCOUNT);

    expect(
      rig.store.read(historyServiceAtVersion("99.0"), addressFor(ACCOUNT)),
    ).toBeNull();
    expect(readPage(rig.store, ACCOUNT)).not.toBeNull();
  });

  it("misses after the source epoch changes, and the next write purges the old page from its slot", async () => {
    const rig = await warmedWithPage(ACCOUNT);
    const address = addressFor(ACCOUNT);

    rig.store.observeSourceEpoch(ACCOUNT, address.servingTier, {
      source: "pool",
      value: "epoch-2",
    });
    expect(readPage(rig.store, ACCOUNT)).toBeNull();

    rig.store.write(
      historyReplicaService,
      address,
      historyPage([taskLight("fresh", null)]),
      stamp(300),
    );
    await rig.store.drain();
    const page = readPage(rig.store, ACCOUNT);
    expect(page === null ? null : taskIds(page)).toEqual(["fresh"]);

    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    expect((await backend.load(ACCOUNT)).records).toHaveLength(1);
  });
});

describe("ViewReplicaStore: eviction classes", () => {
  it.each([
    { kind: "transport-unavailable" },
    { kind: "credential-refused" },
  ] as const)("$kind keeps the cached pages", async (eviction) => {
    const rig = await warmedWithPage(ACCOUNT);

    await rig.store.evict(eviction);

    const page = readPage(rig.store, ACCOUNT);
    expect(page === null ? null : taskIds(page)).toEqual(["mine", "teams"]);
  });

  it("account-refused drops that account's pages and meta, and keeps another account's", async () => {
    const rig = await warmedWithPage(ACCOUNT);
    await rig.store.warm(OTHER_ACCOUNT);
    rig.store.write(
      historyReplicaService,
      addressFor(OTHER_ACCOUNT),
      mixedPage(),
      stamp(100),
    );
    rig.store.noteConfirmedWrite(ACCOUNT, historyReplicaService.service, 500);

    await rig.store.evict({ kind: "account-refused", accountId: ACCOUNT });

    expect(readPage(rig.store, ACCOUNT)).toBeNull();
    expect(readPage(rig.store, OTHER_ACCOUNT)).not.toBeNull();

    // The floor went with the account's meta: after it warms again, an old
    // page reads.
    await rig.store.warm(ACCOUNT);
    rig.store.write(
      historyReplicaService,
      addressFor(ACCOUNT),
      mixedPage(),
      stamp(100),
    );
    expect(readPage(rig.store, ACCOUNT)).not.toBeNull();

    const reloaded = rig.reopen();
    await reloaded.warm(OTHER_ACCOUNT);
    expect(readPage(reloaded, OTHER_ACCOUNT)).not.toBeNull();
  });

  it("identity-retired wipes everything and fences a write and a load already in flight", async () => {
    const rig = await warmedWithPage(ACCOUNT);

    // A load that started before the wipe must not warm the wiped store.
    const loading = rig.reopen();
    const warming = loading.warm(ACCOUNT);
    await loading.evict({ kind: "identity-retired" });
    await warming;
    expect(loading.isWarm(ACCOUNT)).toBe(false);
    expect(readPage(loading, ACCOUNT)).toBeNull();

    // A write queued before the wipe must not reach disk after it.
    await rig.store.warm(OTHER_ACCOUNT);
    rig.store.write(
      historyReplicaService,
      addressFor(OTHER_ACCOUNT),
      mixedPage(),
      stamp(100),
    );
    await rig.store.evict({ kind: "identity-retired" });
    await rig.store.drain();
    expect(readPage(rig.store, ACCOUNT)).toBeNull();

    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    expect((await backend.load(ACCOUNT)).records).toEqual([]);
    expect((await backend.load(OTHER_ACCOUNT)).records).toEqual([]);
  });
});

describe("ViewReplicaStore: read-your-write floor", () => {
  it("misses a page saved before a confirmed write and hits one saved after", async () => {
    const rig = await warmedWithPage(ACCOUNT);

    rig.store.noteConfirmedWrite(ACCOUNT, historyReplicaService.service, 300);
    expect(readPage(rig.store, ACCOUNT)).toBeNull();

    rig.store.write(
      historyReplicaService,
      addressFor(ACCOUNT),
      mixedPage(),
      stamp(400),
    );
    expect(readPage(rig.store, ACCOUNT)).not.toBeNull();
  });
});

function storedRecord(
  store: ViewReplicaStore,
  overrides: {
    readonly key: string | null;
    readonly savedAt: number;
    readonly shell: { readonly value: unknown } | null;
  },
): ViewReplicaStoredRecord {
  const identity = store.identityFor(
    historyReplicaService,
    addressFor(ACCOUNT),
  );
  const parts = historyReplicaService.split(mixedPage());
  return {
    version: 1,
    key: overrides.key ?? viewReplicaKey(identity),
    identity,
    shell: overrides.shell === null ? parts.shell : overrides.shell.value,
    rows: parts.rows,
    withdrawnScopes: [],
    savedAt: overrides.savedAt,
    sourceGeneration: null,
  };
}

describe("ViewReplicaStore: corrupt records", () => {
  it("drops and deletes a record that fails validation, and keeps the valid page", async () => {
    const rig = await warmedWithPage(ACCOUNT);
    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    await backend.write(
      [
        storedRecord(rig.store, {
          key: "corrupt-key",
          savedAt: -1,
          shell: null,
        }),
      ],
      [],
      null,
    );

    const reloaded = rig.reopen();
    await reloaded.warm(ACCOUNT);
    await reloaded.drain();

    const keys = (await backend.load(ACCOUNT)).records.map((record) => {
      const key: unknown =
        typeof record === "object" && record !== null
          ? Reflect.get(record, "key")
          : null;
      return key;
    });
    expect(keys).not.toContain("corrupt-key");
    expect(readPage(reloaded, ACCOUNT)).not.toBeNull();
  });

  it("treats a stored page whose shell no longer parses as a miss", async () => {
    const rig = await warmedWithPage(ACCOUNT);
    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    await backend.write(
      [
        storedRecord(rig.store, {
          key: null,
          savedAt: 100,
          shell: { value: 42 },
        }),
      ],
      [],
      null,
    );

    const reloaded = rig.reopen();
    await reloaded.warm(ACCOUNT);
    expect(readPage(reloaded, ACCOUNT)).toBeNull();
  });
});

describe("ViewReplicaStore: what the session records while a warm is in flight", () => {
  async function pageOnDisk(): Promise<ReplicaRig> {
    const rig = await warmedWithPage(ACCOUNT);
    return rig;
  }

  it("keeps a confirmed-write floor made before the warm resolved, and persists it", async () => {
    const rig = await pageOnDisk();
    const fresh = rig.reopen();

    const warming = fresh.warm(ACCOUNT);
    fresh.noteConfirmedWrite(ACCOUNT, historyReplicaService.service, 300);
    await warming;
    await fresh.drain();

    expect(readPage(fresh, ACCOUNT)).toBeNull();
    const next = rig.reopen();
    await next.warm(ACCOUNT);
    expect(readPage(next, ACCOUNT)).toBeNull();
  });

  it("filters a team's rows from the loaded disk page when it was withdrawn before the warm resolved, and persists it", async () => {
    const rig = await pageOnDisk();
    const fresh = rig.reopen();

    const warming = fresh.warm(ACCOUNT);
    await fresh.evict({
      kind: "scope-withdrawn",
      accountId: ACCOUNT,
      scope: organizationRowScope(TEAM),
      at: 200,
    });
    await warming;
    await fresh.drain();

    const page = readPage(fresh, ACCOUNT);
    expect(page === null ? null : taskIds(page)).toEqual(["mine"]);
    expect(page?.completeness?.facets).toBe("partial");

    const next = rig.reopen();
    await next.warm(ACCOUNT);
    const persisted = readPage(next, ACCOUNT);
    expect(persisted === null ? null : taskIds(persisted)).toEqual(["mine"]);
  });

  it("filters a disk record saved before a withdrawal that meta already holds", async () => {
    const rig = await pageOnDisk();
    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    await backend.write([], [], {
      accountId: ACCOUNT,
      epochs: {},
      floors: {},
      withdrawals: [{ scope: organizationRowScope(TEAM), at: 200 }],
    });

    const fresh = rig.reopen();
    await fresh.warm(ACCOUNT);

    const page = readPage(fresh, ACCOUNT);
    expect(page === null ? null : taskIds(page)).toEqual(["mine"]);
    expect(page?.completeness?.facets).toBe("partial");
  });

  it("account-refused during a warm: the warm brings nothing back, a queued write never lands, and a later warm reads empty disk", async () => {
    const rig = await pageOnDisk();
    const fresh = rig.reopen();

    const warming = fresh.warm(ACCOUNT);
    fresh.write(
      historyReplicaService,
      addressFor(ACCOUNT),
      historyPage([taskLight("queued", null)]),
      stamp(150),
    );
    await fresh.evict({ kind: "account-refused", accountId: ACCOUNT });
    await warming;
    await fresh.drain();

    expect(readPage(fresh, ACCOUNT)).toBeNull();
    const backend = createIndexedDbViewReplicaBackend(
      () => rig.factory,
      "replica-test",
    );
    expect((await backend.load(ACCOUNT)).records).toEqual([]);

    await fresh.warm(ACCOUNT);
    expect(fresh.isWarm(ACCOUNT)).toBe(true);
    expect(readPage(fresh, ACCOUNT)).toBeNull();
  });
});
