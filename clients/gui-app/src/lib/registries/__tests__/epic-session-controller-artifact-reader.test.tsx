/**
 * Artifact reader demand through the real controller and registry: demand is
 * `{ hostId, epicId, rowKey }`; each row owns one token; the same host and
 * epic join one charged entry.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEpicSessionController,
  type ArtifactReaderSnapshot,
  type ArtifactReaderToken,
} from "@/lib/registries/epic-session-controller";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import {
  closeTestEpicTab,
  defaultTestEpicSessionEnvironment,
  installTestEpicSessionEnvironment,
  openTestEpicTab,
  setTestEffectiveHost,
  setTestEpicSessionHostClientResolver,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import {
  createTestHostClient,
  resetTestHostClients,
} from "@/lib/host/test-support/test-host-client";
import { resetFakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { __resetEpicParkingForTests } from "@/lib/epics/epic-parking";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

let previousWorkerFactory: (() => RuntimeWorkerLike) | null;
let constructionCount = 0;
const held: ArtifactReaderToken[] = [];

function reader(
  hostId: string,
  epicId: string,
  rowKey: string,
): ArtifactReaderToken {
  const token = getEpicSessionController().acquireArtifactReader({
    hostId,
    epicId,
    rowKey,
  });
  held.push(token);
  return token;
}

const detaches: Array<() => void> = [];

/** A tab a pane is showing: open in the strip AND mounted, so it constructs. */
function openShownTab(tabId: string, epicId: string): void {
  openTestEpicTab(tabId, epicId, "Epic");
  detaches.push(getEpicSessionController().attachSurface(epicId, tabId));
}

const queryClient = new QueryClient();
const NO_HANDLERS = {};
const quietStream: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});
let previousAuth: AuthState;

beforeEach(() => {
  resetTestHostClients();
  __getOpenEpicRegistryForTests().disposeAll();
  __resetEpicParkingForTests();
  __setAgentActivityPlaneAnsweringForTests();
  resetFakeDurableStreamTransports();
  const resolveHostClient = (hostId: string) =>
    createTestHostClient(
      hostId,
      AUTHENTICATED_USER_FIXTURE_ID,
      queryClient,
      NO_HANDLERS,
    );
  installTestEpicSessionEnvironment({
    ...defaultTestEpicSessionEnvironment(),
    resolveHostClient,
  });
  setTestEffectiveHost("host-a", true);
  setTestEpicSessionHostClientResolver(resolveHostClient);
  previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
  constructionCount = 0;
  // A real in-process runtime worker over a stream this suite answers by
  // hand: every session is a genuine entry that publishes a handle, and loads
  // only when a case delivers its snapshot.
  __setEpicRuntimeWorkerFactoryForTests(() => {
    constructionCount += 1;
    return createInProcessEpicRuntimeWorker({
      streamClientFactory: quietStream,
      laneSelection: null,
    }).createWorker();
  });
  previousAuth = useAuthStore.getState();
  // The identity the test host clients' request context carries.
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: AUTHENTICATED_USER_FIXTURE_ID,
      userName: "Test User",
      email: "test@example.com",
    },
    contextMetadata: {
      userId: AUTHENTICATED_USER_FIXTURE_ID,
      username: "Test User",
    },
  });
});

afterEach(() => {
  for (const detach of detaches.splice(0)) detach();
  for (const token of held.splice(0)) token.release();
  __resetAgentActivityStoreForTests();
  __getOpenEpicRegistryForTests().disposeAll();
  __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
  useAuthStore.setState(previousAuth, true);
});

