/**
 * Where a new bot is created (Tracy Bots): the app walks a fixed order - this
 * machine, the active host, then the rest by host id - and takes the first
 * host that runs the bot's environment and advertises `bot.create`. A host
 * still being asked holds the walk; a host
 * whose read failed is passed over.
 */
import { describe, expect, it } from "vitest";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import {
  chooseBotCreateHost,
  type BotCreateHostChoice,
} from "../bot-create-host";

const TEAM_ENV = "env-team";
const OTHER_ENV = "env-other";
const PERSONAL_ENV = "env-personal";

function descriptor(environmentId: string): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: "org-1",
    roomId: `room-${environmentId}`,
    label: environmentId,
  };
}

function bindingFor(
  hostId: string,
  environmentId: string,
): EnvironmentHostBinding {
  return {
    hostId,
    environment: descriptor(environmentId),
    explicit: true,
    enrolledByUserId: "user-1",
    canUnbind: true,
  };
}

interface Scenario {
  readonly localHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly connectableHostIds: ReadonlyArray<string>;
  /** hostId -> environment id it is bound to; absent = not answered. */
  readonly bound: Readonly<Record<string, string>>;
  readonly failedHostIds: ReadonlyArray<string>;
  readonly creatingHostIds: ReadonlyArray<string>;
}

function choose(scenario: Scenario): BotCreateHostChoice {
  const bindings = new Map<string, EnvironmentHostBinding>();
  for (const [hostId, environmentId] of Object.entries(scenario.bound)) {
    bindings.set(hostId, bindingFor(hostId, environmentId));
  }
  return chooseBotCreateHost({
    environmentId: TEAM_ENV,
    localHostId: scenario.localHostId,
    effectiveHostId: scenario.effectiveHostId,
    connectableHostIds: scenario.connectableHostIds,
    bindings,
    failedHostIds: scenario.failedHostIds,
    creatingHostIds: new Set(scenario.creatingHostIds),
  });
}

const ALL_QUALIFY: Scenario = {
  localHostId: "host-local",
  effectiveHostId: "host-effective",
  connectableHostIds: [
    "host-zeta",
    "host-effective",
    "host-local",
    "host-alpha",
  ],
  bound: {
    "host-local": TEAM_ENV,
    "host-effective": TEAM_ENV,
    "host-zeta": TEAM_ENV,
    "host-alpha": TEAM_ENV,
  },
  failedHostIds: [],
  creatingHostIds: ["host-local", "host-effective", "host-zeta", "host-alpha"],
};

describe("chooseBotCreateHost order", () => {
  it("takes this machine when it qualifies, whatever else does", () => {
    expect(choose(ALL_QUALIFY)).toEqual({
      kind: "chosen",
      hostId: "host-local",
    });
  });

  it("takes the active host next when this machine does not qualify", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        creatingHostIds: ["host-effective", "host-zeta", "host-alpha"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-effective" });
  });

  it("takes the active host when the app has no local host (web, mobile)", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        localHostId: null,
        connectableHostIds: ["host-zeta", "host-effective", "host-alpha"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-effective" });
  });

  it("walks the rest in host id order, not in the order they were listed", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        creatingHostIds: ["host-zeta", "host-alpha"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-alpha" });
    expect(
      choose({
        ...ALL_QUALIFY,
        connectableHostIds: ["host-zeta", "host-alpha"],
        creatingHostIds: ["host-zeta", "host-alpha"],
        bound: { "host-zeta": TEAM_ENV, "host-alpha": TEAM_ENV },
        localHostId: null,
        effectiveHostId: null,
      }),
    ).toEqual({ kind: "chosen", hostId: "host-alpha" });
  });

  it("does not consider a local or active host this client cannot dial", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        connectableHostIds: ["host-zeta", "host-alpha"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-alpha" });
  });
});

describe("chooseBotCreateHost qualification", () => {
  it("skips a host bound to another environment", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: { ...ALL_QUALIFY.bound, "host-local": OTHER_ENV },
      }),
    ).toEqual({ kind: "chosen", hostId: "host-effective" });
  });

  it("answers none when no host is bound to the environment", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: {
          "host-local": OTHER_ENV,
          "host-effective": OTHER_ENV,
          "host-zeta": OTHER_ENV,
          "host-alpha": OTHER_ENV,
        },
      }),
    ).toEqual({ kind: "none" });
  });

  it("answers none when no bound host advertises bot.create", () => {
    expect(choose({ ...ALL_QUALIFY, creatingHostIds: [] })).toEqual({
      kind: "none",
    });
  });

  it("answers none for no connectable host at all", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        connectableHostIds: [],
        bound: {},
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("chooseBotCreateHost for a team's environment", () => {
  it("chooses a sandbox whose binding names the team and that advertises bot.create, past personal machines", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        connectableHostIds: ["host-local", "host-effective", "host-sandbox"],
        bound: {
          "host-local": PERSONAL_ENV,
          "host-effective": PERSONAL_ENV,
          "host-sandbox": TEAM_ENV,
        },
        creatingHostIds: ["host-local", "host-effective", "host-sandbox"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-sandbox" });
  });
});

describe("chooseBotCreateHost while hosts are still being asked", () => {
  it("answers checking when an earlier host is unanswered, even if a later one qualifies", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: {
          "host-effective": TEAM_ENV,
          "host-zeta": TEAM_ENV,
          "host-alpha": TEAM_ENV,
        },
      }),
    ).toEqual({ kind: "checking" });
  });

  it("answers checking when only a later host is unanswered and no earlier one qualifies", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        creatingHostIds: [],
        bound: {
          "host-local": TEAM_ENV,
          "host-effective": TEAM_ENV,
          "host-alpha": TEAM_ENV,
        },
      }),
    ).toEqual({ kind: "checking" });
  });

  it("settles on an earlier qualifying host without waiting for a later one", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: { "host-local": TEAM_ENV },
      }),
    ).toEqual({ kind: "chosen", hostId: "host-local" });
  });

  it("passes over a host whose read failed", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: {
          "host-effective": TEAM_ENV,
          "host-zeta": TEAM_ENV,
          "host-alpha": TEAM_ENV,
        },
        failedHostIds: ["host-local"],
      }),
    ).toEqual({ kind: "chosen", hostId: "host-effective" });
  });

  it("answers none when every candidate failed or does not qualify", () => {
    expect(
      choose({
        ...ALL_QUALIFY,
        bound: {},
        failedHostIds: [
          "host-local",
          "host-effective",
          "host-zeta",
          "host-alpha",
        ],
      }),
    ).toEqual({ kind: "none" });
  });
});
