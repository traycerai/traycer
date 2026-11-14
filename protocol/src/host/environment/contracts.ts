/**
 * `environment.list` - the personal environment, then every team environment
 * the signed-in user belongs to.
 * `environment.host.read` / `environment.host.bind` - this host's binding
 * and its compatibility acknowledgement.
 * `environment.host.list` - the hosts of an environment the caller may see.
 * `environment.members` - the people in an environment, by name and avatar,
 * so a client can name the member who wrote a message.
 * `environment.setMainBot` - which of an environment's bots is its main bot.
 * `environment.members.invite` / `.setRole` / `.remove` / `.removePreview` /
 * `.noticeSeen` - an admin's member management, and the legacy-role notice.
 * `environment.members.seats` - the team's seats, read before an invite.
 * `environment.invitations.list` / `.accept` - the teams waiting for the
 * signed-in person's Accept, and accepting one.
 *
 * `@1.1` of `environment.list`, `environment.host.list` and
 * `environment.members` adds the fields described below, with upgrades from
 * `@1.0`. `@1.2` of `environment.host.list` adds each host's `hasLocalRow`.
 *
 * An environment is the cloud container a team shares: skills, the shared
 * notes block, the agent selection guide and the bot list, all held in one
 * collab room. A team is an authn organization. The user belongs to one
 * environment per team they are in, plus their personal environment, and sees
 * them side by side; there is no "current" one. The cloud lists and creates
 * them; the host proxies the list.
 *
 * OPTIONAL capability. Never in `RELEASED_FLOOR_METHOD_NAMES`: the floor is
 * fail-closed on the method-name union, so a name present on only one peer
 * would make the whole connection incompatible. Registered with
 * `degrade: { kind: "unsupported" }`, so a host that predates environments
 * reports the method unsupported instead of failing the handshake.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { botIdSchema } from "@traycer/protocol/host/bot/schemas";

/**
 * Who owns an environment: an authn organization (team), or a single user.
 */
export const environmentOwnerKindSchema = lazySchema(() =>
  z.enum(["organization", "user"]),
);
export type EnvironmentOwnerKind = z.infer<typeof environmentOwnerKindSchema>;

/**
 * One environment the user belongs to. `ownerId` is the team id for an
 * organization environment and the user's own id for the personal one.
 * `label` is what to call it: the team's handle, or "Personal". `roomId`
 * names its collab room, which the host opens, never a client.
 */
export const environmentDescriptorSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    ownerKind: environmentOwnerKindSchema,
    ownerId: z.string().min(1),
    roomId: z.string().min(1),
    label: z.string(),
  }),
);
export type EnvironmentDescriptor = z.infer<typeof environmentDescriptorSchema>;

export const environmentListRequestSchema = lazySchema(() => z.object({}));
export type EnvironmentListRequest = z.infer<
  typeof environmentListRequestSchema
>;

/**
 * The personal environment first, then one per team. A member of an object
 * root, never a bare array root, so the response can grow additively.
 */
export const environmentListResponseSchema = lazySchema(() =>
  z.object({
    environments: z.array(environmentDescriptorSchema),
  }),
);
export type EnvironmentListResponse = z.infer<
  typeof environmentListResponseSchema
>;

export const environmentListV10 = defineRpcContract({
  method: "environment.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentListRequestSchema,
  responseSchema: environmentListResponseSchema,
});

/**
 * The caller's effective role in an environment as it DECODES; `owner` is a
 * personal one's.
 *
 * `viewer` is retired as a role anybody holds. It stays in this released
 * vocabulary because the `@1.0 → @1.1` upgrade below has to name a value for
 * an answer that names no role at all, and because a current client still
 * reads environments from hosts that predate the retirement. Both are
 * "no authority known", never read-only authority: resolve this value with
 * {@link grantedEnvironmentRole} before gating anything on it.
 */
export const environmentEffectiveRoleSchema = lazySchema(() =>
  z.enum(["owner", "admin", "editor", "viewer"]),
);
export type EnvironmentEffectiveRole = z.infer<
  typeof environmentEffectiveRoleSchema
>;

/** An environment role somebody HOLDS. */
export type GrantedEnvironmentRole = "owner" | "admin" | "editor";

/**
 * A decoded environment role as authority: the retired role and an unknown
 * one are both `null`, which every caller reads as none.
 */
