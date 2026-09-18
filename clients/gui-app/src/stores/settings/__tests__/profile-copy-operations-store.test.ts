import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PERSIST_VERSION,
  profileCopyOperationsKey,
} from "@/lib/persist";
import {
  previewRecord,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  PROFILE_COPY_DISPOSITIONS,
  PROFILE_COPY_MANUAL_ROUTES,
  PROFILE_COPY_PROVIDERS,
} from "@/lib/profile-copy/profile-copy-model";
import {
  PROFILE_COPY_MAX_HANDLES,
  useProfileCopyOperationsStore,
  type ProfileCopyOperationHandle,
} from "@/stores/settings/profile-copy-operations-store";
import {
  profileCopyFeasibilitySchema,
  profileCopyPreviewDestinationSchema,
  profileCopyProviderSchema,
} from "@traycer/protocol/host/profile-copy-schemas";

const PERSIST_KEY = profileCopyOperationsKey(null);

const HANDLE_FIELDS = [
  "operationId",
  "sourceHostId",
  "sourceProfileId",
  "providerId",
  "destinationHostIds",
  "previewRevision",
  "previewRecords",
  "createdAt",
  "startAcknowledged",
  "cancelConfirmedAt",
] as const;

const PREVIEW_RECORD_FIELDS = [
  "destinationHostId",
  "disposition",
  "reason",
  "manualRoute",
  "destinationProviderEnabled",
] as const;

function flushPersist(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function handle(
  overrides: Partial<ProfileCopyOperationHandle>,
): ProfileCopyOperationHandle {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    sourceHostId: SOURCE_HOST_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    providerId: "claude",
    destinationHostIds: ["dest-host"],
    previewRevision: "a".repeat(64),
    previewRecords: [previewRecord({})],
    createdAt: 1_000,
    startAcknowledged: false,
    cancelConfirmedAt: null,
    ...overrides,
  };
}

function storedHandles(): unknown {
  const raw = window.localStorage.getItem(PERSIST_KEY);
  const parsed: unknown = JSON.parse(raw ?? "{}");
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    return null;
  }
  const state = parsed.state;
  if (typeof state !== "object" || state === null || !("handles" in state)) {
    return null;
  }
  return state.handles;
}

/** The first element of a persisted array, when it is an object. */
function firstObjectEntry(value: unknown): object | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return typeof first === "object" && first !== null ? first : null;
}

// The cross-window storage remembers, for the window's lifetime, every
// handle this window removed - and `resetStore`'s empty write counts as
// removing every handle an earlier test wrote. The cross-window tests below
// therefore use operation ids no other test in this file uses.
async function resetStore(): Promise<void> {
  window.localStorage.clear();
  useProfileCopyOperationsStore.persist.setOptions({ name: PERSIST_KEY });
  await useProfileCopyOperationsStore.persist.rehydrate();
  useProfileCopyOperationsStore.setState({ handles: [] });
}

