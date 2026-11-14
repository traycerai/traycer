import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import type {
  RefusalAwareAuthRevalidator,
  RevalidateOutcome,
} from "@traycer-clients/shared/auth/bearer-revalidator";

/**
 * The agent session capability: the credential an agent's own commands
 * present to the host that started the agent, in place of the stored sign-in.
 * The host puts it in the agent's environment beside `TRAYCER_AGENT_ID` and
 * `TRAYCER_EPIC_ID`; a session the host started itself has none.
 *
 * Every use of the value is in this module. It is opaque: read by its name,
 * never parsed, printed or logged. It is minted once per agent session and
 * dies when the host releases the session, so nothing here renews it: a
 * refusal of it is final. It goes only to the loopback host the pid file
 * names, as the token every frame already carries, and never to authn, a
 * mint or a provisioning call.
 */
const AGENT_SESSION_CAPABILITY_VARIABLE = "TRAYCER_AGENT_SESSION_CAPABILITY";

/**
 * The one way this module sees an environment: one value, by its name. It has
 * no way to list what else the environment holds.
 */
export type AgentEnvironment = (name: string) => string | undefined;

export const PROCESS_AGENT_ENVIRONMENT: AgentEnvironment = (name) =>
  process.env[name];

/**
 * Keys the transport's session pool for calls made with a capability. The
 * capability names its own starter to the host; the CLI never learns who that
 * is.
 */
const AGENT_SESSION_IDENTITY = { userId: "agent-session" } as const;

/** What an agent's command presents to its host while a capability is set. */
export interface AgentSessionCapability {
  /** For a unary call's open and request frames. */
  readonly bearer: OpenFrameBearerSource;
  /** Recovers nothing: the host's refusal of a capability ends the call. */
  readonly recovery: RefusalAwareAuthRevalidator;
  /** For `/stream`'s open frame. */
  readonly streamBearer: BearerSourceProvider;
  /** Recovers nothing, as {@link recovery}. */
  readonly streamRecovery: () => Promise<RevalidateOutcome>;
}

/**
 * Host refusals of a call that presented the capability, marked by the call
 * that presented it so the command's error mapping can tell them from a
 * refusal of this CLI's host-only token.
 */
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
 * What an agent's own command presents:
 * - `capability`: the session's capability, and nothing else.
 * - `none`: a session the host started with no capability (one it started
 *   itself, or a terminal opened by someone the host does not let act on the
 *   agent's chat). Nothing is presented in its place, neither the stored
 *   sign-in nor a host-only token: the command fails as it does with no
 *   credential at all.
 * - `outside-agent-session`: no session of the host's is around this process
 *   (a person's own terminal); the command spends the stored sign-in.
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

/** The capability `environment` carries, or `null` when it carries none. */
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
