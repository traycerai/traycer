import { describe, expect, it } from "vitest";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import {
  collisionLine,
  hostsRunningConfiguration,
  type FirsthandHost,
} from "@/components/settings/environment/hosts-running-configuration-model";

function row(
  hostId: string,
  overrides: Partial<EnvironmentHostRecordV12>,
): EnvironmentHostRecordV12 {
  return {
    hostId,
    hostLabel: hostId,
    hostPlatform: null,
    enrolledByUserId: "u1",
    boundAt: 1,
    kind: "personal",
    reachable: true,
    lastReportedAt: 1,
    applied: [],
    hasLocalRow: false,
    ...overrides,
  };
}

function firsthand(
  hostId: string,
  overrides: Partial<FirsthandHost>,
): FirsthandHost {
  return {
    hostId,
    name: hostId,
    isLocalMachine: false,
    sandbox: false,
    ...overrides,
  };
}

const NO_LOCAL: ReadonlySet<string> = new Set();

describe("hostsRunningConfiguration", () => {
  it("lists a host the cloud calls offline with an old report", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [row("a", { reachable: false, lastReportedAt: 1 })],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [],
    });
    expect(hosts.map((host) => host.hostId)).toEqual(["a"]);
  });

  it("leaves out Local-row hosts, adds status-only hosts, lists a host once", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [row("a", {}), row("b", {}), row("local", {})],
      localHostIds: new Set(["local"]),
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [
        firsthand("b", {}),
        firsthand("c", { sandbox: true }),
        firsthand("local", {}),
      ],
      firsthand: [],
    });
    expect(hosts.map((host) => [host.hostId, host.kind])).toEqual([
      ["a", "personal"],
      ["b", "personal"],
      ["c", "sandbox"],
    ]);
  });

  it("leaves out a host whose last report says it has a Local row", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [row("moved", {}), row("partial", { hasLocalRow: true })],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [],
    });
    expect(hosts.map((host) => host.hostId)).toEqual(["moved"]);
  });

  it("counts a host that reported without saying whether it has a Local row", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [row("older", { hasLocalRow: null, lastReportedAt: 5 })],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [],
    });
    expect(hosts.map((host) => host.hostId)).toEqual(["older"]);
  });

  it("leaves out a computer that never reported, but not a sandbox that never did", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [
        row("computer", { kind: "personal", lastReportedAt: null }),
        row("sandbox", { kind: "sandbox", lastReportedAt: null }),
      ],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [],
    });
    expect(hosts.map((host) => host.hostId)).toEqual(["sandbox"]);
  });

  it("counts a Local-row host and a computer that never reported when the configuration is not Personal", () => {
    const { hosts } = hostsRunningConfiguration({
      rows: [
        row("partial", { hasLocalRow: true }),
        row("silent", { kind: "personal", lastReportedAt: null }),
      ],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: false,
      runningByStatus: [],
      firsthand: [],
    });
    expect(hosts.map((host) => host.hostId)).toEqual(["partial", "silent"]);
  });

  it("names this computer only once its own status has answered", () => {
    const own = firsthand("own", { isLocalMachine: true });
    const input = {
      rows: [row("own", {})],
      localHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [own],
      firsthand: [own],
    };
    const before = hostsRunningConfiguration({
      ...input,
      unreadHostIds: new Set(["own"]),
    });
    expect(before.hosts).toEqual([]);
    const after = hostsRunningConfiguration({
      ...input,
      unreadHostIds: NO_LOCAL,
    });
    expect(after.hosts.map((host) => host.hostId)).toEqual(["own"]);
  });

  it("does not add this computer by its status while its status is unread", () => {
    const own = firsthand("own", { isLocalMachine: true });
    const input = {
      rows: [],
      localHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [own],
      firsthand: [own],
    };
    expect(
      hostsRunningConfiguration({ ...input, unreadHostIds: new Set(["own"]) })
        .hosts,
    ).toEqual([]);
    expect(
      hostsRunningConfiguration({
        ...input,
        unreadHostIds: NO_LOCAL,
      }).hosts.map((host) => host.hostId),
    ).toEqual(["own"]);
  });

  it("marks (this computer) only on the window's own computer while names collide", () => {
    const rows = [
      row("own", { hostLabel: "windows-test-machine" }),
      row("other", { hostLabel: "windows-test-machine" }),
    ];
    const colliding = hostsRunningConfiguration({
      rows,
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [firsthand("own", { isLocalMachine: true })],
    });
    expect(colliding.hosts.map((host) => host.name)).toEqual([
      "windows-test-machine (this computer)",
      "windows-test-machine",
    ]);
    expect(colliding.collisions).toEqual([
      { hostName: "windows-test-machine", hostIds: ["own", "other"] },
    ]);
    const unique = hostsRunningConfiguration({
      rows: [row("own", { hostLabel: "windows-test-machine" })],
      localHostIds: NO_LOCAL,
      unreadHostIds: NO_LOCAL,
      personal: true,
      runningByStatus: [],
      firsthand: [firsthand("own", { isLocalMachine: true })],
    });
    expect(unique.hosts[0]?.name).toBe("windows-test-machine");
    expect(unique.collisions).toEqual([]);
  });
});

describe("collisionLine", () => {
  it("counts the computers that share a name", () => {
    expect(collisionLine({ hostName: "m", hostIds: ["a", "b"] })).toBe(
      "Two computers are named m",
    );
    expect(collisionLine({ hostName: "m", hostIds: ["a", "b", "c"] })).toBe(
      "Three computers are named m",
    );
  });
});
