import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import type {
  RefusalAwareAuthRevalidator,
  RevalidateOutcome,
} from "@traycer-clients/shared/auth/bearer-revalidator";

/**
 * Presented by an agent's own commands to the host that started the agent, in place
 * of the stored sign-in. Opaque: read by its name, never parsed, printed or logged.
 * It dies with its session generation, so a refusal is final; it goes only to the
 * loopback host the pid file names, never to authn, a mint or provisioning.
 */
const AGENT_SESSION_CAPABILITY_VARIABLE = "TRAYCER_AGENT_SESSION_CAPABILITY";

/**
 * The one way this module sees an environment: one value, by its name. It has
 * no way to list what else the environment holds.
 */
export type AgentEnvironment = (name: string) => string | undefined;

export const PROCESS_AGENT_ENVIRONMENT: AgentEnvironment = (name) =>
  process.env[name];

/** The capability names its starter to the host; the CLI never learns who. */
const AGENT_SESSION_IDENTITY = { userId: "agent-session" } as const;

export interface AgentSessionCapability {
  /** For a unary call's open and request frames. */
  readonly bearer: OpenFrameBearerSource;
  /** Recovers nothing: the host's refusal of a capability ends the call. */
  readonly recovery: RefusalAwareAuthRevalidator;
  /** For `/stream`'s open frame. */
  readonly streamBearer: BearerSourceProvider;
  readonly streamRecovery: () => Promise<RevalidateOutcome>;
}

/** Marked by the presenting call, so error mapping can tell them from a refusal of this CLI's token. */
const refusalsOfCapability = new WeakSet<object>();

export function markRefusalOfAgentSessionCapability(refusal: object): void {
  refusalsOfCapability.add(refusal);
}

export function isRefusalOfAgentSessionCapability(refusal: unknown): boolean {
  return (
    typeof refusal === "object" &&
    refusal !== null &&
    refusalsOfCapability.has(refusal)
  );
}

/** Set by the host on every session it starts, with or without a capability. */
const AGENT_ID_VARIABLE = "TRAYCER_AGENT_ID";

/**
 * `none`: a host session with no capability. Nothing is presented in its place,
 * neither the stored sign-in nor a host-only token, so the command fails as with no
 * credential. `outside-agent-session` spends the stored sign-in.
 */
export type AgentCommandCredential =
  | {
      readonly kind: "capability";
      readonly capability: AgentSessionCapability;
    }
  | { readonly kind: "none" }
  | { readonly kind: "outside-agent-session" };

export function readAgentCommandCredential(
  environment: AgentEnvironment,
): AgentCommandCredential {
  const capability = readAgentSessionCapability(environment);
  if (capability !== null) return { kind: "capability", capability };
  const agentId = environment(AGENT_ID_VARIABLE);
  return agentId === undefined || agentId.length === 0
    ? { kind: "outside-agent-session" }
    : { kind: "none" };
}

function readAgentSessionCapability(
  environment: AgentEnvironment,
): AgentSessionCapability | null {
  const value = environment(AGENT_SESSION_CAPABILITY_VARIABLE);
  if (value === undefined || value.length === 0) return null;
  const bearer: OpenFrameBearerSource = {
    identity: AGENT_SESSION_IDENTITY,
    getBearerToken: () => value,
  };
  const never = (): Promise<RevalidateOutcome> => Promise.resolve("rejected");
  return {
    bearer,
    recovery: {
      revalidateExpectedBearer: never,
      revalidateRefusedBearer: never,
    },
    streamBearer: () => bearer,
    streamRecovery: never,
  };
}