export function grantedEnvironmentRole(
  role: string,
): GrantedEnvironmentRole | null {
  switch (role) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "editor":
      return "editor";
    default:
      return null;
  }
}

/**
 * `environment.list@1.1`: each environment with the caller's `effectiveRole`,
 * whether it is the `personal` one or a `team`'s, how many hosts run it, and
 * `providerHandle`, the organization's route key for a team (null for
 * Personal).
 */
export const environmentDescriptorSchemaV11 = lazySchema(() =>
  environmentDescriptorSchema.extend({
    effectiveRole: environmentEffectiveRoleSchema,
    kind: z.enum(["personal", "team"]),
    hostCount: z.number().int().nonnegative(),
    providerHandle: z.string().min(1).nullable(),
  }),
);
export type EnvironmentDescriptorV11 = z.infer<
  typeof environmentDescriptorSchemaV11
>;

export const environmentListResponseSchemaV11 = lazySchema(() =>
  z.object({
    environments: z.array(environmentDescriptorSchemaV11),
  }),
);
export type EnvironmentListResponseV11 = z.infer<
  typeof environmentListResponseSchemaV11
>;

export const environmentListV11 = defineRpcContract({
  method: "environment.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentListRequestSchema,
  responseSchema: environmentListResponseSchemaV11,
});

/**
 * A `@1.0` answer names no role, kind or count. It upgrades from what it does
 * say: the user-owned environment is the caller's personal one, which they
 * own; a team's role is unknown, so it reads as the retired `viewer`, which
 * {@link grantedEnvironmentRole} resolves to no authority, and its host count
 * as none, which a client re-reads rather than acts on. The unknown role must
 * stay this value: naming a live role here would hand an old host's answer
 * authority nobody granted.
 */
export const environmentListUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentListV10,
  typeof environmentListV11
>({
  from: environmentListV10.schemaVersion,
  to: environmentListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    environments: response.environments.map((environment) => ({
      ...environment,
      effectiveRole:
        environment.ownerKind === "user"
          ? ("owner" as const)
          : ("viewer" as const),
      kind:
        environment.ownerKind === "user"
          ? ("personal" as const)
          : ("team" as const),
      hostCount: 0,
      providerHandle: null,
    })),
  }),
});

/**
 * The host's team binding, as the signed-in user sees it. `explicit` is false
 * for both an absent environment binding and an explicit Personal binding;
 * both carry the Personal descriptor, because `environment` is non-null.
 * This read cannot distinguish a computer's own settings from Personal.
 * That settings place is answered by `environment.status` on the host.
 *
 * `enrolledByUserId` is the enrollment attribution recorded by authn for a
 * bound host, including Personal; null when the host is unbound or
 * attribution is unknown. Read and bind answer that same fact. `canUnbind`
 * is true only when this result is explicit, the stored enroller is the
 * caller, and the host is a computer rather than a sandbox; a sandbox cannot
 * be unbound.
 */
export const environmentHostBindingSchema = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
    environment: environmentDescriptorSchema,
    explicit: z.boolean(),
    enrolledByUserId: z.string().min(1).nullable(),
    canUnbind: z.boolean(),
  }),
);
export type EnvironmentHostBinding = z.infer<
  typeof environmentHostBindingSchema
>;

export const environmentHostReadRequestSchema = lazySchema(() => z.object({}));
export type EnvironmentHostReadRequest = z.infer<
  typeof environmentHostReadRequestSchema
>;

export const environmentHostReadV10 = defineRpcContract({
  method: "environment.host.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHostReadRequestSchema,
  responseSchema: environmentHostBindingSchema,
});

/**
 * The sharing arrangement reported by this host. Null means the host cannot
 * report the generation, including an answer upgraded from `@1.0`.
 * The frozen binding schema also serves methods that have not gained it.
 */
export const environmentHostReadResponseSchemaV11 = lazySchema(() =>
  environmentHostBindingSchema.extend({
    sharingGeneration: z.number().int().nonnegative().nullable(),
  }),
);
export type EnvironmentHostReadResponseV11 = z.infer<
  typeof environmentHostReadResponseSchemaV11
>;

