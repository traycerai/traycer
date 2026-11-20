// The members methods answered by authn directly, in the shapes the host's
// forwarder answered. `removePreview`'s running work is counted by a computer.
import { z } from "zod";
import type {
  EnvironmentMembersInviteRequest,
  EnvironmentMembersInviteResponse,
  EnvironmentMembersNoticeSeenResponse,
  EnvironmentMembersRemoveRequest,
  EnvironmentMembersRemoveResponse,
  EnvironmentMembersResponseV12,
  EnvironmentMembersSeatsResponse,
  EnvironmentMembersSetRoleRequest,
  EnvironmentMembersSetRoleResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  environmentPath,
  errorBodyCode,
  isSuccess,
  parseSettings,
  sendSettings,
  settingsRefusal,
  type EnvironmentAnswer,
  type EnvironmentCloud,
} from "./environment-cloud";
import { authnMemberRoleSchema } from "./authn-environment-schemas";

const MEMBERS_PAGE_SIZE = 100;

const teamMembersSchema = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      /** "" on a row authn blanked for this reader. */
      email: z.string(),
      user: z
        .object({
          id: z.string(),
          name: z.string().nullable(),
          avatarUrl: z.string().nullable(),
        })
        .nullable(),
      effectiveRole: authnMemberRoleSchema,
      linkedPlan: z.boolean(),
      inviteState: z.enum(["pending", "accepted"]),
      invitedAddress: z.string().nullable(),
    }),
  ),
  viewer: z.object({
    effectiveRole: authnMemberRoleSchema,
    legacyRoleNoticeSeenAt: z.string().nullable(),
    legacyMembers: z.array(z.string()),
  }),
});
type TeamMembers = z.infer<typeof teamMembersSchema>;

