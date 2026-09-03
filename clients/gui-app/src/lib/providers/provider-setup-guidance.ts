import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

/**
 * Setup guidance for a provider whose signed-out state is NOT fixed by any of
 * the generic reconnect affordances (browser OAuth, a pasted token, a Traycer
 * stored API key).
 *
 * The generic surfaces describe a sign-in: "Sign in from a terminal", "prints
 * a sign-in code". For a provider that owns its own credential store that
 * framing is wrong in a way that costs the user real time - Reasonix's own
 * startup warning names an environment variable (`missing env
 * DEEPSEEK_API_KEY`), so the natural next move is to export it in the shell,
 * and the shipped CLI ignores the process environment entirely (byte-verified
 * against 1.35.0: the same key exported into the environment produced an
 * outbound `x-api-key` of length 0; only `<reasonix-home>/.env` worked).
 * The only thing that helps is telling the user exactly where the key goes.
 *
 * Copy only. Which providers get an entry is a product decision made here,
 * not derived from `loginCapability`: the capability says HOW the host can
 * start a login, not what the user has to do inside it.
 */
export interface ProviderSetupGuidance {
  /** One line on why the generic sign-in framing does not apply. */
  readonly summary: string;
  /** The command the user runs in a terminal; rendered as code. */
  readonly command: string;
  /** What happens after the command, in order. */
  readonly steps: ReadonlyArray<string>;
  /** Label for the reauth banner's terminal action. */
  readonly terminalActionLabel: string;
  /** Hint under that action. */
  readonly terminalHint: string;
}

const PROVIDER_SETUP_GUIDANCE: {
  readonly [k in ProviderId]?: ProviderSetupGuidance;
} = {
  reasonix: {
    summary:
      "Reasonix keeps provider API keys in its own store, not in your shell environment.",
    command: "reasonix setup",
    steps: [
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ],
    terminalActionLabel: "Set up in terminal",
    terminalHint:
      "Reasonix asks for your provider API key in that terminal. Finish there, then use Refresh above.",
  },
};

export function providerSetupGuidance(
  providerId: ProviderId,
): ProviderSetupGuidance | null {
  return PROVIDER_SETUP_GUIDANCE[providerId] ?? null;
}