describe("useProfileCopyOperationsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("records newest first and caps at 20", () => {
    for (let index = 0; index < 22; index += 1) {
      useProfileCopyOperationsStore.getState().record(
        handle({
          operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
          createdAt: index,
        }),
      );
    }
    const handles = useProfileCopyOperationsStore.getState().handles;
    expect(handles).toHaveLength(PROFILE_COPY_MAX_HANDLES);
    expect(handles[0]?.createdAt).toBe(21);
    expect(handles[handles.length - 1]?.createdAt).toBe(2);
  });

  it("acknowledgeStart and markCancelConfirmed are monotonic", () => {
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-a", startAcknowledged: false }));
    useProfileCopyOperationsStore.getState().acknowledgeStart("op-a");
    useProfileCopyOperationsStore.getState().acknowledgeStart("op-a");
    expect(
      useProfileCopyOperationsStore.getState().handles[0]?.startAcknowledged,
    ).toBe(true);

    useProfileCopyOperationsStore.getState().markCancelConfirmed("op-a", 50);
    useProfileCopyOperationsStore.getState().markCancelConfirmed("op-a", 90);
    expect(
      useProfileCopyOperationsStore.getState().handles[0]?.cancelConfirmedAt,
    ).toBe(50);
  });

  it("remove forgets a handle without cancelling", () => {
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-a" }));
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-b", createdAt: 2_000 }));
    useProfileCopyOperationsStore.getState().remove("op-a");
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).toEqual(["op-b"]);
  });

  it("hydrates by dropping malformed handles field by field", async () => {
    const valid = handle({ operationId: "op-valid", createdAt: 9 });
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          handles: [
            valid,
            { ...valid, operationId: "" },
            { ...valid, operationId: "op-empty-dest", destinationHostIds: [] },
            { ...valid, operationId: "op-bad-provider", providerId: "copilot" },
            {
              ...valid,
              operationId: "op-bad-reason",
              previewRecords: [
                { ...previewRecord({}), reason: "not-a-reason" },
              ],
            },
            { ...valid, operationId: "op-not-bool", startAcknowledged: "yes" },
            null,
            "nope",
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useProfileCopyOperationsStore.persist.rehydrate();
    // Scalar fields drop the whole handle; a malformed entry in a nested list
    // (a preview record, a destination id) is dropped on its own and the
    // handle kept, so the operation can still be reopened.
    const hydrated = useProfileCopyOperationsStore.getState().handles;
    expect(hydrated.map((entry) => entry.operationId)).toEqual([
      "op-valid",
      "op-bad-reason",
    ]);
    expect(
      hydrated.find((entry) => entry.operationId === "op-bad-reason")
        ?.previewRecords,
    ).toEqual([]);
  });

  it("persists exactly the handle fields — no challenge, code, credential or email", async () => {
    useProfileCopyOperationsStore.getState().record(
      handle({
        operationId: "op-a",
        previewRecords: [previewRecord({ reason: "update-required" })],
      }),
    );
    await flushPersist();
    const stored = storedHandles();
    expect(Array.isArray(stored)).toBe(true);
    const rows: ReadonlyArray<Record<string, unknown>> = Array.isArray(stored)
      ? stored.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        )
      : [];
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0] ?? {}).sort();
    expect(keys).toEqual([...HANDLE_FIELDS].sort());
    expect(keys).not.toContain("challenge");
    expect(keys).not.toContain("code");
    expect(keys).not.toContain("credential");
    expect(keys).not.toContain("email");
    const records = rows[0]?.previewRecords;
    expect(Array.isArray(records)).toBe(true);
    const recordKeys = Object.keys(firstObjectEntry(records) ?? {}).sort();
    expect(recordKeys).toEqual([...PREVIEW_RECORD_FIELDS].sort());
  });

  it("keeps another window's handle on write", async () => {
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-keep-a", createdAt: 1 }));
    await flushPersist();

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          handles: [
            handle({ operationId: "op-keep-a", createdAt: 1 }),
            handle({ operationId: "op-keep-b", createdAt: 2 }),
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-keep-c", createdAt: 3 }));
    await flushPersist();

    const stored = storedHandles();
    expect(Array.isArray(stored)).toBe(true);
    const ids = Array.isArray(stored)
      ? stored
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => entry.operationId)
      : [];
    expect(ids).toEqual(["op-keep-c", "op-keep-b", "op-keep-a"]);

    useProfileCopyOperationsStore.getState().acknowledgeStart("op-keep-c");
    await flushPersist();
    const afterAck = storedHandles();
    const afterAckIds = Array.isArray(afterAck)
      ? afterAck
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => entry.operationId)
      : [];
    expect(afterAckIds).toEqual(["op-keep-c", "op-keep-b", "op-keep-a"]);
  });

  it("keeps a handle this window removed from coming back on write", async () => {
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-removed-a", createdAt: 1 }));
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-removed-b", createdAt: 2 }));
    await flushPersist();

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          handles: [
            handle({ operationId: "op-removed-a", createdAt: 1 }),
            handle({ operationId: "op-removed-b", createdAt: 2 }),
            handle({ operationId: "op-removed-c", createdAt: 3 }),
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    useProfileCopyOperationsStore.getState().remove("op-removed-a");
    await flushPersist();

    const stored = storedHandles();
    const ids = Array.isArray(stored)
      ? stored
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => entry.operationId)
      : [];
    expect(ids).toEqual(["op-removed-c", "op-removed-b"]);
    expect(ids).not.toContain("op-removed-a");
  });

  it("forgets a removal after rehydrate so another window can write the id back", async () => {
    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-restore-a", createdAt: 1 }));
    await flushPersist();
    useProfileCopyOperationsStore.getState().remove("op-restore-a");
    await flushPersist();

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          handles: [handle({ operationId: "op-restore-a", createdAt: 1 })],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useProfileCopyOperationsStore.persist.rehydrate();
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).toEqual(["op-restore-a"]);

    useProfileCopyOperationsStore
      .getState()
      .record(handle({ operationId: "op-restore-b", createdAt: 2 }));
    await flushPersist();
    const stored = storedHandles();
    const ids = Array.isArray(stored)
      ? stored
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => entry.operationId)
      : [];
    expect(ids).toEqual(["op-restore-b", "op-restore-a"]);
  });

  it("merges acknowledgement and cancel monotonically across windows", async () => {
    useProfileCopyOperationsStore.getState().record(
      handle({
        operationId: "op-merge-a",
        startAcknowledged: false,
        cancelConfirmedAt: null,
      }),
    );
    await flushPersist();

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          handles: [
            handle({
              operationId: "op-merge-a",
              startAcknowledged: true,
              cancelConfirmedAt: 40,
            }),
          ],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    useProfileCopyOperationsStore
      .getState()
      .markCancelConfirmed("op-merge-a", 90);
    await flushPersist();

    const stored = storedHandles();
    const row = firstObjectEntry(stored);
    expect(row).toMatchObject({
      operationId: "op-merge-a",
      startAcknowledged: true,
      cancelConfirmedAt: 40,
    });
  });

  it("keeps a handle this window removed from another window's write after a storage event", async () => {
    const handleX = handle({ operationId: "op-storage-x", createdAt: 1 });
    const handleY = handle({ operationId: "op-storage-y", createdAt: 2 });
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { handles: [handleX] },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useProfileCopyOperationsStore.persist.rehydrate();

    vi.resetModules();
    const other =
      await import("@/stores/settings/profile-copy-operations-store");
    other.useProfileCopyOperationsStore.persist.setOptions({
      name: PERSIST_KEY,
    });
    await other.useProfileCopyOperationsStore.persist.rehydrate();
    expect(
      other.useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).toEqual(["op-storage-x"]);

    useProfileCopyOperationsStore.getState().remove("op-storage-x");
    await flushPersist();
    expect(storedHandles()).toEqual([]);
    // Storage no longer holds op-storage-x, so a rehydrate on this unrelated
    // key would drop it here: B still showing it proves the key is filtered.
    window.dispatchEvent(
      new StorageEvent("storage", { key: "some-other-key" }),
    );
    await flushPersist();
    await flushPersist();
    expect(
      other.useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).toEqual(["op-storage-x"]);

    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    await flushPersist();
    await flushPersist();
    expect(
      other.useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).not.toContain("op-storage-x");

    other.useProfileCopyOperationsStore.getState().record(handleY);
    await flushPersist();
    const stored = storedHandles();
    const ids = Array.isArray(stored)
      ? stored
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => entry.operationId)
      : [];
    expect(ids).toEqual(["op-storage-y"]);
    expect(
      other.useProfileCopyOperationsStore
        .getState()
        .handles.map((entry) => entry.operationId),
    ).toEqual(["op-storage-y"]);
  });

  it("hydrates every wire provider, disposition and manual route and drops unknown ones", async () => {
    // The fixtures below iterate the model's lists, so first pin that each
    // list IS the schema's own array (zod 4 assigns `.options` once); a
    // hand-written copy would fail here even while its values still match.
    expect(PROFILE_COPY_PROVIDERS).toBe(profileCopyProviderSchema.options);
    expect(PROFILE_COPY_DISPOSITIONS).toBe(
      profileCopyPreviewDestinationSchema.shape.disposition.options,
    );
    expect(PROFILE_COPY_MANUAL_ROUTES).toBe(
      profileCopyFeasibilitySchema.shape.manual.options[0].shape.route.options,
    );

    const providerHandles = PROFILE_COPY_PROVIDERS.map((providerId, index) =>
      handle({
        operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
        providerId,
        createdAt: index,
      }),
    );
    const bogusProvider = {
      ...handle({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000099",
        createdAt: 99,
      }),
      providerId: "not-a-provider",
    };
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { handles: [...providerHandles, bogusProvider] },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useProfileCopyOperationsStore.persist.rehydrate();
    expect(
      new Set(
        useProfileCopyOperationsStore
          .getState()
          .handles.map((entry) => entry.providerId),
      ),
    ).toEqual(new Set(profileCopyProviderSchema.options));

    const dispositionRecords = PROFILE_COPY_DISPOSITIONS.map((disposition) =>
      previewRecord({ disposition, manualRoute: null }),
    );
    const routeRecords = PROFILE_COPY_MANUAL_ROUTES.map((manualRoute) =>
      previewRecord({ disposition: "manual", manualRoute }),
    );
    // Stored as raw JSON: the bogus records are what a newer or corrupted
    // writer could leave, so they are built outside the typed fixtures.
    const storedHandle = {
      ...handle({
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000050",
        createdAt: 50,
      }),
      previewRecords: [
        ...dispositionRecords,
        ...routeRecords,
        { ...previewRecord({}), disposition: "not-a-disposition" },
        {
          ...previewRecord({ disposition: "manual" }),
          manualRoute: "not-a-route",
        },
      ],
    };
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { handles: [storedHandle] },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useProfileCopyOperationsStore.persist.rehydrate();
    const records =
      useProfileCopyOperationsStore.getState().handles[0]?.previewRecords ?? [];
    expect(new Set(records.map((record) => record.disposition))).toEqual(
      new Set(profileCopyPreviewDestinationSchema.shape.disposition.options),
    );
    expect(
      new Set(
        records
          .map((record) => record.manualRoute)
          .filter((route) => route !== null),
      ),
    ).toEqual(
      new Set(
        profileCopyFeasibilitySchema.shape.manual.options[0].shape.route
          .options,
      ),
    );
    // Every valid record kept, both bogus ones dropped.
    expect(records).toHaveLength(
      dispositionRecords.length + routeRecords.length,
    );
  });
});
