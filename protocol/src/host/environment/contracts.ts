/**
 * `environment.list` - every team environment the signed-in user belongs to.
 * `environment.host.read` / `environment.host.bind` - the one environment
 * this host is bound to, and rebinding it.
 * `environment.host.list` - every host bound to a team environment, as any
 * member of the team sees it.
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
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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
 * The environment this host is bound to, for the signed-in user. A host
 * belongs to exactly one of its owner's environments and every agent on it
 * runs in that one. `explicit` is false when the owner never bound the host:
 * it is then in their personal environment, which is the only default and
 * never a team.
 *
 * A host bound to a team environment is the team's: every member sees it
 * (`environment.host.list`), and only the account that bound it can unbind
 * it. `enrolledByUserId` is that account, null when the binding is not
 * explicit; `canUnbind` is whether the caller is it.
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
 * Lists every host bound to a team environment to any member of it. Refused
 * for an environment the caller does not belong to, and for one that does
 * not exist.
 */
export const environmentHostListV10 = defineRpcContract({
  method: "environment.host.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHostListRequestSchema,
  responseSchema: environmentHostListResponseSchema,
});
