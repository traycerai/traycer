import { describe, expect, it, vi } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { PROFILE_SYNC_LINK_RPC_METHODS } from "@traycer/protocol/host/profile-sync-link-contracts";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import { releasedStreamMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-stream-method-names";
import {
  accountWideManifestFixtures,
  CURRENT_TEAM_COMPUTER_METHODS,
} from "../../test-fixtures/account-wide-manifest";
import { POOL_HOST_ID } from "../host-directory";
import {
  HOST_STREAM_RPC_ROUTES,
  HOST_UNARY_RPC_ROUTES,
  NO_POOL_HOST_RPC_TIER_PLAN,
  NO_SERVING_PEER_DECISION,
  chatServingHostId,
  isMachineHostDirectoryEntry,
  createHostRpcTierPlan,
  decideHostRpcDispatch,
  decideHostStreamDispatch,
  accountWideAnswerer,
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

const CONFIGURATION_ACCOUNT_WIDE = [
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
  "environment.configuration.revision",
  "environment.configuration.skills.list",
  "environment.configuration.skills.remove",
  "environment.configuration.skills.setPolicy",
  "environment.configuration.skills.setProviders",
  "environment.configuration.skills.upload",
  "environment.history",
  "environment.host.list",
  "environment.members",
  "environment.members.invite",
  "environment.members.noticeSeen",
  "environment.members.remove",
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

const EXPECTED_PROTOCOL_RETAINED_PROFILE_SYNC_METHODS = [
  "host.profileSync.apply",
  "host.profileSync.fetchCredential",
  "host.profileSync.offerCredential",
  "providers.profileSync.acceptAccount",
  "providers.profileSync.overview",
  "providers.profileSync.setKeepInSync",
  "providers.profileSync.syncNow",
].sort();

describe("host RPC routing table", () => {
  it("does not route retired team provider profile calls", () => {
    for (const method of [
      "environment.providers.list",
      "environment.providers.signOutProfile",
      "environment.providers.removeProfile",
      "environment.providers.renameProfile",
    ]) {
      expect(hostRpcRouteOf(method)).toBeNull();
    }
  });

  it("routes every client method and leaves exactly the retained profile-sync methods unrouted", () => {
    const protocolRetained = Object.keys(PROFILE_SYNC_LINK_RPC_METHODS).sort();
    const clientUnary = Object.keys(hostRpcRegistry)
      .filter((name) => !protocolRetained.includes(name))
      .sort();
    const names = [
      ...releasedMethodNames,
      ...releasedStreamMethodNames,
      ...clientUnary,
      ...Object.keys(hostStreamRpcRegistry),
    ];
    const unrouted = names.filter((name) => hostRpcRouteOf(name) === null);
    expect([...clientUnary, ...protocolRetained].sort()).toEqual(
      Object.keys(hostRpcRegistry).sort(),
    );
    expect(protocolRetained).toEqual(
      EXPECTED_PROTOCOL_RETAINED_PROFILE_SYNC_METHODS,
    );
    expect(Object.keys(HOST_UNARY_RPC_ROUTES).sort()).toEqual(clientUnary);
    expect(unrouted).toEqual([]);
    for (const method of protocolRetained) {
      expect(hostRpcRouteOf(method)).toBeNull();
    }
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

  it("routes exactly the four pool-only streams to the pool", () => {
    const poolOnly = [
      ...Object.entries(HOST_UNARY_RPC_ROUTES),
      ...Object.entries(HOST_STREAM_RPC_ROUTES),
    ]
      .filter(([, route]) => route === "pool-only")
      .map(([name]) => name)
      .sort();
    expect(poolOnly).toEqual([
      "chat.serving.subscribe",
      "environment.chats.subscribe",
      "environment.communicationGraph.subscribe",
      "environment.plainTerminals.subscribe",
    ]);
    expect(
      [
        ...Object.entries(HOST_UNARY_RPC_ROUTES),
        ...Object.entries(HOST_STREAM_RPC_ROUTES),
      ].filter(([, route]) => route === "account-wide"),
    ).toHaveLength(56);
  });

  it("reads the local History contribution from the host that holds it", () => {
    expect(hostRpcRouteOf("epic.localHistory.read")).toBe("target-host");
  });

  it("keeps environment.host.read on the target host for good", () => {
    expect(hostRpcRouteOf("environment.host.read")).toBe("target-host");
  });

  it("sends a skill's update, restore, state read and import to the host serving the configuration", () => {
    expect(hostRpcRouteOf("environment.configuration.skills.update")).toBe(
      "target-host",
    );
    expect(
      hostRpcRouteOf("environment.configuration.skills.restoreBundled"),
    ).toBe("target-host");
    expect(hostRpcRouteOf("environment.configuration.skills.state")).toBe(
      "target-host",
    );
    expect(hostRpcRouteOf("environment.configuration.skills.import")).toBe(
      "target-host",
    );
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
        decideHostRpcDispatch(
          "test.method",
          "pool-only",
          target,
          null,
          POOL_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: poolEntry });
    }
  });

  it("uses each account-wide method's manifest and authority to choose its serving peer", () => {
    const {
      methods: accountWideMethods,
      released151,
      released154,
      current,
    } = accountWideManifestFixtures();
    const fixtures = [released151, released154, current];
    expect(fixtures.map((fixture) => fixture.size)).toEqual([14, 54, 23]);
    expect(accountWideMethods).toHaveLength(56);
    expect(
      fixtures.map(
        (fixture) =>
          accountWideMethods.filter((method) => fixture.has(method)).length,
      ),
    ).toEqual([14, 54, 23]);
    expect(
      fixtures.map((fixture) =>
        [...fixture].filter((method) => !accountWideMethods.includes(method)),
      ),
    ).toEqual([[], [], []]);

    for (const method of accountWideMethods) {
      const route =
        HOST_UNARY_RPC_ROUTES[method as keyof typeof HOST_UNARY_RPC_ROUTES];
      if (route === undefined) continue;
      const teamScoped =
        method.startsWith("environment.configuration.guide.") ||
        method.startsWith("environment.configuration.skills.");
      for (const manifest of fixtures) {
        const servingOwn = {
          servingPeer: personalRemoteEntry,
          servingPeerMethods: manifest,
          servingPeerEnvironmentId: null,
        };
        const ownResult = decideHostRpcDispatch(
          method,
          route,
          localEntry,
          null,
          POOL_PLAN,
          null,
          servingOwn,
          null,
        );
        expect(ownResult).toEqual({
          kind: "dispatch",
          entry: manifest.has(method) ? personalRemoteEntry : poolEntry,
        });

        const team = {
          ...personalRemoteEntry,
          owner: { kind: "team" as const, id: "team-1", name: "Team" },
        };
        const servingTeam = {
          servingPeer: team,
          servingPeerMethods: new Set(accountWideMethods),
          servingPeerEnvironmentId: "env-1",
        };
        const matchingEnvironment = teamScoped;
        const teamResult = decideHostRpcDispatch(
          method,
          route,
          localEntry,
          null,
          POOL_PLAN,
          null,
          servingTeam,
          matchingEnvironment ? "env-1" : null,
        );
        expect(teamResult).toEqual({
          kind: "dispatch",
          entry: matchingEnvironment ? team : poolEntry,
        });

        for (const servingPeer of [poolEntry, null]) {
          expect(
            decideHostRpcDispatch(
              method,
              route,
              localEntry,
              null,
              POOL_PLAN,
              null,
              {
                servingPeer,
                servingPeerMethods:
                  servingPeer === null ? null : new Set(accountWideMethods),
                servingPeerEnvironmentId: null,
              },
              null,
            ),
          ).toEqual({ kind: "dispatch", entry: poolEntry });
        }
        expect(
          decideHostRpcDispatch(
            method,
            route,
            localEntry,
            null,
            NO_POOL_HOST_RPC_TIER_PLAN,
            null,
            servingOwn,
            null,
          ),
        ).toEqual({ kind: "dispatch", entry: localEntry });
      }
    }
  });

  it("dispatches every unary route for both build shapes and addressed peers", () => {
    const manifests = accountWideManifestFixtures();
    const servingCases = [
      ...[
        manifests.released151,
        manifests.released154,
        manifests.current,
      ].flatMap((methods) => [
        {
          peer: personalRemoteEntry,
          methods,
          environmentId: null,
          callEnvironmentId: null,
        },
        {
          peer: personalRemoteEntry,
          methods: new Set<string>(),
          environmentId: null,
          callEnvironmentId: null,
        },
      ]),
      {
        peer: teamSandboxEntry,
        methods: manifests.current,
        environmentId: "env-team",
        callEnvironmentId: "env-team",
      },
      {
        peer: teamSandboxEntry,
        methods: manifests.current,
        environmentId: "env-team",
        callEnvironmentId: "env-other",
      },
      {
        peer: poolEntry,
        methods: manifests.current,
        environmentId: null,
        callEnvironmentId: null,
      },
      {
        peer: null,
        methods: null,
        environmentId: null,
        callEnvironmentId: null,
      },
    ];
    for (const [method, route] of Object.entries(HOST_UNARY_RPC_ROUTES)) {
      for (const target of [
        personalRemoteEntry,
        teamSandboxEntry,
        poolEntry,
        null,
      ]) {
        for (const targetMethods of [new Set([method]), new Set<string>()]) {
          for (const plan of [POOL_PLAN, NO_POOL_HOST_RPC_TIER_PLAN]) {
            for (const servingCase of servingCases) {
              const result = decideHostRpcDispatch(
                method,
                route,
                target,
                targetMethods,
                plan,
                localEntry,
                {
                  servingPeer: servingCase.peer,
                  servingPeerMethods: servingCase.methods,
                  servingPeerEnvironmentId: servingCase.environmentId,
                },
                servingCase.callEnvironmentId,
              );
              let expected: typeof result;
              switch (route) {
                case "account-wide":
                  if (plan.pool === null) {
                    expected =
                      target === null
                        ? {
                            kind: "refuse",
                            code: "RPC_ERROR",
                            message:
                              "Cannot call host RPC without an active host",
                          }
                        : { kind: "dispatch", entry: target };
                    break;
                  }
                  const peer = servingCase.peer;
                  const isComputer = peer !== null && peer !== poolEntry;
                  const methodNegotiated =
                    servingCase.methods?.has(method) === true;
                  const isTeamComputer = peer === teamSandboxEntry;
                  const teamCallAuthorized =
                    !isTeamComputer ||
                    (CURRENT_TEAM_COMPUTER_METHODS.has(method) &&
                      servingCase.callEnvironmentId ===
                        servingCase.environmentId);
                  const computerAnswers =
                    isComputer && methodNegotiated && teamCallAuthorized;
                  expected = computerAnswers
                    ? { kind: "dispatch", entry: peer }
                    : { kind: "dispatch", entry: poolEntry };
                  break;
                case "target-host":
                case "sender-host":
                  expected =
                    target === null
                      ? {
                          kind: "refuse",
                          code: "RPC_ERROR",
                          message:
                            "Cannot call host RPC without an active host",
                        }
                      : target === poolEntry
                        ? {
                            kind: "refuse",
                            code: "E_HOST_UNSUPPORTED",
                            message:
                              "The server pool does not serve this method",
                          }
                        : { kind: "dispatch", entry: target };
                  break;
                case "selected-host":
                  expected = { kind: "dispatch", entry: localEntry };
                  break;
                case "addressed-peer":
                  expected =
                    method === "host.status" ||
                    method === "host.getRuntimeCapabilities" ||
                    targetMethods.has(method)
                      ? target === null
                        ? {
                            kind: "refuse",
                            code: "RPC_ERROR",
                            message:
                              "Cannot call host RPC without an active host",
                          }
                        : { kind: "dispatch", entry: target }
                      : {
                          kind: "refuse",
                          code: "E_HOST_UNSUPPORTED",
                          message:
                            "The addressed peer does not serve this method",
                        };
                  break;
                case "target-host-live-pool-at-rest":
                  expected =
                    target === null
                      ? {
                          kind: "refuse",
                          code: "RPC_ERROR",
                          message:
                            "Cannot call host RPC without an active host",
                        }
                      : { kind: "dispatch", entry: target };
                  break;
              }
              expect(result).toEqual(expected);
            }
          }
        }
      }
    }
  });

  it("keeps a task call on its addressed session and checks that peer's manifest before dispatch", () => {
    for (const method of [
      "artifact.read",
      "comments.listThreads",
      "epic.getTask",
    ] as const) {
      const accepted = decideHostRpcDispatch(
        method,
        "addressed-peer",
        personalRemoteEntry,
        new Set([method]),
        POOL_PLAN,
        null,
        {
          servingPeer: localEntry,
          servingPeerMethods: new Set([method]),
          servingPeerEnvironmentId: null,
        },
        null,
      );
      expect(accepted).toEqual({
        kind: "dispatch",
        entry: personalRemoteEntry,
      });
      const refused = decideHostRpcDispatch(
        method,
        "addressed-peer",
        personalRemoteEntry,
        new Set(),
        POOL_PLAN,
        null,
        {
          servingPeer: localEntry,
          servingPeerMethods: new Set([method]),
          servingPeerEnvironmentId: null,
        },
        null,
      );
      expect(refused).toMatchObject({
        kind: "refuse",
        code: "E_HOST_UNSUPPORTED",
      });
    }
    expect(
      decideHostRpcDispatch(
        "artifact.read",
        "addressed-peer",
        poolEntry,
        new Set(["artifact.read"]),
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toEqual({ kind: "dispatch", entry: poolEntry });
  });

  it.each([
    ["host.status", "pool build"],
    ["host.getRuntimeCapabilities", "pool build"],
    ["host.status", "no-pool build"],
    ["host.getRuntimeCapabilities", "no-pool build"],
  ] as const)(
    "dispatches %s to its addressed peer under a stale manifest (%s)",
    (method, build) => {
      const tierPlan =
        build === "pool build" ? POOL_PLAN : NO_POOL_HOST_RPC_TIER_PLAN;
      expect(
        decideHostRpcDispatch(
          method,
          "addressed-peer",
          personalRemoteEntry,
          new Set(),
          tierPlan,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
    },
  );

  it("dispatches every stream by its route and keeps account-wide stream keys on their answering peer", () => {
    for (const [method, route] of Object.entries(HOST_STREAM_RPC_ROUTES)) {
      const result = decideHostStreamDispatch(
        method as keyof typeof HOST_STREAM_RPC_ROUTES,
        localEntry,
        new Set([method]),
        POOL_PLAN,
        localEntry,
        NO_SERVING_PEER_DECISION,
      );
      const expected =
        route === "pool-only" || route === "account-wide"
          ? poolEntry
          : localEntry;
      expect(result).toEqual({ kind: "dispatch", entry: expected });
      if (route === "pool-only" || route === "account-wide") {
        expect(
          decideHostStreamDispatch(
            method as keyof typeof HOST_STREAM_RPC_ROUTES,
            localEntry,
            new Set([method]),
            NO_POOL_HOST_RPC_TIER_PLAN,
            localEntry,
            NO_SERVING_PEER_DECISION,
          ),
        ).toEqual({ kind: "dispatch", entry: localEntry });
      }
    }
    const cloudFeed = "host.notifications.cloudFeed.subscribe";
    const computerServing = {
      servingPeer: personalRemoteEntry,
      servingPeerMethods: new Set([cloudFeed]),
      servingPeerEnvironmentId: null,
    };
    expect(
      decideHostStreamDispatch(
        cloudFeed,
        personalRemoteEntry,
        new Set([cloudFeed]),
        POOL_PLAN,
        null,
        computerServing,
      ),
    ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
    expect(
      decideHostStreamDispatch(
        cloudFeed,
        personalRemoteEntry,
        new Set([cloudFeed]),
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
      ),
    ).toEqual({ kind: "dispatch", entry: poolEntry });
    expect(accountWideAnswerer(cloudFeed, null, computerServing)).toBe(
      "computer",
    );
  });

  it("keeps a pool-only call on the target when the build has no pool", () => {
    expect(
      decideHostRpcDispatch(
        "test.method",
        "pool-only",
        personalRemoteEntry,
        null,
        NO_POOL_HOST_RPC_TIER_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
  });

  it.each(CONFIGURATION_ACCOUNT_WIDE)(
    "serves %s from the account-wide tier when the plan has one, else from the caller's host",
    (method) => {
      const route = hostRpcRouteOf(method);
      expect(route).toBe("account-wide");
      if (route === null) return;
      expect(
        decideHostRpcDispatch(
          method,
          route,
          personalRemoteEntry,
          null,
          POOL_PLAN,
          null,
          {
            servingPeer: null,
            servingPeerMethods: null,
            servingPeerEnvironmentId: null,
          },
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: poolEntry });
      expect(
        decideHostRpcDispatch(
          method,
          route,
          personalRemoteEntry,
          null,
          NO_POOL_HOST_RPC_TIER_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
    },
  );

  it.each(["target-host", "sender-host"] as const)(
    "refuses a %s call on the pool with E_HOST_UNSUPPORTED",
    (route) => {
      const decision = decideHostRpcDispatch(
        "test.method",
        route,
        poolEntry,
        null,
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      );
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.code).toBe("E_HOST_UNSUPPORTED");
      }
      expect(
        decideHostRpcDispatch(
          "test.method",
          route,
          teamSandboxEntry,
          null,
          POOL_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
      ).toEqual({ kind: "dispatch", entry: teamSandboxEntry });
    },
  );

  it("sends selected-host calls to a local or personal remote selected host", () => {
    for (const selected of [localEntry, personalRemoteEntry]) {
      expect(
        decideHostRpcDispatch(
          "test.method",
          "selected-host",
          teamSandboxEntry,
          null,
          POOL_PLAN,
          selected,
          NO_SERVING_PEER_DECISION,
          null,
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
        "test.method",
        "selected-host",
        localEntry,
        null,
        POOL_PLAN,
        selected,
        NO_SERVING_PEER_DECISION,
        null,
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
      expect(
        decideHostRpcDispatch(
          "test.method",
          route,
          poolEntry,
          null,
          POOL_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
      ).toEqual({
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
        hostRpcServingTierHostId(
          "environment.list",
          caller,
          POOL_PLAN,
          null,
          NO_SERVING_PEER_DECISION,
          null,
        ),
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
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toBe("host-a");
  });

  it("names the selected host for a selected-host method when known, else the caller's", () => {
    expect(
      hostRpcServingTierHostId(
        "speech.getModelStatus",
        "sb",
        POOL_PLAN,
        "mac",
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toBe("mac");
    expect(
      hostRpcServingTierHostId(
        "speech.getModelStatus",
        "sb",
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toBe("sb");
  });

  it("names the caller's host for a target-host method", () => {
    expect(
      hostRpcServingTierHostId(
        "agent.list",
        "sb",
        POOL_PLAN,
        "mac",
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toBe("sb");
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

  it("keeps the chat on its own host when the witness is not asked", () => {
    expect(chatServingHostId(chat, null, POOL_PLAN)).toBe("chat-host");
  });

  it("keeps the chat on its own host when the build has no pool", () => {
    expect(chatServingHostId(chat, "at-rest", NO_POOL_HOST_RPC_TIER_PLAN)).toBe(
      "chat-host",
    );
    expect(
      chatServingHostId(
        Object.assign({}, chat, { offlineOwner: true }),
        null,
        NO_POOL_HOST_RPC_TIER_PLAN,
      ),
    ).toBe("chat-host");
  });

  it("routes an offline owner through the pool even before its serving witness answers", () => {
    expect(
      chatServingHostId(
        Object.assign({}, chat, { offlineOwner: true }),
        null,
        POOL_PLAN,
      ),
    ).toBe(POOL_HOST_ID);
  });

  it("serves the chat from its host while live and from the pool at rest or unknown", () => {
    expect(chatServingHostId(chat, "live", POOL_PLAN)).toBe("chat-host");
    expect(chatServingHostId(chat, "at-rest", POOL_PLAN)).toBe(POOL_HOST_ID);
    expect(chatServingHostId(chat, "unknown", POOL_PLAN)).toBe(POOL_HOST_ID);
  });
});

describe("isMachineHostDirectoryEntry", () => {
  it("is a local or remote host that is not a sandbox, and never the pool", () => {
    expect(isMachineHostDirectoryEntry(localEntry)).toBe(true);
    expect(isMachineHostDirectoryEntry(personalRemoteEntry)).toBe(true);
    expect(isMachineHostDirectoryEntry(personalSandboxEntry)).toBe(false);
    expect(isMachineHostDirectoryEntry(teamSandboxEntry)).toBe(false);
    expect(isMachineHostDirectoryEntry(poolEntry)).toBe(false);
  });
});

describe("the bot shell output stream's route", () => {
  const METHOD = "managedCommand.subscribeBotOutput";

  it("is served by the host the tab is bound to, as the epic output stream is", () => {
    expect(HOST_STREAM_RPC_ROUTES[METHOD]).toBe("target-host");
    expect(HOST_STREAM_RPC_ROUTES[METHOD]).toBe(
      HOST_STREAM_RPC_ROUTES["managedCommand.subscribeOutput"],
    );
  });

  it("dispatches to the bound sandbox host, never to the pool, and refuses on the pool", () => {
    expect(
      decideHostRpcDispatch(
        "test.method",
        "target-host",
        teamSandboxEntry,
        null,
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toEqual({ kind: "dispatch", entry: teamSandboxEntry });
    expect(
      decideHostRpcDispatch(
        "test.method",
        "target-host",
        personalSandboxEntry,
        null,
        POOL_PLAN,
        null,
        NO_SERVING_PEER_DECISION,
        null,
      ),
    ).toEqual({ kind: "dispatch", entry: personalSandboxEntry });
    const decision = decideHostRpcDispatch(
      "test.method",
      "target-host",
      poolEntry,
      null,
      POOL_PLAN,
      null,
      NO_SERVING_PEER_DECISION,
      null,
    );
    expect(decision.kind).toBe("refuse");
  });
});