export const environmentHostReadV11 = defineRpcContract({
  method: "environment.host.read",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentHostReadRequestSchema,
  responseSchema: environmentHostReadResponseSchemaV11,
});

export const environmentHostReadUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentHostReadV10,
  typeof environmentHostReadV11
>({
  from: environmentHostReadV10.schemaVersion,
  to: environmentHostReadV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, sharingGeneration: null }),
});

/**
 * The environment the named host is bound to, as the signed-in user sees it:
 * the same answer `environment.host.read` gives on that host, read from
 * authn's host directory instead of asking the host. Served by the server
 * pool, so a list of hosts reads every row's binding without a connection to
 * each host. An absent binding and an explicit Personal binding both answer
 * the Personal descriptor with `explicit` false. This answers which team, if
 * any, is bound to the host; only `environment.status` can answer whether a
 * computer runs its own settings or Personal.
 */
export const environmentBindingReadRequestSchema = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
  }),
);
export type EnvironmentBindingReadRequest = z.infer<
  typeof environmentBindingReadRequestSchema
>;

export const environmentBindingReadV10 = defineRpcContract({
  method: "environment.binding.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentBindingReadRequestSchema,
  responseSchema: environmentHostBindingSchema,
});

/**
 * Compatibility request for the serving host's binding. The response reports
 * the binding recorded by authn, as `environment.host.read` does;
 * acknowledgement alone establishes no binding and changes no enrollment
 * attribution.
 *
 * A Personal binding is reported with `explicit` false, the same answer as
 * an absent environment binding; it does not mean the host runs its own
 * settings. Read `environment.status` for that distinction.
 */
export const environmentHostBindRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
  }),
);
export type EnvironmentHostBindRequest = z.infer<
  typeof environmentHostBindRequestSchema
>;

export const environmentHostBindV10 = defineRpcContract({
  method: "environment.host.bind",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHostBindRequestSchema,
  responseSchema: environmentHostBindingSchema,
});

/** Advertises team-target transfer; new hosts serve both minors through one handler. */
export const environmentHostBindV11 = defineRpcContract({
  method: "environment.host.bind",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentHostBindRequestSchema,
  responseSchema: environmentHostBindingSchema,
});

export const environmentHostBindUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentHostBindV10,
  typeof environmentHostBindV11
>({
  from: environmentHostBindV10.schemaVersion,
  to: environmentHostBindV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const environmentHostListRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
  }),
);
export type EnvironmentHostListRequest = z.infer<
  typeof environmentHostListRequestSchema
>;

/**
 * The frozen @1.0 host row. `hostLabel` and `hostPlatform` are the registry's
 * reported metadata; `kind` is its machine kind. `enrolledByUserId` is stored
 * enrollment attribution, independent of the environment's owner.
 * `boundAt` is epoch milliseconds on a released row, not a canonical binding
 * time. This version requires attribution and time as values; a row missing
 * attribution or time is omitted.
 */
export const environmentHostRecordSchema = lazySchema(() =>
  z.object({
    hostId: z.string().min(1),
    hostLabel: z.string().nullable(),
    hostPlatform: z.string().nullable(),
    enrolledByUserId: z.string().min(1),
    kind: z.enum(["personal", "sandbox"]),
    boundAt: z.number().int(),
  }),
);
export type EnvironmentHostRecord = z.infer<typeof environmentHostRecordSchema>;

/**
 * The environment's hosts visible to the caller, in an object root. Personal
 * lists its bound hosts like any other environment; an absent binding is not
 * Personal membership. The frozen @1.0 representation omits rows without
 * attribution or a binding time. Authn records no canonical binding time,
 * so this projection is empty even when authn lists bound hosts.
 */
export const environmentHostListResponseSchema = lazySchema(() =>
  z.object({
    hosts: z.array(environmentHostRecordSchema),
  }),
);
export type EnvironmentHostListResponse = z.infer<
  typeof environmentHostListResponseSchema
>;

/**
 * Lists the hosts of an environment the caller may see. Refused
 * for an environment the caller does not belong to, and for one that does
 * not exist.
 */
export const environmentHostListV10 = defineRpcContract({
  method: "environment.host.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHostListRequestSchema,
  responseSchema: environmentHostListResponseSchema,
});