describe("reader and tab ownership, both directions", () => {
  it("preview first, then a same-host tab: one entry, one construction", () => {
    const token = reader("host-a", "epic-1", "row-1");
    openTestEpicTab("tab-1", "epic-1", "Epic");
    expect(constructionCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    expect(token.read().kind).not.toBe("closed");
  });

  it("closing the last tab keeps the reader's entry alive", () => {
    openTestEpicTab("tab-1", "epic-1", "Epic");
    const token = reader("host-a", "epic-1", "row-1");
    closeTestEpicTab("tab-1");
    __syncEpicParkingOpenTabsForTests();
    expect(__getOpenEpicRegistryForTests().peek("epic-1")).not.toBeNull();
    expect(token.read().kind).not.toBe("revoked");
  });

  it("detaching the reader leaves the tab's entry intact", () => {
    openTestEpicTab("tab-1", "epic-1", "Epic");
    const token = reader("host-a", "epic-1", "row-1");
    token.release();
    expect(__getOpenEpicRegistryForTests().peek("epic-1")).not.toBeNull();
  });

  it("matching rows share one charged entry", () => {
    reader("host-a", "epic-1", "row-1");
    reader("host-a", "epic-1", "row-2");
    expect(constructionCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("a preview on another host than the bound task is refused, never relabelled", () => {
    openShownTab("tab-1", "epic-1");
    expect(constructionCount).toBe(1);
    const token = reader("host-b", "epic-1", "row-1");
    expect(token.read()).toMatchObject({
      kind: "refused",
      reason: "host-conflict",
    });
    expect(constructionCount).toBe(1);
  });

  it("an acquiring preview on A is fenced before a tab on B publishes", () => {
    const token = reader("host-a", "epic-1", "row-1");
    expect(token.read().kind).toBe("acquiring");
    setTestEffectiveHost("host-b", true);
    openTestEpicTab("tab-1", "epic-1", "Epic");
    const snapshot = token.read();
    expect(snapshot.kind).toBe("revoked");
  });

  it("a ready preview on A withholds content once a tab arrives on B", async () => {
    const token = reader("host-a", "epic-1", "row-1");
    await waitForKind(token, "ready");
    setTestEffectiveHost("host-b", true);
    openTestEpicTab("tab-1", "epic-1", "Epic");
    expect(token.read().kind).toBe("revoked");
  });
});

describe("a reader acquires like a tab, over the cap", () => {
  it("every distinct preview is constructed and none is refused, however many there are", () => {
    const tokens = Array.from({ length: DEFAULT_MAX_LIVE_EPICS + 3 }, (_, i) =>
      reader("host-a", `epic-${i}`, `row-${i}`),
    );
    expect(constructionCount).toBe(DEFAULT_MAX_LIVE_EPICS + 3);
    for (const token of tokens) {
      expect(["acquiring", "ready"]).toContain(token.read().kind);
    }
  });

  it("a tab acquisition still gets its session when readers fill the cap", () => {
    for (let i = 0; i < DEFAULT_MAX_LIVE_EPICS; i += 1) {
      reader("host-a", `epic-${i}`, `row-${i}`);
    }
    openShownTab("tab-x", "epic-tab");
    expect(__getOpenEpicRegistryForTests().peek("epic-tab")).not.toBeNull();
  });
});

describe("a construction that fails", () => {
  it("retires the attached readers as failed, so a card offers Retry rather than access copy", () => {
    __setEpicRuntimeWorkerFactoryForTests(() => {
      throw new Error("no worker here");
    });
    const token = reader("host-a", "epic-1", "row-1");

    expect(token.read().kind).toBe("failed");
  });
});

describe("a released token", () => {
  it("never reactivates, and release is idempotent", () => {
    const token = reader("host-a", "epic-1", "row-1");
    token.release();
    token.release();
    token.retry();
    expect(token.read().kind).toBe("closed");
    expect(constructionCount).toBe(1);
  });
});

function waitForKind(
  token: ArtifactReaderToken,
  kind: ArtifactReaderSnapshot["kind"],
): Promise<void> {
  return new Promise((resolve) => {
    if (token.read().kind === kind) return resolve();
    const stop = token.subscribe(() => {
      if (token.read().kind !== kind) return;
      stop();
      resolve();
    });
  });
}
