import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";

const remote = vi.hoisted(() => ({ ready: false }));
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: () => remote.ready,
}));

import { closeSimulatorCatalogSessions } from "@/lib/simulator-view/simulator-catalog-owner-action";
import { useAuthStore } from "@/stores/auth/auth-store";

const EPIC = "epic-1";
const HOST = mockLocalHostEntry.hostId;
const USER = "user-1";

function record(
  sessionId: string,
  simulatorId: string,
): SimulatorCatalogRecord {
  return {
    epicId: EPIC,
    hostId: HOST,
    sessionId,
    inventoryRevision: 1,
    lastActivityAt: 100,
    instanceKey: simulatorId,
    simulatorId,
    name: "iPhone 16",
    platform: "ios",
    version: "18.0",
    cloneOf: null,
    drivenByAgent: false,
    idleUntil: null,
    endedReason: null,
  };
}

/** Sessions whose close this host refuses. */
const refusedCloses = new Set<string>();

/** A real client over a recording messenger: the host's side is the handler. */
function hostSide() {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request",
    handlers: {
      "simulator.close": (params) => {
        if (
          params.sessionId !== undefined &&
          refusedCloses.has(params.sessionId)
        )
          throw new Error("This simulator would not close.");
        return { closed: 1 };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === HOST ? mockLocalHostEntry : null),
    messenger,
  });
  spine.setRequestContext(createRequestContextFixture({ origin: "renderer" }));
  return { messenger, client: spine.createRequester(mockLocalHostEntry) };
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: "u@example.com" },
    contextMetadata: { userId, username: userId },
  });
}

describe("closeSimulatorCatalogSessions", () => {
  beforeEach(() => {
    remote.ready = false;
    refusedCloses.clear();
    signIn(USER);
  });
  afterEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("sends one close@1.1 per session in the row, each by its own sessionId", async () => {
    const { messenger, client } = hostSide();

    await closeSimulatorCatalogSessions({
      epicId: EPIC,
      hostId: HOST,
      records: [
        record("session-person", "udid-1"),
        record("session-agent", "udid-1"),
      ],
      owner: { userId: USER, entry: mockLocalHostEntry, client },
    });

    expect(messenger.calls.map((call) => call.method)).toEqual([
      "simulator.close",
      "simulator.close",
    ]);
    expect(messenger.calls.map((call) => call.params)).toEqual([
      {
        epicId: EPIC,
        simulatorId: "udid-1",
        shutdown: false,
        sessionId: "session-person",
      },
      {
        epicId: EPIC,
        simulatorId: "udid-1",
        shutdown: false,
        sessionId: "session-agent",
      },
    ]);
    // A @1.0 host would read a close with no session as "every session the
    // caller owns", so each send carries the 1.1 floor.
    for (const call of messenger.calls) {
      expect(call.requiredHostMethodVersion).toEqual({
        method: "simulator.close",
        version: { major: 1, minor: 1 },
      });
    }
  });

  it("names the sessions the host ended apart from the close it refused", async () => {
    refusedCloses.add("session-agent");
    const { messenger, client } = hostSide();

    const outcome = await closeSimulatorCatalogSessions({
      epicId: EPIC,
      hostId: HOST,
      records: [
        record("session-person", "udid-1"),
        record("session-agent", "udid-1"),
      ],
      owner: { userId: USER, entry: mockLocalHostEntry, client },
    });

    expect(outcome.closed.map((item) => item.sessionId)).toEqual([
      "session-person",
    ]);
    expect(outcome.failures.map((error) => error.message)).toEqual([
      "This simulator would not close.",
    ]);
    expect(messenger.calls).toHaveLength(2);
  });

  it("refuses a host the directory marks offline, without sending anything", async () => {
    const { messenger, client } = hostSide();
    const offline: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      transportDialability: "not-dialable",
    };

    await expect(
      closeSimulatorCatalogSessions({
        epicId: EPIC,
        hostId: HOST,
        records: [record("session-1", "udid-1")],
        owner: { userId: USER, entry: offline, client },
      }),
    ).rejects.toThrow("This device is offline.");

    expect(messenger.calls).toEqual([]);
  });

  it("lets an offline-looking host through when a remote session is already ready", async () => {
    remote.ready = true;
    const { messenger, client } = hostSide();
    const offline: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      transportDialability: "not-dialable",
    };

    await closeSimulatorCatalogSessions({
      epicId: EPIC,
      hostId: HOST,
      records: [record("session-1", "udid-1")],
      owner: { userId: USER, entry: offline, client },
    });

    expect(messenger.calls).toHaveLength(1);
  });

  it("refuses a record that belongs to another task or machine", async () => {
    const { messenger, client } = hostSide();

    await expect(
      closeSimulatorCatalogSessions({
        epicId: EPIC,
        hostId: HOST,
        records: [{ ...record("session-1", "udid-1"), epicId: "epic-2" }],
        owner: { userId: USER, entry: mockLocalHostEntry, client },
      }),
    ).rejects.toThrow("Simulator session owner does not match.");
    await expect(
      closeSimulatorCatalogSessions({
        epicId: EPIC,
        hostId: HOST,
        records: [{ ...record("session-1", "udid-1"), hostId: "host-2" }],
        owner: { userId: USER, entry: mockLocalHostEntry, client },
      }),
    ).rejects.toThrow("Simulator session owner does not match.");

    expect(messenger.calls).toEqual([]);
  });

  it("refuses when the signed-in account is not the one that rendered the row", async () => {
    signIn("user-2");
    const { messenger, client } = hostSide();

    await expect(
      closeSimulatorCatalogSessions({
        epicId: EPIC,
        hostId: HOST,
        records: [record("session-1", "udid-1")],
        owner: { userId: USER, entry: mockLocalHostEntry, client },
      }),
    ).rejects.toThrow("Sign in to use this simulator.");

    expect(messenger.calls).toEqual([]);
  });

  it("refuses a host the directory no longer names", async () => {
    const { messenger, client } = hostSide();

    await expect(
      closeSimulatorCatalogSessions({
        epicId: EPIC,
        hostId: HOST,
        records: [record("session-1", "udid-1")],
        owner: { userId: USER, entry: null, client },
      }),
    ).rejects.toThrow("Couldn't find this device.");

    expect(messenger.calls).toEqual([]);
  });
});