/**
 * How one host took one item of the configuration: `received` it, `applied`
 * it, `not_applied` with the `reason` code, or `waiting_resume` until a
 * stopped sandbox resumes. `reason` is null unless `not_applied`.
 * `itemKey` is `${kind}:${key}`, split at the first colon: the remainder is
 * the item's key untouched, with no OS segment.
 */
export const environmentHostItemApplySchema = lazySchema(() =>
  z.object({
    itemKey: z.string().min(1),
    state: z.enum(["received", "applied", "not_applied", "waiting_resume"]),
    reason: z.string().min(1).max(64).nullable(),
    at: z.number().int().nonnegative(),
  }),
);
export type EnvironmentHostItemApply = z.infer<
  typeof environmentHostItemApplySchema
>;

/**
 * `environment.host.list@1.1`: each host with whether it is `reachable` now,
 * when it last reported (null before it ever did), and its per-item apply
 * states. `boundAt` is null: authn records no canonical binding time.
 * `enrolledByUserId` is null where attribution is unknown. `@1.0` has no
 * null for either, so a `@1.0` answer omits such a row.
 */
export const environmentHostRecordSchemaV11 = lazySchema(() =>
  environmentHostRecordSchema.extend({
    enrolledByUserId: z.string().min(1).nullable(),
    boundAt: z.number().int().nullable(),
    reachable: z.boolean(),
    lastReportedAt: z.number().int().nonnegative().nullable(),
    applied: z.array(environmentHostItemApplySchema),
  }),
);
export type EnvironmentHostRecordV11 = z.infer<
  typeof environmentHostRecordSchemaV11
>;

export const environmentHostListResponseSchemaV11 = lazySchema(() =>
  z.object({
    hosts: z.array(environmentHostRecordSchemaV11),
  }),
);
export type EnvironmentHostListResponseV11 = z.infer<
  typeof environmentHostListResponseSchemaV11
>;

export const environmentHostListV11 = defineRpcContract({
  method: "environment.host.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentHostListRequestSchema,
  responseSchema: environmentHostListResponseSchemaV11,
});

/**
 * A `@1.0` answer says nothing of reach or reports: each host upgrades as not
 * known to be reachable, never reported, with no apply states.
 */
export const environmentHostListUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentHostListV10,
  typeof environmentHostListV11
>({
  from: environmentHostListV10.schemaVersion,
  to: environmentHostListV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    hosts: response.hosts.map((host) => ({
      ...host,
      reachable: false,
      lastReportedAt: null,
      applied: [],
    })),
  }),
});

/**
 * `environment.host.list@1.2`: each host with `hasLocalRow`, whether it last
 * reported that its own settings are not all in the configuration yet (any
 * plane still its own: never moved, partly moved, or stopped). A client
 * leaves such a host out of the hosts running the configuration. Null when
 * the host has not said: it predates the field, or it has never reported.
 */
export const environmentHostRecordSchemaV12 = lazySchema(() =>
  environmentHostRecordSchemaV11.extend({
    hasLocalRow: z.boolean().nullable(),
  }),
);
export type EnvironmentHostRecordV12 = z.infer<
  typeof environmentHostRecordSchemaV12
>;

export const environmentHostListResponseSchemaV12 = lazySchema(() =>
  z.object({
    hosts: z.array(environmentHostRecordSchemaV12),
  }),
);
export type EnvironmentHostListResponseV12 = z.infer<
  typeof environmentHostListResponseSchemaV12
>;

export const environmentHostListV12 = defineRpcContract({
  method: "environment.host.list",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentHostListRequestSchema,
  responseSchema: environmentHostListResponseSchemaV12,
});

/** A `@1.1` answer says nothing of a Local row: each host upgrades as not said. */
export const environmentHostListUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentHostListV11,
  typeof environmentHostListV12
>({
  from: environmentHostListV11.schemaVersion,
  to: environmentHostListV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    hosts: response.hosts.map((host) => ({ ...host, hasLocalRow: null })),
  }),
});

export const environmentMembersRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    /** `nextCursor` of the previous page; null for the first page. */
    cursor: z.string().min(1).nullable(),
  }),
);
export type EnvironmentMembersRequest = z.infer<
  typeof environmentMembersRequestSchema
>;

/**
 * One person in an environment: a member of the owning team, or the person
 * a personal environment belongs to. `displayName` is what to call them,
 * null when they have set neither a name nor a handle; `avatarUrl` is null
 * when they have no picture. No email before `@1.2`
 * ({@link environmentMemberSchemaV12}).
 */
