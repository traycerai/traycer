import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  persistKey,
  recordMapStorageKey,
  STORE_KEYS,
} from "@/lib/persist/keys";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import {
  applyNewChatHostDocument,
  saveReturnedTaskCreateRequest,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const KEY = persistKey(STORE_KEYS.newConversationDraft);
const EPIC_ID = "epic-persist";
const OTHER_EPIC_ID = "epic-unrelated";
const EPIC_RECORD_KEY = recordMapStorageKey(KEY, EPIC_ID);
const OTHER_EPIC_RECORD_KEY = recordMapStorageKey(KEY, OTHER_EPIC_ID);

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function hostDraftDocument(
  draftId: string,
  content: JsonContent,
): DraftDocument {
  return {
    draftId,
    kind: "new-chat",
    target: { epicId: EPIC_ID, chatId: null, blockId: null },
    revision: 1,
    lastTouchedAt: 1,
    workspace: null,
    ownerHostId: "task-owner-host",
    origin: "own",
    adoption: { state: "adopted", hostId: "task-owner-host" },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    supersedes: null,
    portable: {
      content,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

function retryRequest(clientRequestId: string): SandboxCreateRequest {
  return {
    os: "linux",
    cpus: 8,
    memoryMb: 16_384,
    diskMb: 30_720,
    region: "eu-west",
    displayName: "origin/main hook",
    idleMinutes: 45,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId: "env-task-retry",
    destroyAfterRestingMinutes: 0,
    createdByTaskId: EPIC_ID,
    clientRequestId,
  };
}

function newTaskReturn(
  clientRequestId: string,
  userId: string,
  lastCreate: SandboxCreateRequest | undefined,
) {
  return {
    target: {
      kind: "new" as const,
      configuration: { kind: "personal" as const },
      shape: {
        os: "linux" as const,
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name: "task sandbox",
      wakeString: null,
    },
    clientRequestId,
    ...(lastCreate === undefined
      ? {}
      : {
          lastCreateKey: lastCreate.clientRequestId ?? undefined,
          lastRetryCreate: lastCreate,
        }),
    userId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedPatch(): Record<string, unknown> {
  const raw = window.localStorage.getItem(EPIC_RECORD_KEY);
  if (raw === null)
    throw new Error(`nothing persisted under ${EPIC_RECORD_KEY}`);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("persisted patch is not an object");
  return parsed;
}

function reset(): void {
  useNewConversationModalStore.getState().resetForTests();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(EPIC_RECORD_KEY);
  window.localStorage.removeItem(OTHER_EPIC_RECORD_KEY);
}

describe("new-conversation modal store: persistence", () => {
  beforeEach(reset);
  afterEach(reset);

  it("persists a patch and rehydrates it without re-dirtying the row", async () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("later"));
    useNewConversationModalStore
      .getState()
      .setNewChatEpicTitle(EPIC_ID, "Epic");
    const written =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (written === undefined) throw new Error("no patch written");

    // Simulate the reload: keep the bytes the middleware just wrote, drop the
    // in-memory map (which writes over them), put them back, and let the
    // middleware read its own output.
    const persistedHeader = window.localStorage.getItem(KEY);
    const persistedRecord = window.localStorage.getItem(EPIC_RECORD_KEY);
    if (persistedHeader === null || persistedRecord === null)
      throw new Error("nothing persisted");
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    window.localStorage.setItem(KEY, persistedHeader);
    window.localStorage.setItem(EPIC_RECORD_KEY, persistedRecord);
    await useNewConversationModalStore.persist.rehydrate();

    const restored =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (restored === undefined) throw new Error("patch did not rehydrate");
    expect(restored.content).toEqual(typed("later"));
    expect(restored.epicTitle).toBe("Epic");
    expect(restored.draftId).toBe(written.draftId);
    expect(restored.lastTouchedAt).toBe(written.lastTouchedAt);
    // The sync bookkeeping survives verbatim: a reload that marked every
    // clean row dirty would re-publish rows the host already holds.
    expect(restored.generation).toBe(written.generation);
    expect(restored.syncedGeneration).toBe(written.syncedGeneration);
    expect(restored.hostRevision).toBe(written.hostRevision);
  });

  it("strips a still-pending base64 image node on write, keeping the hash-only one", () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, {
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [
            { type: "imageAttachment", attrs: { hash: "a".repeat(64) } },
            {
              type: "imageAttachment",
              attrs: { b64content: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    });

    const persisted = readPersistedPatch();
    expect(JSON.stringify(persisted)).not.toContain("b64content");
    expect(JSON.stringify(persisted)).toContain("a".repeat(64));
    // The in-memory document is canonical and keeps the pending node until
    // its ingest flips it to a hash.
    const live =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(JSON.stringify(live)).toContain("b64content");
  });

  it("hydrates a legacy whole-map snapshot into the per-epic record", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        state: {
          draftPatchesByEpicId: {
            [EPIC_ID]: {
              content: typed("legacy draft"),
              composerMode: "terminal",
              draftId: "legacy-draft",
            },
          },
        },
      }),
    );

    await useNewConversationModalStore.persist.rehydrate();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toMatchObject({
      content: typed("legacy draft"),
      draftId: "legacy-draft",
    });
    expect(readPersistedPatch()).toMatchObject({
      content: typed("legacy draft"),
      draftId: "legacy-draft",
    });
  });

  it("omits a null terminal record without a return, then keeps A's saved request across B's other-epic edit", async () => {
    const userId = "task-user";
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
    useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("terminal-only"));
    useNewConversationModalStore
      .getState()
      .setComposerMode(EPIC_ID, "terminal");
    const beforeReturn = readPersistedPatch();
    window.localStorage.setItem(
      EPIC_RECORD_KEY,
      JSON.stringify({
        ...beforeReturn,
        content: null,
        composerMode: "terminal",
      }),
    );

    vi.resetModules();
    const secondWindow = await import("../new-conversation-modal-store");
    await secondWindow.useNewConversationModalStore.persist.rehydrate();
    expect(
      secondWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ],
    ).toBeUndefined();

    const stageId = "stage:terminal-return";
    const returned = newTaskReturn(stageId, userId, undefined);
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, returned);
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId;
    if (draftId === undefined || draftId === null)
      throw new Error("expected A's terminal-only task draft id");
    const request = retryRequest("retry:sandbox-row-f");
    const origin = {
      kind: "task" as const,
      epicId: EPIC_ID,
      draftId,
      userId,
      stageId,
    };
    expect(saveReturnedTaskCreateRequest("task-surface", origin, request)).toBe(
      "saved",
    );

    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(OTHER_EPIC_ID, typed("unrelated task edit"));
    expect(readPersistedPatch()).toMatchObject({
      draftId: origin.draftId,
      content: null,
      composerMode: "terminal",
      returnedSandbox: {
        clientRequestId: stageId,
        lastCreateKey: request.clientRequestId,
        lastRetryCreate: request,
        userId,
      },
    });

    vi.resetModules();
    const freshWindow = await import("../new-conversation-modal-store");
    await freshWindow.useNewConversationModalStore.persist.rehydrate();
    expect(
      freshWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ],
    ).toMatchObject({
      draftId: origin.draftId,
      content: null,
      composerMode: "terminal",
      returnedSandbox: {
        clientRequestId: stageId,
        lastCreateKey: request.clientRequestId,
        lastRetryCreate: request,
        userId,
      },
    });
    expect(
      freshWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        OTHER_EPIC_ID
      ]?.content,
    ).toEqual(typed("unrelated task edit"));
  });

  it("does not let an initialized empty window revive A's deleted task over B's new draft", async () => {
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("A old"));
    const oldDraftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.draftId;
    if (oldDraftId === undefined || oldDraftId === null)
      throw new Error("expected A's original task draft id");

    vi.resetModules();
    const secondWindow = await import("../new-conversation-modal-store");
    await secondWindow.useNewConversationModalStore.persist.rehydrate();
    expect(
      secondWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ],
    ).toBeUndefined();

    useNewConversationModalStore.getState().clearDraft(EPIC_ID);
    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("B first edit"));
    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("B final edit"));
    const bPatch =
      secondWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ];
    if (bPatch?.draftId === undefined || bPatch.draftId === null)
      throw new Error("expected B's replacement task draft id");
    expect(bPatch.draftId).not.toBe(oldDraftId);

    expect(
      applyNewChatHostDocument(
        hostDraftDocument(oldDraftId, typed("late A host echo")),
      ),
    ).toBe(false);
    expect(readPersistedPatch()).toMatchObject({
      draftId: bPatch.draftId,
      content: typed("B final edit"),
    });

    vi.resetModules();
    const freshWindow = await import("../new-conversation-modal-store");
    await freshWindow.useNewConversationModalStore.persist.rehydrate();
    expect(
      freshWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ],
    ).toMatchObject({
      draftId: bPatch.draftId,
      content: typed("B final edit"),
    });
    expect(
      freshWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ]?.draftId,
    ).not.toBe(oldDraftId);
  });

  it("preserves a newer same-occurrence edit when A checkpoints its returned request", async () => {
    const userId = "task-user";
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
    useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("A text"));
    const original =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (original?.draftId === undefined || original.draftId === null)
      throw new Error("expected the original task occurrence");
    const stageId = "stage:checkpoint-merge";
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, newTaskReturn(stageId, userId, undefined));

    vi.resetModules();
    const secondWindow = await import("../new-conversation-modal-store");
    await secondWindow.useNewConversationModalStore.persist.rehydrate();
    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("B newer text"));
    const bPatch =
      secondWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ];
    if (bPatch?.draftId !== original.draftId)
      throw new Error("expected B to edit the same task occurrence");

    const request = retryRequest("retry:checkpoint-merge");
    expect(
      saveReturnedTaskCreateRequest(
        "task-surface",
        {
          kind: "task",
          epicId: EPIC_ID,
          draftId: original.draftId,
          userId,
          stageId,
        },
        request,
      ),
    ).toBe("saved");
    expect(readPersistedPatch()).toMatchObject({
      draftId: original.draftId,
      content: typed("B newer text"),
      revision: bPatch.revision,
      returnedSandbox: {
        clientRequestId: stageId,
        lastCreateKey: request.clientRequestId,
        lastRetryCreate: request,
      },
    });
  });

  it("allows the current task delete and fences a stale delete after a newer return", async () => {
    const userId = "task-user";
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
    useNewConversationModalStore.getState().setContent(EPIC_ID, typed("task"));
    useNewConversationModalStore.getState().clearDraft(EPIC_ID);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
    expect(localStorage.getItem(EPIC_RECORD_KEY)).toBe("null");

    useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("returned"));
    const patch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (patch?.draftId === undefined || patch.draftId === null)
      throw new Error("expected the current returned task occurrence");
    const stageId = "stage:delete-fence";
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, newTaskReturn(stageId, userId, undefined));

    vi.resetModules();
    const secondWindow = await import("../new-conversation-modal-store");
    await secondWindow.useNewConversationModalStore.persist.rehydrate();
    const request = retryRequest("retry:delete-fence-newer");
    secondWindow.useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, newTaskReturn(stageId, userId, request));
    useNewConversationModalStore.getState().clearDraft(EPIC_ID);

    expect(readPersistedPatch()).toMatchObject({
      draftId: patch.draftId,
      returnedSandbox: {
        clientRequestId: stageId,
        lastCreateKey: request.clientRequestId,
        lastRetryCreate: request,
      },
    });
    vi.resetModules();
    const freshWindow = await import("../new-conversation-modal-store");
    await freshWindow.useNewConversationModalStore.persist.rehydrate();
    expect(
      freshWindow.useNewConversationModalStore.getState().draftPatchesByEpicId[
        EPIC_ID
      ]?.returnedSandbox,
    ).toMatchObject({
      clientRequestId: stageId,
      lastCreateKey: request.clientRequestId,
      lastRetryCreate: request,
    });
  });

  it("keeps a retry body when a stale window edits a different epic", async () => {
    const store = useNewConversationModalStore.getState();
    store.setContent(EPIC_ID, typed("returned task"));
    store.setContent(OTHER_EPIC_ID, typed("other task"));
    const staleWindowStorage = createRecordMapStorage({
      field: "draftPatchesByEpicId",
    });
    const staleWindowSnapshot = staleWindowStorage.getItem(KEY);
    if (staleWindowSnapshot === null)
      throw new Error("expected the second window's initial task map");

    const retryCreate: SandboxCreateRequest = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 20480,
      region: "us-east",
      displayName: "origin/main hook",
      idleMinutes: 30,
      burst: false,
      createdByHostId: null,
      createdByAgentId: null,
      environmentId: "env-task",
      destroyAfterRestingMinutes: 0,
      createdByTaskId: EPIC_ID,
      clientRequestId: "retry:sandbox-F",
    };
    const returned = {
      target: {
        kind: "new" as const,
        configuration: { kind: "personal" as const },
        shape: {
          os: "linux" as const,
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: null,
        },
        name: "task sandbox",
        wakeString: null,
      },
      clientRequestId: "stage-task",
      lastCreateKey: retryCreate.clientRequestId ?? undefined,
      lastRetryCreate: retryCreate,
    };
    useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, returned);

    const staleSnapshot: unknown = JSON.parse(staleWindowSnapshot);
    if (!isRecord(staleSnapshot) || !isRecord(staleSnapshot.state))
      throw new Error("expected a persisted task store snapshot");
    const stalePatches = staleSnapshot.state.draftPatchesByEpicId;
    if (!isRecord(stalePatches) || !isRecord(stalePatches[OTHER_EPIC_ID]))
      throw new Error("expected the unrelated task's old draft");
    const staleOtherPatch = stalePatches[OTHER_EPIC_ID];
    if (typeof staleOtherPatch.generation !== "number")
      throw new Error("expected the unrelated task's generation");
    staleWindowStorage.setItem(
      KEY,
      JSON.stringify({
        ...staleSnapshot,
        state: {
          ...staleSnapshot.state,
          draftPatchesByEpicId: {
            ...stalePatches,
            [OTHER_EPIC_ID]: {
              ...staleOtherPatch,
              content: typed("other task edited in stale window"),
              generation: staleOtherPatch.generation + 1,
            },
          },
        },
      }),
    );
    expect(
      JSON.parse(window.localStorage.getItem(EPIC_RECORD_KEY) ?? "null"),
    ).toMatchObject({
      returnedSandbox: {
        lastCreateKey: retryCreate.clientRequestId,
        lastRetryCreate: retryCreate,
      },
    });

    const savedHeader = window.localStorage.getItem(KEY);
    const savedEpic = window.localStorage.getItem(EPIC_RECORD_KEY);
    const savedOther = window.localStorage.getItem(OTHER_EPIC_RECORD_KEY);
    if (savedHeader === null || savedEpic === null || savedOther === null)
      throw new Error("expected both per-epic records to be durable");
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    window.localStorage.setItem(KEY, savedHeader);
    window.localStorage.setItem(EPIC_RECORD_KEY, savedEpic);
    window.localStorage.setItem(OTHER_EPIC_RECORD_KEY, savedOther);
    await useNewConversationModalStore.persist.rehydrate();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.returnedSandbox,
    ).toMatchObject({
      clientRequestId: "stage-task",
      lastCreateKey: retryCreate.clientRequestId,
      lastRetryCreate: retryCreate,
      userId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        OTHER_EPIC_ID
      ]?.content,
    ).toEqual(typed("other task edited in stale window"));
  });

  it("preserves a same-draft retry body when a stale task window writes after the request commit", async () => {
    const userId = "task-user";
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId, username: userId },
    });
    const store = useNewConversationModalStore.getState();
    store.setContent(EPIC_ID, typed("task before retry"));
    applyNewChatHostDocument(
      hostDraftDocument("draft-task-old", typed("task before retry")),
    );
    const initialPatch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (initialPatch === undefined || typeof initialPatch.draftId !== "string")
      throw new Error("expected the task draft occurrence");
    store.setReturnedSandbox(EPIC_ID, {
      target: {
        kind: "new",
        configuration: { kind: "personal" },
        shape: {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: null,
        },
        name: "task sandbox",
        wakeString: null,
      },
      clientRequestId: "stage-task",
    });

    vi.resetModules();
    const secondWindow = await import("../new-conversation-modal-store");
    await secondWindow.useNewConversationModalStore.persist.rehydrate();

    const retryCreate: SandboxCreateRequest = {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 20480,
      region: "us-east",
      displayName: "origin/main hook",
      idleMinutes: 30,
      burst: false,
      createdByHostId: null,
      createdByAgentId: null,
      environmentId: "env-task",
      destroyAfterRestingMinutes: 0,
      createdByTaskId: EPIC_ID,
      clientRequestId: "retry:sandbox-F",
    };
    const origin = {
      kind: "task" as const,
      epicId: EPIC_ID,
      draftId: initialPatch.draftId,
      userId,
      stageId: "stage-task",
    };
    expect(
      saveReturnedTaskCreateRequest("task-surface", origin, retryCreate),
    ).toBe("saved");

    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("stale task window edit"));
    expect(readPersistedPatch()).toMatchObject({
      draftId: initialPatch.draftId,
      content: typed("stale task window edit"),
      returnedSandbox: {
        lastCreateKey: retryCreate.clientRequestId,
        lastRetryCreate: retryCreate,
      },
    });

    const savedHeader = window.localStorage.getItem(KEY);
    const savedRecord = window.localStorage.getItem(EPIC_RECORD_KEY);
    if (savedHeader === null || savedRecord === null)
      throw new Error("expected the retry body to be durable");
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    window.localStorage.setItem(KEY, savedHeader);
    window.localStorage.setItem(EPIC_RECORD_KEY, savedRecord);
    await useNewConversationModalStore.persist.rehydrate();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.returnedSandbox,
    ).toMatchObject({
      lastCreateKey: retryCreate.clientRequestId,
      lastRetryCreate: retryCreate,
    });

    await secondWindow.useNewConversationModalStore.persist.rehydrate();
    secondWindow.useNewConversationModalStore.getState().clearDraft(EPIC_ID);
    secondWindow.useNewConversationModalStore
      .getState()
      .setContent(EPIC_ID, typed("replacement task draft"));
    secondWindow.applyNewChatHostDocument(
      hostDraftDocument("draft-task-new", typed("replacement task draft")),
    );
    const newerRequest: SandboxCreateRequest = {
      ...retryCreate,
      displayName: "new draft sandbox",
      clientRequestId: "retry:new-draft-row",
    };
    secondWindow.useNewConversationModalStore
      .getState()
      .setReturnedSandbox(EPIC_ID, {
        target: {
          kind: "new",
          configuration: { kind: "personal" },
          shape: {
            os: "linux",
            cpus: 2,
            memoryMb: 4096,
            diskMb: null,
            region: "us-east",
            idleMinutes: 30,
            destroyAfterRestingMinutes: null,
          },
          name: "replacement sandbox",
          wakeString: null,
        },
        clientRequestId: "stage-task-new",
        lastCreateKey: newerRequest.clientRequestId ?? undefined,
        lastRetryCreate: newerRequest,
      });
    expect(
      saveReturnedTaskCreateRequest("task-surface", origin, retryCreate),
    ).toBe("stale");
    expect(readPersistedPatch()).toMatchObject({
      draftId: "draft-task-new",
      content: typed("replacement task draft"),
      returnedSandbox: {
        clientRequestId: "stage-task-new",
        lastCreateKey: newerRequest.clientRequestId,
        lastRetryCreate: newerRequest,
      },
    });
  });

  it("drops a persisted patch whose content is not editor JSON", async () => {
    // Deliberately not typed as a patch: the point is a payload whose
    // `content` never was editor JSON, which no `Partial<Patch>` can express.
    const broken: unknown = { content: "not a document", draftId: "d-broken" };
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        state: { draftPatchesByEpicId: { [EPIC_ID]: broken } },
      }),
    );

    await useNewConversationModalStore.persist.rehydrate();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID],
    ).toBeUndefined();
  });

  it("restores a null workspace as null rather than an empty snapshot", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        state: {
          draftPatchesByEpicId: {
            [EPIC_ID]: {
              content: typed("later"),
              workspace: null,
              composerMode: "nonsense",
              draftId: "d-1",
            },
          },
        },
      }),
    );

    await useNewConversationModalStore.persist.rehydrate();

    const restored =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    if (restored === undefined) throw new Error("patch did not rehydrate");
    // `null` means "no workspace of its own yet, use the seed"; the empty
    // snapshot would mean "the user emptied it".
    expect(restored.workspace).toBeNull();
    expect(restored.composerMode).toBeNull();
    expect(restored.workspace).not.toEqual(
      emptyLandingDraftWorkspaceSnapshot(),
    );
  });
});
