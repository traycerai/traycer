/**
 * What a sandbox host tells a client about its brokered egress: the typed
 * events its forwarder and the gateway raise, and the repair verb for its
 * guest configuration.
 *
 * A sandbox holds no user credential. Its outbound traffic to a granted
 * destination leaves through a forwarder in the guest and Traycer's egress
 * gateway, which holds the secret. When that path refuses, tears down or holds
 * a connection, an HTTPS client reads a response body, but a database, SSH,
 * broker or mail client reads only its protocol's own authentication failure.
 * The typed event is what names the real reason, on every protocol.
 *
 * ## Degrade story
 *
 * Both methods here are brand-new and off the released floor. The stream is
 * intersection-negotiated: a peer that predates it does not advertise it, so a
 * released client never opens it and never receives an event, and a host that
 * is not a sandbox, or predates it, refuses the open as an unknown method.
 * That is the whole gate; no event kind is ever projected onto another
 * surface. The unary is registered `degrade: { kind: "unsupported" }`.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

/**
 * The tool an agent calls to ask the user for a grant. A refusal that a grant
 * would fix carries it as `howToRequest`, on the event here and in the
 * gateway's refusal body alike.
 */
export const SANDBOX_SECRET_REQUEST_TOOL = "traycer_secret_request";

/**
 * The refusal codes the secrets track's clients have copy for. `code` on the
 * wire is an open string - a worker class may raise one of its own
 * (`ssh_flow_unknown`, `mail_delivery_ambiguous`) and a newer host may raise
 * one this build has never heard of - so this list is for looking copy up,
 * never for rejecting an event.
 */
export const SANDBOX_EGRESS_REFUSAL_CODES = [
  "grant_missing",
  "sandbox_not_awake",
  "sandbox_resuming",
  "authorization_stale",
  "protocol_not_brokered",
  "signing_shape_unsupported",
  "leaf_unavailable",
  "connector_offline",
  "connector_not_enrolled",
  "socks_command_unsupported",
  "port_not_supported",
  "endpoint_unavailable",
  "h3_only_destination",
  "SANDBOX_GUEST_NOT_CONFIGURED",
] as const;

export type SandboxEgressRefusalCode =
  (typeof SANDBOX_EGRESS_REFUSAL_CODES)[number];

/**
 * Who raised an event. Three emitters, by where the wake stands:
 *
 *  - `controller`: the host's wake controller, before the proof of possession.
 *  - `reporter`: the host's diagnostic-only reporter, after the proof.
 *  - `gateway`: the egress gateway, relayed by the host once the wake is
 *    activated.
 *
 * The first two are the guest's own account of itself, which anything running
 * in the guest can influence; `untrusted` says so on the event, so a reader
 * need not know this mapping.
 */
export const sandboxEgressEmitterSchema = lazySchema(() =>
  z.enum(["controller", "reporter", "gateway"]),
);
export type SandboxEgressEmitter = z.infer<typeof sandboxEgressEmitterSchema>;

/**
 * Why an established route was torn down. `secret_rotated`: the secret behind
 * the route was given a new value, and connections opened with the old one
 * were closed.
 */
export const sandboxEgressTeardownReasonSchema = lazySchema(() =>
  z.enum(["revoke", "stale", "resume", "drain", "secret_rotated"]),
);
export type SandboxEgressTeardownReason = z.infer<
  typeof sandboxEgressTeardownReasonSchema
>;

const eventBaseFields = {
  /** Unique per event on this host; a reader dedupes a replay by it. */
  id: lazySchema(() => z.string().min(1)),
  /** Epoch milliseconds, on the emitter's clock. */
  at: lazySchema(() => z.number().int().nonnegative()),
  emitter: sandboxEgressEmitterSchema,
  /** True when the guest raised it about itself; see the emitter's note. */
  untrusted: lazySchema(() => z.boolean()),
} as const;

/**
 * A connection was refused. `route` is `null` when the destination has no
 * route at all (the missing-grant case); `host` and `protocol` are what the
 * client dialled, so a reader can tell a missing grant from an unsupported
 * mode. `secret` is the bound secret's NAME where the emitter knows it, never
 * a value. `howToRequest` is set when asking the user for a grant is the
 * remedy.
 */
const egressRefusedEventSchema = lazySchema(() =>
  z.object({
    kind: z.literal("egress.refused"),
    ...eventBaseFields,
    code: z.string().min(1),
    route: z.string().min(1).nullable(),
    host: z.string().min(1).nullable(),
    protocol: z.string().min(1).nullable(),
    secret: z.string().min(1).nullable(),
    howToRequest: z.string().min(1).nullable(),
  }),
);

/** An established route's connections were closed, and why. */
const egressTeardownEventSchema = lazySchema(() =>
  z.object({
    kind: z.literal("egress.teardown"),
    ...eventBaseFields,
    route: z.string().min(1),
    reason: sandboxEgressTeardownReasonSchema,
  }),
);

/**
 * A connection was held while the sandbox finished waking and then went
 * through; `waitedMs` is how long. Not a failure - it explains a slow first
 * request.
 */
const egressHeldEventSchema = lazySchema(() =>
  z.object({
    kind: z.literal("egress.held"),
    ...eventBaseFields,
    route: z.string().min(1),
    waitedMs: z.number().int().nonnegative(),
  }),
);