export const environmentMemberSchema = lazySchema(() =>
  z.object({
    userId: z.string().min(1),
    displayName: z.string().min(1).nullable(),
    avatarUrl: z.string().nullable(),
  }),
);
export type EnvironmentMember = z.infer<typeof environmentMemberSchema>;

/**
 * One page of an environment's members, ordered by user id. `nextCursor` is
 * the cursor of the next page, null on the last one. A member of an object
 * root so the response can grow additively.
 */
export const environmentMembersResponseSchema = lazySchema(() =>
  z.object({
    members: z.array(environmentMemberSchema),
    nextCursor: z.string().min(1).nullable(),
  }),
);
export type EnvironmentMembersResponse = z.infer<
  typeof environmentMembersResponseSchema
>;

/**
 * Lists an environment's members to a member of it. Refused for an
 * environment the caller does not belong to exactly as for one that does not
 * exist.
 */
export const environmentMembersV10 = defineRpcContract({
  method: "environment.members",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersRequestSchema,
  responseSchema: environmentMembersResponseSchema,
});

/**
 * A team member's role as it DECODES. `viewer` is retired as a role anybody
 * holds; it stays here for the same two reasons the environment's own role
 * keeps it - the `@1.0 → @1.1` upgrade has to name a value for a page that
 * names none, and a current client still reads members from hosts that
 * predate the retirement. Resolve it with {@link grantedTeamMemberRole}.
 */
export const environmentMemberRoleSchema = lazySchema(() =>
  z.enum(["admin", "editor", "viewer"]),
);
export type EnvironmentMemberRole = z.infer<typeof environmentMemberRoleSchema>;

/** A team-member role somebody HOLDS. */
export type GrantedTeamMemberRole = "admin" | "editor";

/**
 * A decoded team-member role as authority: the retired role and an unknown
 * one are both `null` - no seat authority, and never read-only authority.
 */
export function grantedTeamMemberRole(
  role: string,
): GrantedTeamMemberRole | null {
  switch (role) {
    case "admin":
      return "admin";
    case "editor":
      return "editor";
    default:
      return null;
  }
}

/**
 * `environment.members@1.1`'s member: `@1.0`'s plus their `effectiveRole`,
 * whether they linked a plan, the state of their invitation (null for a
 * member who was never invited), and the address it went to, which only an
 * admin reads (null for anyone else).
 */
export const environmentMemberSchemaV11 = lazySchema(() =>
  environmentMemberSchema.extend({
    effectiveRole: environmentMemberRoleSchema,
    linkedPlan: z.boolean(),
    inviteState: z.enum(["accepted", "pending"]).nullable(),
    invitedAddress: z.string().min(1).max(320).nullable(),
  }),
);
export type EnvironmentMemberV11 = z.infer<typeof environmentMemberSchemaV11>;

/**
 * `@1.1`'s page: the members, plus when the reader dismissed the legacy-role
 * notice (null while they have not) and the names of the members still on a
 * legacy role, which the admin notice lists.
 */
export const environmentMembersResponseSchemaV11 = lazySchema(() =>
  z.object({
    members: z.array(environmentMemberSchemaV11),
    nextCursor: z.string().min(1).nullable(),
    legacyRoleNoticeSeenAt: z.number().int().nonnegative().nullable(),
    legacyMembers: z.array(z.string()),
  }),
);
export type EnvironmentMembersResponseV11 = z.infer<
  typeof environmentMembersResponseSchemaV11
>;

export const environmentMembersV11 = defineRpcContract({
  method: "environment.members",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentMembersRequestSchema,
  responseSchema: environmentMembersResponseSchemaV11,
});

/**
 * A `@1.0` page names no roles: each member upgrades as the retired `viewer`,
 * which {@link grantedTeamMemberRole} resolves to no seat authority, with no
 * plan and no invitation, and the page with no notice to show. The unknown
 * role must stay this value for the reason the environment list's does.
 */
export const environmentMembersUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentMembersV10,
  typeof environmentMembersV11