const seatsSchema = z.object({
  seats: z
    .object({
      used: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
});

const seatSaveSchema = z.object({ receiptId: z.string().nullable() });

const noticeSeenSchema = z.object({ legacyRoleNoticeSeenAt: z.string() });

interface ConfigurationReader {
  readonly userId: string;
  readonly displayName: string;
}

function membersPath(environmentId: string): string {
  return `${environmentPath(environmentId)}/members`;
}

/** A member without a name still has display text, never an identifier. */
function memberDisplayName(name: string | null | undefined): string {
  return name?.trim() || "Member";
}

async function readTeamMembers(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<TeamMembers> {
  return parseSettings(
    await sendSettings(cloud, "GET", membersPath(environmentId), null),
    teamMembersSchema,
  );
}

/** Read fresh at the write: never a row read earlier. */
async function targetMember(
  cloud: EnvironmentCloud,
  environmentId: string,
  userId: string,
): Promise<TeamMembers["members"][number]> {
  const page = await readTeamMembers(cloud, environmentId);
  const member = page.members.find(
    (row) => row.user?.id === userId || row.id === userId,
  );
  if (member === undefined) {
    throw new EnvironmentCloudError("invalid", "This member is unavailable.");
  }
  return member;
}

function subscriptionMissing(answer: EnvironmentAnswer): boolean {
  if (answer.status !== 404) return false;
  if (errorBodyCode(answer.body) === "subscription_not_found") return true;
  const body: unknown = answer.body;
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "Subscription not found"
  );
}

function roleRefusal(
  answer: EnvironmentAnswer,
): "last_admin" | "forbidden" | null {
  if (answer.status === 403) return "forbidden";
  const code = errorBodyCode(answer.body);
  if (code === "last_admin") return "last_admin";
  // A retired role never becomes an editor implicitly at this boundary.
  if (code === "role_retired") return "forbidden";
  return null;
}

/** Personal lists the reader alone and asks authn nothing. */
export async function readConfigurationMembers(
  cloud: EnvironmentCloud,
  environmentId: string,
  cursor: string | null,
  personal: ConfigurationReader | null,
): Promise<EnvironmentMembersResponseV12> {
  if (personal !== null) {
    return {
      members: [
        {
          userId: personal.userId,
          displayName: memberDisplayName(personal.displayName),
          avatarUrl: null,
          effectiveRole: "admin",
          linkedPlan: false,
          inviteState: null,
          invitedAddress: null,
          email: null,
        },
      ],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    };
  }
  const page = await readTeamMembers(cloud, environmentId);
  const isAdmin = page.viewer.effectiveRole === "admin";
  const rows = page.members
    .map((row) => {
      const pending = row.inviteState === "pending";
      return {
        userId: row.user?.id ?? row.id,
        displayName: pending ? null : memberDisplayName(row.user?.name),
        avatarUrl: pending ? null : (row.user?.avatarUrl ?? null),
        effectiveRole: row.effectiveRole,
        linkedPlan: row.linkedPlan,
        inviteState: row.inviteState,
        invitedAddress:
          isAdmin && pending ? row.invitedAddress?.trim() || null : null,
        // authn's scoping for this reader: passed through, never widened.
        email: row.email.length === 0 ? null : row.email,
      };
    })
    .sort((a, b) => {
      if (a.userId === b.userId) return 0;
      return a.userId < b.userId ? -1 : 1;
    });
  const remaining = rows.filter(
    (row) => cursor === null || row.userId > cursor,
  );
  const members = remaining.slice(0, MEMBERS_PAGE_SIZE);
  return {
    members,
    nextCursor:
      remaining.length > members.length
        ? (members.at(-1)?.userId ?? null)
        : null,
    legacyRoleNoticeSeenAt:
      isAdmin && page.viewer.legacyRoleNoticeSeenAt !== null
        ? Date.parse(page.viewer.legacyRoleNoticeSeenAt)
        : null,
    legacyMembers: isAdmin ? page.viewer.legacyMembers : [],
  };
}

/** A read that fails refuses: null means a team on no paid plan. */
export async function readConfigurationSeats(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentMembersSeatsResponse> {
  return {
    seats: parseSettings(
      await sendSettings(
        cloud,
        "GET",
        `${membersPath(environmentId)}/seats`,
        null,
      ),
      seatsSchema,
    ).seats,
  };
}

async function invitedSeatDelta(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentMembersSeatsResponse["seats"]> {
  try {
    return (await readConfigurationSeats(cloud, environmentId)).seats;
  } catch {
    // The invitation already went out: a missing count must not ask to send it twice.
    return null;
  }
}

export async function inviteConfigurationMember(
  cloud: EnvironmentCloud,
  request: EnvironmentMembersInviteRequest,
): Promise<EnvironmentMembersInviteResponse> {
  const answer = await sendSettings(
    cloud,
    "POST",
    membersPath(request.environmentId),
    { members: [{ email: request.email, role: request.role.toUpperCase() }] },
  );
  if (answer.status === 403 || errorBodyCode(answer.body) === "role_retired")
    return { outcome: "forbidden" };
  if (errorBodyCode(answer.body) === "seat_limit")
    return { outcome: "seat_limit" };
  if (!isSuccess(answer)) throw settingsRefusal(answer);
  return {
    outcome: "sent",
    seatDelta: await invitedSeatDelta(cloud, request.environmentId),
  };
}

export async function setConfigurationMemberRole(
  cloud: EnvironmentCloud,
  request: EnvironmentMembersSetRoleRequest,
): Promise<EnvironmentMembersSetRoleResponse> {
  const member = await targetMember(
    cloud,
    request.environmentId,
    request.userId,
  );
  const answer = await sendSettings(
    cloud,
    "POST",
    `${membersPath(request.environmentId)}/seats`,
    { members: [{ id: member.id, role: request.role.toUpperCase() }] },
  );
  const refusal = roleRefusal(answer);
  if (refusal !== null) return { outcome: refusal };
  if (subscriptionMissing(answer)) return { outcome: "plan_required" };
  if (!isSuccess(answer)) throw settingsRefusal(answer);
  return { outcome: "changed" };
}

export async function removeConfigurationMember(
  cloud: EnvironmentCloud,
  request: EnvironmentMembersRemoveRequest,
): Promise<EnvironmentMembersRemoveResponse> {
  const member = await targetMember(
    cloud,
    request.environmentId,
    request.userId,
  );
  const answer = await sendSettings(
    cloud,
    "POST",
    `${membersPath(request.environmentId)}/seats`,
    { members: [{ id: member.id, remove: true }] },
  );
  const refusal = roleRefusal(answer);
  if (refusal !== null) return { outcome: refusal };
  if (subscriptionMissing(answer)) return { outcome: "plan_required" };
  const { receiptId } = parseSettings(answer, seatSaveSchema);
  if (receiptId !== null) return { outcome: "pending", receiptId };
  if (member.inviteState === "pending") return { outcome: "revoked" };
  throw new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
}

const removalPreviewSchema = z.object({
  sandboxesToRekey: z.number().int().nonnegative(),
});

export interface ConfigurationRemovalPreview {
  readonly sandboxesToRekey: number;
}

/** The member's seat is read fresh, as a removal names it at the write. */
export async function readConfigurationRemovalPreview(
  cloud: EnvironmentCloud,
  environmentId: string,
  userId: string,
): Promise<ConfigurationRemovalPreview> {
  const member = await targetMember(cloud, environmentId, userId);
  const { sandboxesToRekey } = parseSettings(
    await sendSettings(
      cloud,
      "POST",
      `${membersPath(environmentId)}/removal-preview`,
      { memberIds: [member.id] },
    ),
    removalPreviewSchema,
  );
  return { sandboxesToRekey };
}

export async function recordConfigurationNoticeSeen(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentMembersNoticeSeenResponse> {
  parseSettings(
    await sendSettings(
      cloud,
      "POST",
      `${membersPath(environmentId)}/notice-seen`,
      {},
    ),
    noticeSeenSchema,
  );
  return { outcome: "recorded" };
}
