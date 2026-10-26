import { describe, expect, it, vi } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { releasedStreamMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-stream-method-names";
import { POOL_HOST_ID } from "../host-directory";
import {
  HOST_STREAM_RPC_ROUTES,
  HOST_UNARY_RPC_ROUTES,
  NO_POOL_HOST_RPC_TIER_PLAN,
  chatServingHostId,
  createHostRpcTierPlan,
  decideHostRpcDispatch,
  hostRpcRouteOf,
  hostRpcServingTierHostId,
  type ChatServingKey,
} from "../host-rpc-routing";
import {
  localEntry,
  personalRemoteEntry,
  personalSandboxEntry,
  poolEntry,
  teamSandboxEntry,
} from "./routing-entry-fixtures";

const POOL_PLAN = createHostRpcTierPlan(poolEntry);

/** A configuration's own cloud state: served with no host running it. */
const CONFIGURATION_POOL_ONLY = [
  "environment.configuration.guide.get",
  "environment.configuration.guide.reset",
  "environment.configuration.guide.set",
  "environment.configuration.items",
  "environment.configuration.items.delete",
  "environment.configuration.items.put",
  "environment.configuration.mcpServers.delete",
  "environment.configuration.mcpServers.list",
  "environment.configuration.mcpServers.put",
  "environment.configuration.mcpServers.setEnabled",
  "environment.configuration.policy.put",
  "environment.configuration.skills.list",
  "environment.configuration.skills.remove",
  "environment.configuration.skills.setProviders",
  "environment.configuration.skills.upload",
  "environment.history",
  "environment.host.list",
  "environment.members",
  "environment.members.invite",
  "environment.members.noticeSeen",
  "environment.members.remove",
  "environment.members.removePreview",
  "environment.members.seats",
  "environment.members.setRole",
  "environment.plans.list",
  "environment.plans.unlink",
  "environment.plans.unlinkPreview",
  "environment.secrets.consent",
  "environment.secrets.create",
  "environment.secrets.destroy",
  "environment.secrets.list",
  "environment.secrets.replaceValue",
  "environment.secrets.rotation",
  "environment.secrets.undo",
  "environment.secrets.verify",
  "environment.secrets.versions",
];

const EXPECTED_POOL_ONLY = [
  ...CONFIGURATION_POOL_ONLY,
  "autoPolicy.get",
  "autoPolicy.set",
  "chat.serving.subscribe",
  "environment.chats.subscribe",
  "environment.invitations.accept",
  "environment.invitations.list",
  "environment.binding.read",
  "environment.communicationGraph.subscribe",
  "environment.list",
  "epic.listTasks",
  "environment.plainTerminals.subscribe",
  "host.notifications.cloudFeed.clear",
  "host.notifications.cloudFeed.clearAll",
  "host.notifications.cloudFeed.markAllRead",
  "host.notifications.cloudFeed.markRead",
  "host.notifications.cloudFeed.resolve",
  "host.notifications.cloudFeed.subscribe",
  "organization.command",
  "organization.history",
  "organization.read",
  "organization.refresh",
  "organization.subscribe",
].sort();

describe("host RPC routing table", () => {
  it("routes every released unary and stream name and every registry key", () => {
    const names = [
      ...releasedMethodNames,
      ...releasedStreamMethodNames,
      ...Object.keys(hostRpcRegistry),
      ...Object.keys(hostStreamRpcRegistry),
    ];
    const unrouted = names.filter((name) => hostRpcRouteOf(name) === null);
    expect(unrouted).toEqual([]);
  });

  it("has no route for a name outside the registries", () => {
    const known = new Set<string>([
      ...Object.keys(hostRpcRegistry),
      ...Object.keys(hostStreamRpcRegistry),
    ]);
    const extra = [
      ...Object.keys(HOST_UNARY_RPC_ROUTES),
      ...Object.keys(HOST_STREAM_RPC_ROUTES),
    ].filter((name) => !known.has(name));
    expect(extra).toEqual([]);
    expect(hostRpcRouteOf("not.a.method")).toBeNull();
  });

  it("routes exactly the account-wide families pool-only", () => {
    const poolOnly = [
      ...Object.entries(HOST_UNARY_RPC_ROUTES),
      ...Object.entries(HOST_STREAM_RPC_ROUTES),
    ]
      .filter(([, route]) => route === "pool-only")
      .map(([name]) => name)
      .sort();
    expect(poolOnly).toEqual(EXPECTED_POOL_ONLY);
  });

  it("reads the local History contribution from the host that holds it", () => {
    expect(hostRpcRouteOf("epic.localHistory.read")).toBe("target-host");
  });

  it("keeps environment.host.read on the target host for good", () => {
    expect(hostRpcRouteOf("environment.host.read")).toBe("target-host");
  });
});

describe("decideHostRpcDispatch", () => {
  it("sends a pool-only call to the pool whatever the target", () => {
    for (const target of [
      localEntry,
      personalRemoteEntry,
      teamSandboxEntry,
      poolEntry,
    ]) {
      expect(
        decideHostRpcDispatch("pool-only", target, POOL_PLAN, null),
      ).toEqual({ kind: "dispatch", entry: poolEntry });
    }
  });

  it("keeps a pool-only call on the target when the build has no pool", () => {
    expect(
      decideHostRpcDispatch(
        "pool-only",
        personalRemoteEntry,
        NO_POOL_HOST_RPC_TIER_PLAN,
        null,
      ),
    ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
  });

  it.each(CONFIGURATION_POOL_ONLY)(
    "serves %s from the pool when the plan has one, else from the caller's host",
    (method) => {
      const route = hostRpcRouteOf(method);
      expect(route).toBe("pool-only");
      if (route === null) return;
      expect(
        decideHostRpcDispatch(route, personalRemoteEntry, POOL_PLAN, null),
      ).toEqual({ kind: "dispatch", entry: poolEntry });
      expect(
        decideHostRpcDispatch(
          route,
          personalRemoteEntry,
          NO_POOL_HOST_RPC_TIER_PLAN,
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
    },
  );

  it.each(["target-host", "sender-host"] as const)(
    "refuses a %s call on the pool with E_HOST_UNSUPPORTED",
    (route) => {
      const decision = decideHostRpcDispatch(route, poolEntry, POOL_PLAN, null);
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.code).toBe("E_HOST_UNSUPPORTED");
      }
      expect(
        decideHostRpcDispatch(route, teamSandboxEntry, POOL_PLAN, null),
      ).toEqual({ kind: "dispatch", entry: teamSandboxEntry });
    },
  );

  it("sends selected-host calls to a local or personal remote selected host", () => {
    for (const selected of [localEntry, personalRemoteEntry]) {
      expect(
        decideHostRpcDispatch(
          "selected-host",
          teamSandboxEntry,
          POOL_PLAN,
          selected,
        ),
      ).toEqual({ kind: "dispatch", entry: selected });
    }
  });

  it("refuses selected-host calls when the selected host is a sandbox, the pool or absent", () => {
    for (const selected of [
      teamSandboxEntry,
      personalSandboxEntry,
      poolEntry,
      null,
    ]) {
      const decision = decideHostRpcDispatch(
        "selected-host",
        localEntry,
        POOL_PLAN,
        selected,
      );
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.code).toBe("E_HOST_UNSUPPORTED");
      }
    }
  });

  it.each(["addressed-peer", "target-host-live-pool-at-rest"] as const)(
    "accepts the pool for %s",
    (route) => {
      expect(decideHostRpcDispatch(route, poolEntry, POOL_PLAN, null)).toEqual({
        kind: "dispatch",
        entry: poolEntry,
      });
    },
  );
});

