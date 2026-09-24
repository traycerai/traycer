/**
 * `syncIdentityTabTitle` (Codex bot finding 42): the identity tab's title
 * follows the session's authoritative record. A deep-linked tab opened with an
 * empty title takes the snapshot's title, and a rename that lands as a record
 * patch on the index lane updates the tab. Driven through a REAL open-identity
 * store over fake stream clients, the same rig `store.test.ts` uses.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  agentIdentityStateSubscribeServerFrameSchemaV10,
  type AgentIdentityStateSubscribeServerFrameV10,
} from "@traycer/protocol/host/agent-identity/state-subscribe";
import type {
  IdentityFileStreamClientFactory,
  IdentityStateStreamClientFactory,
} from "@traycer-clients/shared/identity-lanes";
import type { IdentityStateStreamCallbacks } from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import {
  createOpenIdentityStore,
  type OpenIdentityStoreHandle,
} from "@/stores/identities/open-identity/store";
import {
  resetIdentityTabsStoreForTests,
  useIdentityTabsStore,
} from "@/stores/identities/identity-tabs-store";
import { syncIdentityTabTitle } from "@/stores/identities/identity-tab-title-sync";

const HOST_ID = "host-a";
const IDENTITY_ID = "identity_1";
const EPOCH = "epoch-1";

function identityFixture(title: string) {
  return {
    title,
    description: null,
    evolution: {
      intervalTurns: 0,
      reviewHarnessId: null,
      reviewModel: null,
      reviewReasoningEffort: null,
    },
  };
}

function snapshotFrame(
  title: string,
): Extract<AgentIdentityStateSubscribeServerFrameV10, { kind: "snapshot" }> {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: EPOCH,
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    identity: { revision: 1, identity: identityFixture(title) },
    documents: [],
    files: [],
    shards: [],
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

function renameDeltaFrame(
  title: string,
  seq: number,
  revision: number,
): Extract<AgentIdentityStateSubscribeServerFrameV10, { kind: "delta" }> {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    authorityEpoch: EPOCH,
    seq,
    documentUpserts: [],
    fileUpserts: [],
    removals: [],
    identity: { revision, identity: { title } },
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

interface Rig {
  readonly handle: OpenIdentityStoreHandle;
  readonly callbacks: () => IdentityStateStreamCallbacks;
}

function createRig(): Rig {
  const captured: IdentityStateStreamCallbacks[] = [];
  const stateFactory: IdentityStateStreamClientFactory = (
    _identityId,
    callbacks,
  ) => {
    captured.push(callbacks);
    return { close: () => undefined };
  };
  const fileFactory: IdentityFileStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });
  const handle = createOpenIdentityStore({
    hostId: HOST_ID,
    identityId: IDENTITY_ID,
    environment: createRendererRuntimeEnvironment(),
    stateStreamClientFactory: stateFactory,
    fileStreamClientFactory: fileFactory,
    getCurrentUserId: () => "user-1",
    memory: null,
  });
  return {
    handle,
    callbacks: () => {
      const latest = captured.at(-1);
      if (latest === undefined) throw new Error("state factory not invoked");
      return latest;
    },
  };
}

const opened: OpenIdentityStoreHandle[] = [];
const unsubscribes: (() => void)[] = [];

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  for (const handle of opened.splice(0)) handle.dispose();
  resetIdentityTabsStoreForTests();
});

function tabTitle(): string | undefined {
  return useIdentityTabsStore.getState().tabsById[IDENTITY_ID]?.title;
}

describe("syncIdentityTabTitle", () => {
  it("applies the snapshot's title to a deep-linked tab opened with none", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: IDENTITY_ID, hostId: HOST_ID, title: "" });
    const rig = createRig();
    opened.push(rig.handle);
    unsubscribes.push(syncIdentityTabTitle(rig.handle));

    // Nothing to apply before the first snapshot: the tab keeps its
    // placeholder rather than being blanked.
    expect(tabTitle()).toBe("");

    rig.callbacks().onSnapshot(snapshotFrame("Research assistant"));

    expect(tabTitle()).toBe("Research assistant");
  });

  it("follows a rename committed on the index lane", () => {
    useIdentityTabsStore.getState().openTab({
      identityId: IDENTITY_ID,
      hostId: HOST_ID,
      title: "Research assistant",
    });
    const rig = createRig();
    opened.push(rig.handle);
    rig.callbacks().onSnapshot(snapshotFrame("Research assistant"));
    unsubscribes.push(syncIdentityTabTitle(rig.handle));

    rig.callbacks().onDelta(renameDeltaFrame("Support assistant", 1, 2));

    expect(tabTitle()).toBe("Support assistant");
  });

  it("stops following once released", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: IDENTITY_ID, hostId: HOST_ID, title: "" });
    const rig = createRig();
    opened.push(rig.handle);
    const unsubscribe = syncIdentityTabTitle(rig.handle);
    rig.callbacks().onSnapshot(snapshotFrame("First"));
    expect(tabTitle()).toBe("First");

    unsubscribe();
    rig.callbacks().onDelta(renameDeltaFrame("Second", 1, 2));

    expect(tabTitle()).toBe("First");
  });
});
