import { describe, expect, it, vi } from "vitest";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { readConfigurationMembers } from "../configuration-members";
import type {
  EnvironmentCloud,
  EnvironmentTransportRequest,
} from "../environment-cloud";
import { readEnvironmentList } from "../environment-list";

const TEAM_ENVIRONMENT: EnvironmentDescriptor = {
  environmentId: "env-acme",
  ownerKind: "organization",
  ownerId: "team-acme",
  roomId: "room-acme",
  label: "acme",
};

/** authn at the transport: each path answers the body given for it. */
function cloudAnswering(bodies: Readonly<Record<string, unknown>>): {
  readonly cloud: EnvironmentCloud;
  readonly requested: string[];
} {
  const requested: string[] = [];
  const cloud: EnvironmentCloud = {
    authnBaseUrl: "https://authn.test",
    bearer: { kind: "cloud", getBearerToken: () => "bearer" },
    onOriginSignIn: () => true,
    transport: async (request: EnvironmentTransportRequest) => {
      const path = new URL(request.url).pathname.replace(/^\//u, "");
      requested.push(path);
      if (!Object.hasOwn(bodies, path)) return { status: 404, text: "{}" };
      return { status: 200, text: JSON.stringify(bodies[path]) };
    },
  };
  return { cloud, requested };
}

/** authn's members answer: the one member's role and the reader's own. */
function membersAnswerOf(memberRole: unknown, readerRole: unknown): unknown {
  return {
    members: [
      {
        id: "member-1",
        email: "",
        user: { id: "user-1", name: "Rae", avatarUrl: null },
        effectiveRole: memberRole,
        linkedPlan: false,
        inviteState: "accepted",
        invitedAddress: null,
      },
    ],
    viewer: {
      effectiveRole: readerRole,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    },
  };
}

function membersAnswer(role: unknown): unknown {
  return membersAnswerOf(role, role);
}

const MEMBERS_PATH = "api/v3/environments/env-acme/members";
const HOSTS_PATH = "api/v3/environments/env-acme/hosts";

describe("a team role is Admin, Editor or Viewer", () => {
  it("parses a members answer naming a viewer, row and reader alike", async () => {
    const { cloud } = cloudAnswering({
      [MEMBERS_PATH]: membersAnswer("viewer"),
    });
    const page = await readConfigurationMembers(cloud, "env-acme", null, null);
    expect(page.members.map((member) => member.effectiveRole)).toEqual([
      "viewer",
    ]);
  });

  it("lists a viewer's team row with its provider handle", async () => {
    const { cloud } = cloudAnswering({
      [HOSTS_PATH]: { hosts: [] },
      [MEMBERS_PATH]: { viewer: { effectiveRole: "viewer" } },
    });
    const rowFailed = vi.fn();
    const [row] = await readEnvironmentList(
      cloud,
      [TEAM_ENVIRONMENT],
      [{ id: "team-acme", slug: "acme" }],
      rowFailed,
    );
    expect(row).toMatchObject({
      kind: "team",
      effectiveRole: "viewer",
      providerHandle: "acme",
    });
    expect(rowFailed).not.toHaveBeenCalled();
  });

  // authn answers `null` for a seat stored on the retired Viewer role, on that
  // member's row and on the reader's own.
  it("reads a member stored on the Viewer role as a viewer, and the page still parses", async () => {
    const { cloud } = cloudAnswering({
      [MEMBERS_PATH]: membersAnswerOf(null, "admin"),
    });
    const page = await readConfigurationMembers(cloud, "env-acme", null, null);
    expect(page.members.map((member) => member.effectiveRole)).toEqual([
      "viewer",
    ]);
  });

  it("parses a members answer whose reader is stored on the Viewer role", async () => {
    const { cloud } = cloudAnswering({
      [MEMBERS_PATH]: membersAnswerOf("editor", null),
    });
    const page = await readConfigurationMembers(cloud, "env-acme", null, null);
    expect(page.members.map((member) => member.effectiveRole)).toEqual([
      "editor",
    ]);
  });

  it("lists a team row whose reader is stored on the Viewer role as a viewer with its provider handle", async () => {
    const { cloud } = cloudAnswering({
      [HOSTS_PATH]: { hosts: [] },
      [MEMBERS_PATH]: { viewer: { effectiveRole: null } },
    });
    const rowFailed = vi.fn();
    const [row] = await readEnvironmentList(
      cloud,
      [TEAM_ENVIRONMENT],
      [{ id: "team-acme", slug: "acme" }],
      rowFailed,
    );
    expect(row).toMatchObject({
      kind: "team",
      effectiveRole: "viewer",
      providerHandle: "acme",
    });
    expect(rowFailed).not.toHaveBeenCalled();
  });

  it("refuses a members answer naming a role it does not know", async () => {
    const { cloud } = cloudAnswering({
      [MEMBERS_PATH]: membersAnswer("guest"),
    });
    await expect(
      readConfigurationMembers(cloud, "env-acme", null, null),
    ).rejects.toMatchObject({ name: "EnvironmentCloudError" });
  });

  it("lists a team row whose role it does not know without its handle", async () => {
    const { cloud } = cloudAnswering({
      [HOSTS_PATH]: { hosts: [] },
      [MEMBERS_PATH]: { viewer: { effectiveRole: "guest" } },
    });
    const rowFailed = vi.fn();
    const [row] = await readEnvironmentList(
      cloud,
      [TEAM_ENVIRONMENT],
      [{ id: "team-acme", slug: "acme" }],
      rowFailed,
    );
    expect(row).toMatchObject({ providerHandle: null });
    expect(rowFailed).toHaveBeenCalledWith(
      "env-acme",
      "team",
      expect.anything(),
    );
  });
});
