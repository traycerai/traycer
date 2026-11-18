import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import { HostClient, type IHostQueryInvalidator } from "../host-client";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import { HostRpcError } from "../../host-transport/host-messenger";
import type { HostDirectoryEntry } from "../host-directory";
import { createHostRpcTierPlan } from "../host-rpc-routing";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import {
  localEntry,
  personalRemoteEntry,
  poolEntry,
  teamSandboxEntry,
} from "./routing-entry-fixtures";

const environmentListV10 = defineRpcContract({
  method: "environment.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ names: z.array(z.string()) }),
});
const sendMessageV10 = defineRpcContract({
  method: "agent.sendMessage",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ sent: z.literal(true) }),
});
const speechStatusV10 = defineRpcContract({
  method: "speech.getModelStatus",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const registry = defineVersionedRpcRegistry({
  "environment.list": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: environmentListV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "agent.sendMessage": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: sendMessageV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "speech.getModelStatus": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: speechStatusV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const noopInvalidator: IHostQueryInvalidator = {
  invalidateHostScope: () => undefined,
};

type RoutingMessenger = MockHostMessenger<typeof registry>;

interface Harness {
  readonly client: HostClient<typeof registry>;
  readonly messenger: RoutingMessenger;
  hostIdsSent(): string[];
}

function buildHarness(
  handlers: ConstructorParameters<
    typeof MockHostMessenger<typeof registry>
  >[0]["handlers"],
  selectedHostId: string | null,
): Harness {
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    handlers,
    requestId: () => "req",
  });
  const directory = new Map<string, HostDirectoryEntry>(
    [localEntry, personalRemoteEntry, teamSandboxEntry, poolEntry].map(
      (entry) => [entry.hostId, entry],
    ),
  );
  const client = new HostClient({
    registry,
    messenger,
    invalidator: noopInvalidator,
    requestCoordinator: null,
    findHostById: (hostId) => directory.get(hostId) ?? null,
    routing: {
      plan: createHostRpcTierPlan(poolEntry),
      selectedHostId: () => selectedHostId,
    },
  });
  const user = createAuthenticatedUserFixture(undefined);
  client.setRequestContext(
    createRequestContext({
      identity: identityFromAuthenticatedUser(user),
      bearerToken: "tok",
      origin: "renderer",
      connectionId: undefined,
      operationId: undefined,
      externalAbortSignal: undefined,
      cloudAuthorized: true,
    }),
  );
  return {
    client,
    messenger,
    hostIdsSent: () =>
      messenger.calls.map((call) => call.authority.endpoint.hostId),
  };
}

const okHandlers = {
  "environment.list": () => ({ names: [] }),
  "agent.sendMessage": () => ({ sent: true as const }),
  "speech.getModelStatus": () => ({ ready: true }),
};

describe("HostClient routing", () => {
  it("sends a pool-only call to the pool from a requester for any host", async () => {
    const { client, hostIdsSent } = buildHarness(okHandlers, localEntry.hostId);
    await client
      .createRequesterForHostId(localEntry.hostId)
      .request("environment.list", {});
    await client
      .createRequesterForHostId(teamSandboxEntry.hostId)
      .request("environment.list", {});
    expect(hostIdsSent()).toEqual([poolEntry.hostId, poolEntry.hostId]);
  });

  it("returns a typed pool refusal to the caller and never re-sends the call to host A", async () => {
    const { client, hostIdsSent } = buildHarness(
      {
        ...okHandlers,
        "environment.list": () => {
          throw new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "pool refused",
            requestId: "req",
            method: "environment.list",
            fatalDetails: null,
          });
        },
      },
      localEntry.hostId,
    );
    await expect(
      client
        .createRequesterForHostId(localEntry.hostId)
        .request("environment.list", {}),
    ).rejects.toMatchObject({ code: "E_HOST_UNSUPPORTED" });
    expect(hostIdsSent()).toEqual([poolEntry.hostId]);
  });

  it("returns a pool transport failure to the caller and never re-sends the call to host A", async () => {
    const { client, hostIdsSent } = buildHarness(
      {
        ...okHandlers,
        "environment.list": () => {
          throw new Error("pool unreachable");
        },
      },
      localEntry.hostId,
    );
    await expect(
      client
        .createRequesterForHostId(localEntry.hostId)
        .request("environment.list", {}),
    ).rejects.toThrow("pool unreachable");
    expect(hostIdsSent()).toEqual([poolEntry.hostId]);
  });

  it("sends agent.sendMessage to the sender's host", async () => {
    const { client, hostIdsSent } = buildHarness(okHandlers, null);
    await client
      .createRequesterForHostId(personalRemoteEntry.hostId)
      .request("agent.sendMessage", {});
    expect(hostIdsSent()).toEqual([personalRemoteEntry.hostId]);
  });

  it("refuses agent.sendMessage on a pool requester before anything is sent", async () => {
    const { client, messenger } = buildHarness(okHandlers, localEntry.hostId);
    await expect(
      client
        .createRequesterForHostId(poolEntry.hostId)
        .request("agent.sendMessage", {}),
    ).rejects.toMatchObject({ code: "E_HOST_UNSUPPORTED" });
    expect(messenger.calls).toEqual([]);
  });

  it("gives agent.sendMessage a typed preflight error with no pool call when no host resolves", async () => {
    const { client, messenger } = buildHarness(okHandlers, localEntry.hostId);
    await expect(
      client.createRequesterForHostId(null).request("agent.sendMessage", {}),
    ).rejects.toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-preflight",
    });
    expect(messenger.calls).toEqual([]);
  });

  it.each([
    ["a team sandbox", teamSandboxEntry.hostId],
    ["the pool", poolEntry.hostId],
  ])(
    "sends speech.getModelStatus from %s to the selected local host",
    async (_label, requesterHostId) => {
      const { client, hostIdsSent } = buildHarness(
        okHandlers,
        localEntry.hostId,
      );
      await client
        .createRequesterForHostId(requesterHostId)
        .request("speech.getModelStatus", {});
      expect(hostIdsSent()).toEqual([localEntry.hostId]);
    },
  );

  it("refuses speech.getModelStatus when the selected host is a sandbox", async () => {
    const { client, messenger } = buildHarness(
      okHandlers,
      teamSandboxEntry.hostId,
    );
    await expect(
      client
        .createRequesterForHostId(localEntry.hostId)
        .request("speech.getModelStatus", {}),
    ).rejects.toMatchObject({ code: "E_HOST_UNSUPPORTED" });
    expect(messenger.calls).toEqual([]);
  });
});
