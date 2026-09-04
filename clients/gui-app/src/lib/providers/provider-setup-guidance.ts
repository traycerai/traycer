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
 * The in-app path is the composer banner's terminal action, which runs the
 * SELECTED binary's setup command in a terminal on the host the composer runs
 * on. The steps point there rather than at a bare shell command: the bundled
 * pack is not on the user's PATH, a custom selection may live elsewhere, and
 * a remote host has to be configured on that machine, not this one. The
 * `manualCommand` is the equivalent for someone who installed the CLI
 * themselves, and is labelled as exactly that.
 *
 * Copy only. Which providers get an entry is a product decision made here,
 * not derived from `loginCapability`: the capability says HOW the host can
 * start a login, not what the user has to do inside it.
 */
export interface ProviderSetupGuidance {
  /** One line on why the generic sign-in framing does not apply. */
  readonly summary: string;
  /** The in-app steps, in order. */
  readonly steps: ReadonlyArray<string>;
  /**
   * The command a self-installed CLI runs to do the same thing; rendered as
   * code, always beside the caveat that it targets whatever binary and home
   * that shell resolves.
   */
  readonly manualCommand: string;
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
    steps: [
      "From a chat, choose “Set up in terminal” in the banner above the composer. It opens Reasonix's setup wizard on the host this composer runs on.",
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ],
    manualCommand: "reasonix setup",
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