>({
  from: environmentMembersV10.schemaVersion,
  to: environmentMembersV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    members: response.members.map((member) => ({
      ...member,
      effectiveRole: "viewer" as const,
      linkedPlan: false,
      inviteState: null,
      invitedAddress: null,
    })),
    nextCursor: response.nextCursor,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  }),
});

/**
 * `environment.members@1.2`'s member: `@1.1`'s plus their `email`, so
 * Members can show each person's name, email and role. The email is the one
 * authn returns for this reader, passed through as authn scoped it: null
 * where authn gave none or blanked it for this reader. The host never
 * derives or widens it.
 */
export const environmentMemberSchemaV12 = lazySchema(() =>
  environmentMemberSchemaV11.extend({
    email: z.string().min(1).max(320).nullable(),
  }),
);
export type EnvironmentMemberV12 = z.infer<typeof environmentMemberSchemaV12>;

export const environmentMembersResponseSchemaV12 = lazySchema(() =>
  z.object({
    members: z.array(environmentMemberSchemaV12),
    nextCursor: z.string().min(1).nullable(),
    legacyRoleNoticeSeenAt: z.number().int().nonnegative().nullable(),
    legacyMembers: z.array(z.string()),
  }),
);
export type EnvironmentMembersResponseV12 = z.infer<
  typeof environmentMembersResponseSchemaV12
>;

export const environmentMembersV12 = defineRpcContract({
  method: "environment.members",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentMembersRequestSchema,
  responseSchema: environmentMembersResponseSchemaV12,
});

/** A `@1.1` page names no email: each member upgrades with none. */
export const environmentMembersUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentMembersV11,
  typeof environmentMembersV12
>({
  from: environmentMembersV11.schemaVersion,
  to: environmentMembersV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    members: response.members.map((member) => ({ ...member, email: null })),
  }),
});

/**
 * `environment.members.invite@1.0`: an admin invites an address to a role.
 * `sent` with the seats used and total after it, null for a team with no
 * seat count; `forbidden` for a non-admin; `seat_limit` when no seat is left.
 */
export const environmentMembersInviteRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    email: z.string().min(3).max(320),
    role: environmentMemberRoleSchema,
  }),
);
export type EnvironmentMembersInviteRequest = z.infer<
  typeof environmentMembersInviteRequestSchema
>;

export const environmentMembersInviteResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("sent"),
      seatDelta: z
        .object({
          used: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
    z.object({ outcome: z.literal("forbidden") }),
    z.object({ outcome: z.literal("seat_limit") }),
  ]),
);
export type EnvironmentMembersInviteResponse = z.infer<
  typeof environmentMembersInviteResponseSchema
>;

export const environmentMembersInviteV10 = defineRpcContract({
  method: "environment.members.invite",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersInviteRequestSchema,
  responseSchema: environmentMembersInviteResponseSchema,
});

/**
 * `environment.members.setRole@1.0`: an admin changes a member's role.
 * `last_admin` refuses demoting the team's only admin; `plan_required` is a
 * team with no plan, whose seats cannot be managed.
 */
export const environmentMembersSetRoleRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    userId: z.string().min(1),
    role: environmentMemberRoleSchema,
  }),
);
export type EnvironmentMembersSetRoleRequest = z.infer<
  typeof environmentMembersSetRoleRequestSchema
>;

export const environmentMembersSetRoleResponseSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["changed", "last_admin", "forbidden", "plan_required"]),
  }),
);
export type EnvironmentMembersSetRoleResponse = z.infer<
  typeof environmentMembersSetRoleResponseSchema
>;

export const environmentMembersSetRoleV10 = defineRpcContract({
  method: "environment.members.setRole",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersSetRoleRequestSchema,
  responseSchema: environmentMembersSetRoleResponseSchema,
});

const environmentMemberTargetRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    userId: z.string().min(1),
  }),
);

/**
 * `environment.members.remove@1.0`: an admin removes a member. Removal runs
 * on every host the member reached, so the answer is `pending` with the
 * receipt that tracks it; a pending invitation is `revoked` at once, with no
 * receipt; `last_admin` refuses removing the only admin; `plan_required` is a
 * team with no plan.
 */
export const environmentMembersRemoveRequestSchema =
  environmentMemberTargetRequestSchema;
export type EnvironmentMembersRemoveRequest = z.infer<
  typeof environmentMembersRemoveRequestSchema
>;

