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

/** The capability `environment` carries, or `null` when it carries none. */
export function readAgentSessionCapability(
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
