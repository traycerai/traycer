import { describe, expect, it } from "vitest";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import {
  WIRE_ROLE_NO_AUTHORITY,
  enrichConfigurationList,
  type ConfigurationListFacts,
} from "@traycer/protocol/host/environment/configuration-list";

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-1",
  roomId: "room-personal",
  label: "Personal",
};
const TEAM: EnvironmentDescriptor = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-team",
  label: "Acme",
};

interface TeamFacts {
  readonly providerHandle: string;
  readonly effectiveRole: "admin" | "editor" | null;
}

function factsWith(
  team: (environment: EnvironmentDescriptor) => Promise<TeamFacts>,
  failures: string[],
): ConfigurationListFacts {
  return {
    hosts: () => Promise.resolve([{ purgePending: false }]),
    team,
    rowFailed: (environmentId, facts) => {
      failures.push(`${environmentId}:${facts}`);
    },
  };
}

describe("enrichConfigurationList with a retired team seat", () => {
  it("leaves out a team whose role was read and authorizes nothing", async () => {
    const failures: string[] = [];
    const rows = await enrichConfigurationList(
      [PERSONAL, TEAM],
      factsWith(
        () => Promise.resolve({ providerHandle: "acme", effectiveRole: null }),
        failures,
      ),
    );

    expect(rows.map((row) => row.environmentId)).toEqual(["env-personal"]);
    expect(failures).toEqual([]);
  });

  it("still lists a team whose role read failed, degraded to no authority and no provider handle", async () => {
    const failures: string[] = [];
    const rows = await enrichConfigurationList(
      [PERSONAL, TEAM],
      factsWith(
        () => Promise.reject(new Error("members unavailable")),
        failures,
      ),
    );

    expect(rows.map((row) => row.environmentId)).toEqual([
      "env-personal",
      "env-team",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "team",
      effectiveRole: WIRE_ROLE_NO_AUTHORITY,
      providerHandle: null,
      hostCount: 1,
    });
    expect(failures).toEqual(["env-team:team"]);
  });

  it("lists a team whose role grants authority as itself", async () => {
    const rows = await enrichConfigurationList(
      [TEAM],
      factsWith(
        () =>
          Promise.resolve({ providerHandle: "acme", effectiveRole: "editor" }),
        [],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      effectiveRole: "editor",
      providerHandle: "acme",
    });
  });
});