/**
 * A client used a mode of the route's protocol that its worker does not carry
 * (an SSH authentication method, a database authentication plugin). `mode`
 * names it and `reason` says what to use instead, in the emitter's words.
 */
const egressUnsupportedModeEventSchema = lazySchema(() =>
  z.object({
    kind: z.literal("egress.unsupported_mode"),
    ...eventBaseFields,
    route: z.string().min(1),
    mode: z.string().min(1),
    reason: z.string(),
  }),
);

export const sandboxEgressEventSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    egressRefusedEventSchema,
    egressTeardownEventSchema,
    egressHeldEventSchema,
    egressUnsupportedModeEventSchema,
  ]),
);
export type SandboxEgressEvent = z.infer<typeof sandboxEgressEventSchema>;
export type SandboxEgressEventKind = SandboxEgressEvent["kind"];

/**
 * The most events one `snapshot` frame carries. The host retains a bounded,
 * rate-limited tail per route; this caps the frame, not the retention.
 */
export const SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS = 200;

// ─── `host.sandbox.egress.subscribe@1.0` ────────────────────────────────────

export const sandboxEgressSubscribeOpenRequestSchemaV10 = lazySchema(() =>
  z.object({}),
);
export type SandboxEgressSubscribeOpenRequestV10 = z.infer<
  typeof sandboxEgressSubscribeOpenRequestSchemaV10
>;

export const sandboxEgressSubscribeServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * The first frame, and the frame after any gap the host cannot bridge: the
     * retained events, oldest first. A reader replaces what it holds.
     */
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      events: z
        .array(sandboxEgressEventSchema)
        .max(SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS),
    }),
    /** One event as it is raised. */
    z.object({
      kind: z.literal("event"),
      ...textFrameFields,
      event: sandboxEgressEventSchema,
    }),
    /** The heartbeat's answer; see `host-inventory.ts` on why it is required. */
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]),
);
export type SandboxEgressSubscribeServerFrameV10 = z.infer<
  typeof sandboxEgressSubscribeServerFrameSchemaV10
>;

export const sandboxEgressSubscribeClientFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]),
);
export type SandboxEgressSubscribeClientFrameV10 = z.infer<
  typeof sandboxEgressSubscribeClientFrameSchemaV10
>;

export const sandboxEgressSubscribeV10 = defineStreamRpcContract({
  method: "host.sandbox.egress.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: sandboxEgressSubscribeOpenRequestSchemaV10,
  serverFrameSchema: sandboxEgressSubscribeServerFrameSchemaV10,
  clientFrameSchema: sandboxEgressSubscribeClientFrameSchemaV10,
});

// ─── `host.sandbox.repairGuestConfiguration` ────────────────────────────────

// The shipped 1.0 action repairs guest setup only. Keep both wire shapes frozen.
const sandboxRepairGuestConfigurationRequestSchemaV10 = lazySchema(() =>
  z.object({}),
);
const sandboxRepairGuestConfigurationResponseSchemaV10 = lazySchema(() =>
  z.object({
    guestConfigured: z.boolean(),
    guestConfigFailureReason: z.string().nullable(),
  }),
);

/** Optional and off the released floor: a peer without the method negotiates it away. */
export const sandboxRepairGuestConfigurationV10 = defineRpcContract({
  method: "host.sandbox.repairGuestConfiguration",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: sandboxRepairGuestConfigurationRequestSchemaV10,
  responseSchema: sandboxRepairGuestConfigurationResponseSchemaV10,
});

export const sandboxRepairGuestConfigurationRequestSchema = lazySchema(() =>
  z.object({ operationId: z.string().min(1).max(128).nullable() }),
);
export type SandboxRepairGuestConfigurationRequest = z.infer<
  typeof sandboxRepairGuestConfigurationRequestSchema
>;

/** Guest facts retain their original meaning; only settingsApplied acknowledges both steps. */
export const sandboxRepairGuestConfigurationResponseSchema = lazySchema(() =>
  sandboxRepairGuestConfigurationResponseSchemaV10.extend({
    settingsApplied: z.boolean(),
  }),
);
export type SandboxRepairGuestConfigurationResponse = z.infer<
  typeof sandboxRepairGuestConfigurationResponseSchema
>;

/** Re-applies guest setup and environment settings as one retry operation. */
export const sandboxRepairGuestConfigurationV11 = defineRpcContract({
  method: "host.sandbox.repairGuestConfiguration",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: sandboxRepairGuestConfigurationRequestSchema,
  responseSchema: sandboxRepairGuestConfigurationResponseSchema,
});

export const sandboxRepairGuestConfigurationUpgradeV10ToV11 = defineUpgradePath<
  typeof sandboxRepairGuestConfigurationV10,
  typeof sandboxRepairGuestConfigurationV11
>({
  from: sandboxRepairGuestConfigurationV10.schemaVersion,
  to: sandboxRepairGuestConfigurationV11.schemaVersion,
  upgradeRequest: () => ({ operationId: null }),
  // A guest-only answer carries no evidence that environment settings applied.
  upgradeResponse: (response) => ({ ...response, settingsApplied: false }),
});
