/**
 * `environment.list` - every team environment the signed-in user belongs to.
 * `environment.host.read` / `environment.host.bind` - the one environment
 * this host is bound to, and rebinding it.
 * `environment.host.list` - the hosts of a team environment the caller may see.
 * `environment.members` - the people in an environment, by name and avatar,
 * so a client can name the member who wrote a message.
 * `environment.setMainBot` - which of an environment's bots is its main bot.
 * `environment.members.invite` / `.setRole` / `.remove` / `.removePreview` /
 * `.noticeSeen` - an admin's member management, and the legacy-role notice.
 *
 * `@1.1` of `environment.list`, `environment.host.list` and
 * `environment.members` adds the redesign's fields, each with its upgrade
 * from `@1.0`; no line here has shipped, so none is a MAJOR.
 *
 * An environment is the cloud container a team shares: skills, the shared
 * notes block, the agent selection guide and the bot list, all held in one
 * collab room. A team is an authn organization. The user belongs to one
 * environment per team they are in, plus their personal environment, and sees
 * them side by side; there is no "current" one. The cloud lists and creates
 * them; the host proxies the list, cached for the signed-in session.
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

/** The caller's effective role in an environment; `owner` is a personal one's. */
export const environmentEffectiveRoleSchema = lazySchema(() =>
  z.enum(["owner", "admin", "editor", "viewer"]),
);
export type EnvironmentEffectiveRole = z.infer<
  typeof environmentEffectiveRoleSchema
>;

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
 * own; a team's role is unknown, so it reads as the least, `viewer`, and its
 * host count as none, which a client re-reads rather than acts on.
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
 * The environment this host is bound to, for the signed-in user. A host
 * belongs to exactly one of its owner's environments and every agent on it
 * runs in that one. `explicit` is false when the owner never bound the host:
 * it is then in their personal environment, which is the only default and
 * never a team.
 *
 * Only the account that bound a host can unbind it. `enrolledByUserId` is
 * that account, null when the binding is not explicit; `canUnbind` is whether
 * the caller is it.
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
 * The environment the named host is bound to, as the signed-in user sees it:
 * the same answer `environment.host.read` gives on that host, read from the
 * account's binding records instead of asking the host. Served by the server
 * pool, so a list of hosts reads every row's binding without a connection to
 * each host. A host the user cannot see a binding for answers the personal
 * environment (`explicit` false), exactly as an unbound host does.
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
 * Binds the serving host to one of the signed-in user's environments.
 * Binding to the personal environment removes the binding (`explicit`
 * false). Refused for an environment the user does not belong to, and while
 * a live bot of another environment is bound to the host. A rebind applies
 * to new turns; running turns keep the environment they started with.
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

export const environmentHostListRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
  }),
);
export type EnvironmentHostListRequest = z.infer<
  typeof environmentHostListRequestSchema
>;

/**
 * One host bound to an environment. `hostLabel` and `hostPlatform` are what
 * the host reported about itself when it was bound, null when it reported
 * nothing; `enrolledByUserId` is the account that bound it, the only one that
 * can unbind it. `kind` is the host's registry kind: a `sandbox` is the
 * environment's machine, listed to every member and open to the environment's
 * bots; a `personal` machine is its enrolling member's, listed to that member
 * alone. `boundAt` is epoch milliseconds.
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
 * The hosts of the environment the caller may see: every sandbox bound to it,
 * whoever bound it, plus the caller's own bound hosts of any kind. A member of
 * an object root so the response can grow additively. Empty for a personal
 * environment, whose hosts are its owner's unbound ones.
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
 * Lists the hosts of a team environment the caller may see. Refused
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
 * states. `enrolledByUserId` and `boundAt` are null where the hosts route
 * does not know them; `@1.0` has no null for either, so the serving host
 * leaves such a row out of a `@1.0` caller's answer (the minor is
 * projection-gated in the registry).
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
 * when they have no picture. Never an email.
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

/** A team member's role. */
export const environmentMemberRoleSchema = lazySchema(() =>
  z.enum(["admin", "editor", "viewer"]),
);
export type EnvironmentMemberRole = z.infer<typeof environmentMemberRoleSchema>;

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
 * A `@1.0` page names no roles: each member upgrades as the least role,
 * `viewer`, with no plan and no invitation, and the page with no notice to
 * show.
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
 * Makes a bot its environment's main bot (decision 30): the bot that curates
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
