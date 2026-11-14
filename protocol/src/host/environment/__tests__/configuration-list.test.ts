import { describe, expect, it } from "vitest";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import {
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

function teamEnvironment(
  environmentId: string,
  ownerId: string,
  roomId: string,
  label: string,
): EnvironmentDescriptor {
  return { environmentId, ownerKind: "organization", ownerId, roomId, label };
}

const ADMIN = teamEnvironment(
  "env-admin",
  "team-admin",
  "room-admin",
  "Admin team",
);
const EDITOR = teamEnvironment(
  "env-editor",
  "team-editor",
  "room-editor",
  "Editor team",
);
const VIEWER = teamEnvironment(
  "env-viewer",
  "team-viewer",
  "room-viewer",
  "Viewer team",
);
const FAILED = teamEnvironment(
  "env-failed",
  "team-failed",
  "room-failed",
  "Failed team",
);

type TeamFacts = {
  readonly providerHandle: string;
  readonly effectiveRole: "admin" | "editor" | "viewer";
};

function factsWith(
  team: (environment: EnvironmentDescriptor) => Promise<TeamFacts>,
  failures: string[],
  hosts: (
    environmentId: string,
  ) => readonly { readonly purgePending: boolean }[],
): ConfigurationListFacts {
  return {
    hosts: (environmentId) => Promise.resolve(hosts(environmentId)),
    team,
    rowFailed: (environmentId, facts) => {
      failures.push(`${environmentId}:${facts}`);
    },
  };
}

describe("enrichConfigurationList", () => {
  it("lists Personal and each team with its own role and excludes purge-pending hosts", async () => {
    const failures: string[] = [];
    const roleByEnvironment: Record<string, TeamFacts> = {
      [ADMIN.environmentId]: {
        providerHandle: "acme-admin",
        effectiveRole: "admin",
      },
      [EDITOR.environmentId]: {
        providerHandle: "acme-editor",
        effectiveRole: "editor",
      },
      [VIEWER.environmentId]: {
        providerHandle: "acme-viewer",
        effectiveRole: "viewer",
      },
    };
    const rows = await enrichConfigurationList(
      [PERSONAL, ADMIN, EDITOR, VIEWER],
      factsWith(
        (environment) => {
          const teamFacts = roleByEnvironment[environment.environmentId];
          return teamFacts
            ? Promise.resolve(teamFacts)
            : Promise.reject(new Error("unexpected team environment"));
        },
        failures,
        () => [{ purgePending: false }, { purgePending: true }],
      ),
    );

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      environmentId: "env-personal",
      kind: "personal",
      effectiveRole: "owner",
      providerHandle: null,
      hostCount: 1,
    });
    expect(rows[1]).toMatchObject({
      environmentId: "env-admin",
      kind: "team",
      effectiveRole: "admin",
      providerHandle: "acme-admin",
      hostCount: 1,
    });
    expect(rows[2]).toMatchObject({
      environmentId: "env-editor",
      kind: "team",
      effectiveRole: "editor",
      providerHandle: "acme-editor",
      hostCount: 1,
    });
    expect(rows[3]).toMatchObject({
      environmentId: "env-viewer",
      kind: "team",
      effectiveRole: "viewer",
      providerHandle: "acme-viewer",
      hostCount: 1,
    });
    expect(failures).toEqual([]);
  });

  it("lists a team as viewer without a provider handle when its role read fails", async () => {
    const failures: string[] = [];
    const rows = await enrichConfigurationList(
      [PERSONAL, FAILED],
      factsWith(
        () => Promise.reject(new Error("members unavailable")),
        failures,
        () => [{ purgePending: false }],
      ),
    );

    expect(rows.map((row) => row.environmentId)).toEqual([
      "env-personal",
      "env-failed",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "team",
      effectiveRole: "viewer",
      providerHandle: null,
      hostCount: 1,
    });
    expect(failures).toEqual(["env-failed:team"]);
  });
});