describe("hostRpcServingTierHostId", () => {
  it("names the pool for a pool-only method whatever the caller's host, null included", () => {
    for (const caller of ["host-a", teamSandboxEntry.hostId, null]) {
      expect(
        hostRpcServingTierHostId("environment.list", caller, POOL_PLAN, null),
      ).toBe(POOL_HOST_ID);
    }
  });

  it("names the caller's host for a pool-only method when the build has no pool", () => {
    expect(
      hostRpcServingTierHostId(
        "environment.list",
        "host-a",
        NO_POOL_HOST_RPC_TIER_PLAN,
        null,
      ),
    ).toBe("host-a");
  });

  it("names the selected host for a selected-host method when known, else the caller's", () => {
    expect(
      hostRpcServingTierHostId("speech.getModelStatus", "sb", POOL_PLAN, "mac"),
    ).toBe("mac");
    expect(
      hostRpcServingTierHostId("speech.getModelStatus", "sb", POOL_PLAN, null),
    ).toBe("sb");
  });

  it("names the caller's host for a target-host method", () => {
    expect(hostRpcServingTierHostId("agent.list", "sb", POOL_PLAN, "mac")).toBe(
      "sb",
    );
  });
});

describe("settleProcessHostRpcTierPlan", () => {
  it("is decided by the first call; a later call with a different pool gets the first plan", async () => {
    vi.resetModules();
    const routing = await import("../host-rpc-routing");
    expect(routing.readProcessHostRpcTierPlan().pool).toBeNull();
    const first = routing.settleProcessHostRpcTierPlan(null);
    expect(first.pool).toBeNull();
    const second = routing.settleProcessHostRpcTierPlan(poolEntry);
    expect(second).toBe(first);
    expect(routing.readProcessHostRpcTierPlan()).toBe(first);
  });

  it("keeps a first plan that carries the pool", async () => {
    vi.resetModules();
    const routing = await import("../host-rpc-routing");
    const first = routing.settleProcessHostRpcTierPlan(poolEntry);
    expect(first.pool?.hostId).toBe(POOL_HOST_ID);
    expect(routing.settleProcessHostRpcTierPlan(null)).toBe(first);
  });
});

describe("chatServingHostId", () => {
  const chat: ChatServingKey = {
    hostId: "chat-host",
    epicId: "epic-1",
    chatId: "chat-1",
  };

  it("keeps the chat on its own host with no witness", () => {
    expect(chatServingHostId(chat, teamSandboxEntry, null, POOL_PLAN)).toBe(
      "chat-host",
    );
  });

  it("keeps the chat on its own host when the build has no pool", () => {
    expect(
      chatServingHostId(
        chat,
        teamSandboxEntry,
        "at-rest",
        NO_POOL_HOST_RPC_TIER_PLAN,
      ),
    ).toBe("chat-host");
  });

  it("never moves a personal host's chat, whatever the verdict", () => {
    for (const host of [
      localEntry,
      personalRemoteEntry,
      personalSandboxEntry,
    ]) {
      for (const verdict of ["live", "at-rest", "unknown"] as const) {
        expect(chatServingHostId(chat, host, verdict, POOL_PLAN)).toBe(
          "chat-host",
        );
      }
    }
  });

  it("serves a team sandbox's chat from the sandbox while live and from the pool at rest or unknown", () => {
    expect(chatServingHostId(chat, teamSandboxEntry, "live", POOL_PLAN)).toBe(
      "chat-host",
    );
    expect(
      chatServingHostId(chat, teamSandboxEntry, "at-rest", POOL_PLAN),
    ).toBe(POOL_HOST_ID);
    expect(
      chatServingHostId(chat, teamSandboxEntry, "unknown", POOL_PLAN),
    ).toBe(POOL_HOST_ID);
  });
});