export const environmentMembersRemoveResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("pending"), receiptId: z.string().min(1) }),
    z.object({ outcome: z.literal("revoked") }),
    z.object({ outcome: z.literal("last_admin") }),
    z.object({ outcome: z.literal("forbidden") }),
    z.object({ outcome: z.literal("plan_required") }),
  ]),
);
export type EnvironmentMembersRemoveResponse = z.infer<
  typeof environmentMembersRemoveResponseSchema
>;

export const environmentMembersRemoveV10 = defineRpcContract({
  method: "environment.members.remove",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersRemoveRequestSchema,
  responseSchema: environmentMembersRemoveResponseSchema,
});

/**
 * `environment.members.removePreview@1.0`: what removing a member stops, for
 * the confirm: their running turns and terminals on `localHostId`, the
 * serving host (all three null when it holds no facts for that team, since
 * the counts exist nowhere else), the sign-ins they shared (by name), the
 * paid sandboxes running (by name and who started each), and the plan they
 * linked (its name), null when none.
 */
export const environmentMembersRemovePreviewRequestSchema =
  environmentMemberTargetRequestSchema;
export type EnvironmentMembersRemovePreviewRequest = z.infer<
  typeof environmentMembersRemovePreviewRequestSchema
>;

export const environmentMembersRemovePreviewResponseSchema = lazySchema(() =>
  z.object({
    activeTurns: z.number().int().nonnegative().nullable(),
    terminals: z.number().int().nonnegative().nullable(),
    localHostId: z.string().min(1).nullable(),
    sharedSignIns: z.array(z.string()),
    paidSandboxes: z.array(
      z.object({ name: z.string(), startedBy: z.string() }),
    ),
    linkedPlan: z.string().nullable(),
  }),
);
export type EnvironmentMembersRemovePreviewResponse = z.infer<
  typeof environmentMembersRemovePreviewResponseSchema
>;

export const environmentMembersRemovePreviewV10 = defineRpcContract({
  method: "environment.members.removePreview",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersRemovePreviewRequestSchema,
  responseSchema: environmentMembersRemovePreviewResponseSchema,
});

/**
 * `environment.previewLocalFacts@1.0`: this computer's own counts for a plan
 * (`plan`, by its profile) or a member (`member`) of an environment.
 * `terminals` is always null for a `plan` subject. Defined and not
 * registered: it registers with the host slice that serves it and its first
 * caller. Not an agent capability.
 */
export const environmentPreviewLocalFactsRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("plan"), profileId: z.string().min(1) }),
      z.object({ kind: z.literal("member"), userId: z.string().min(1) }),
    ]),
  }),
);
export type EnvironmentPreviewLocalFactsRequest = z.infer<
  typeof environmentPreviewLocalFactsRequestSchema
>;

export const environmentPreviewLocalFactsResponseSchema = lazySchema(() =>
  z.object({
    activeTurns: z.number().int().nonnegative().nullable(),
    terminals: z.number().int().nonnegative().nullable(),
  }),
);
export type EnvironmentPreviewLocalFactsResponse = z.infer<
  typeof environmentPreviewLocalFactsResponseSchema
>;

export const environmentPreviewLocalFactsV10 = defineRpcContract({
  method: "environment.previewLocalFacts",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentPreviewLocalFactsRequestSchema,
  responseSchema: environmentPreviewLocalFactsResponseSchema,
});

/**
 * `environment.members.seats@1.0`: the seats a team holds (every membership
 * row, pending invitations included) of the quantity its paid plan bills,
 * read before an invite is sent; `seats` null for a team on no paid plan.
 */
export const environmentMembersSeatsRequestSchema = lazySchema(() =>
  z.object({ environmentId: z.string().min(1) }),
);
export type EnvironmentMembersSeatsRequest = z.infer<
  typeof environmentMembersSeatsRequestSchema
>;

export const environmentMembersSeatsResponseSchema = lazySchema(() =>
  z.object({
    seats: z
      .object({
        used: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
);
export type EnvironmentMembersSeatsResponse = z.infer<
  typeof environmentMembersSeatsResponseSchema
>;

export const environmentMembersSeatsV10 = defineRpcContract({
  method: "environment.members.seats",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersSeatsRequestSchema,
  responseSchema: environmentMembersSeatsResponseSchema,
});

/**
 * One invitation waiting for the reader's Accept: the team's environment and
 * name, the role the invitation gives, and whether the team is on a paid
 * plan, which decides the seat sentences shown with the grant.
 */
export const environmentInvitationSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    teamName: z.string().min(1),
    role: environmentMemberRoleSchema,
    paidPlan: z.boolean(),
  }),
);
export type EnvironmentInvitation = z.infer<typeof environmentInvitationSchema>;

/**
 * `environment.invitations.list@1.0`: the teams that invited the signed-in
 * person and wait for their Accept. A host that serves it also never joins
 * the person to a team without that Accept.
 */
export const environmentInvitationsListRequestSchema = lazySchema(() =>
  z.object({}),
);
export type EnvironmentInvitationsListRequest = z.infer<
  typeof environmentInvitationsListRequestSchema
>;

export const environmentInvitationsListResponseSchema = lazySchema(() =>
  z.object({ invitations: z.array(environmentInvitationSchema) }),
);
export type EnvironmentInvitationsListResponse = z.infer<
  typeof environmentInvitationsListResponseSchema
>;

export const environmentInvitationsListV10 = defineRpcContract({
  method: "environment.invitations.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentInvitationsListRequestSchema,
  responseSchema: environmentInvitationsListResponseSchema,
});

/**
 * `environment.invitations.accept@1.0`: the signed-in person accepts the
 * invitation to `environmentId`'s team, after reading its grant. `accepted`
 * also answers a seat already accepted; `not_found` is an invitation that
 * was revoked, or never sent to this person.
 */
export const environmentInvitationsAcceptRequestSchema = lazySchema(() =>
  z.object({ environmentId: z.string().min(1) }),
);
export type EnvironmentInvitationsAcceptRequest = z.infer<
  typeof environmentInvitationsAcceptRequestSchema
>;

export const environmentInvitationsAcceptResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["accepted", "not_found"]) }),
);
export type EnvironmentInvitationsAcceptResponse = z.infer<
  typeof environmentInvitationsAcceptResponseSchema
>;

export const environmentInvitationsAcceptV10 = defineRpcContract({
  method: "environment.invitations.accept",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentInvitationsAcceptRequestSchema,
  responseSchema: environmentInvitationsAcceptResponseSchema,
});

/** `environment.members.noticeSeen@1.0`: the reader dismissed the legacy-role notice. */
export const environmentMembersNoticeSeenRequestSchema = lazySchema(() =>
  z.object({ environmentId: z.string().min(1) }),
);
export type EnvironmentMembersNoticeSeenRequest = z.infer<
  typeof environmentMembersNoticeSeenRequestSchema
>;

export const environmentMembersNoticeSeenResponseSchema = lazySchema(() =>
  z.object({ outcome: z.literal("recorded") }),
);
export type EnvironmentMembersNoticeSeenResponse = z.infer<
  typeof environmentMembersNoticeSeenResponseSchema
>;

export const environmentMembersNoticeSeenV10 = defineRpcContract({
  method: "environment.members.noticeSeen",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMembersNoticeSeenRequestSchema,
  responseSchema: environmentMembersNoticeSeenResponseSchema,
});

export const environmentSetMainBotRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1).max(36),
    botId: botIdSchema,
  }),
);
export type EnvironmentSetMainBotRequest = z.infer<
  typeof environmentSetMainBotRequestSchema
>;

/**
 * The environment's main bot once the choice is written: the named bot. A
 * member of an object root so the response can grow additively.
 */
export const environmentSetMainBotResponseSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    mainBotId: botIdSchema,
  }),
);
export type EnvironmentSetMainBotResponse = z.infer<
  typeof environmentSetMainBotResponseSchema
>;

/**
 * Makes a bot its environment's main bot: the bot that curates
 * the environment's shared memory and is told when it passes its ceiling. Any
 * member may set it, and set it back. Refused for an environment the caller
 * does not belong to exactly as for one that does not exist, and for a bot
 * that is not a live bot of that environment. Cloud-backed: any host answers
 * the same.
 */
export const environmentSetMainBotV10 = defineRpcContract({
  method: "environment.setMainBot",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentSetMainBotRequestSchema,
  responseSchema: environmentSetMainBotResponseSchema,
});
