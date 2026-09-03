import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerSupportsTerminalLogin } from "@/components/providers/provider-signin-availability";

/**
 * What the picker says and does for a provider whose sign-in has to happen in
 * a real terminal - the host's `terminalLogin` capability.
 *
 * WHETHER a provider gets the terminal action is the capability's call
 * (`resolveProviderTerminalSetup`): the host declares it for exactly the
 * providers whose headless login cannot work (Copilot prints its device code
 * where only a terminal shows it; Reasonix's `setup` exits 0 without a
 * credential). WHAT the action says is copy, decided here: a generic sign-in
 * framing by default, overridden per provider where that framing is wrong.
 *
 * Reasonix is the override. The generic surfaces describe a sign-in: "Sign in
 * from a terminal", "prints a sign-in code". For a provider that owns its own
 * credential store that framing is wrong in a way that costs the user real
 * time - Reasonix's own startup warning names an environment variable
 * (`missing env DEEPSEEK_API_KEY`), so the natural next move is to export it
 * in the shell, and the shipped CLI ignores the process environment entirely
 * (byte-verified against 1.35.0: the same key exported into the environment
 * produced an outbound `x-api-key` of length 0; only `<reasonix-home>/.env`
 * worked). The only thing that helps is telling the user exactly where the
 * key goes.
 *
 * The in-app path is the terminal action (`terminalActionLabel`) that the
 * picker's setup CTA, the composer banner and the picker's auth line all
 * render: it asks the host to run the SELECTED binary's login command in a
 * terminal on the host the composer runs on, and lands that terminal on the
 * surface the picker is drawn on - the epic's canvas, or the landing page's
 * terminal panel. The steps point there rather than at a bare shell command:
 * the bundled pack is not on the user's PATH, a custom selection may live
 * elsewhere, and a remote host has to be configured on that machine, not this
 * one. The `manualCommand` is the equivalent for someone who installed the
 * CLI themselves, and is labelled as exactly that.
 */
export interface ProviderSetupGuidance {
  /** One line on what the terminal is for. */
  readonly summary: string;
  /**
   * What happens after the terminal action, in order. The action itself is a
   * button on every surface that can open a terminal, so it is not a step;
   * `noSurfaceStep` stands in for it where there is no such button.
   */
  readonly stepsAfterAction: ReadonlyArray<string>;
  /**
   * The first step on a surface with no terminal to open into (a fork
   * dialog), naming where the button does exist.
   */
  readonly noSurfaceStep: string;
  /**
   * The command a self-installed CLI runs to do the same thing; rendered as
   * code, always beside the caveat that it targets whatever binary and home
   * that shell resolves. `null` when the renderer has nothing truthful to
   * print - it does not know the provider's binary name or login argv, and
   * guessing one sends the user to a command that may not exist.
   */
  readonly manualCommand: string | null;
  /** Label for the terminal action. */
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
    stepsAfterAction: [
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ],
    noSurfaceStep:
      "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
    manualCommand: "reasonix setup",
    terminalActionLabel: "Set up in terminal",
    terminalHint:
      "Reasonix asks for your provider API key in that terminal. Finish there, then use Refresh above.",
  },
};

/** The per-provider copy override, if this provider has one. Copy only - see
 *  `resolveProviderTerminalSetup` for whether the action applies at all. */
export function providerSetupGuidance(
  providerId: ProviderId,
): ProviderSetupGuidance | null {
  return PROVIDER_SETUP_GUIDANCE[providerId] ?? null;
}

/**
 * The generic terminal sign-in copy - the same sentences the composer banner
 * uses for a provider without an override, so the picker and the banner
 * describe one flow the same way.
 */
export function defaultTerminalSignInGuidance(
  providerId: ProviderId,
): ProviderSetupGuidance {
  const name = PROVIDER_DISPLAY_NAMES[providerId];
  return {
    summary: `${name} signs in from a terminal: it prints a sign-in code that only exists there.`,
    stepsAfterAction: [
      "Complete the sign-in in that terminal.",
      "Refresh this list.",
    ],
    noSurfaceStep:
      "Choose “Sign in from a terminal” from a chat's model picker or the start page's. It opens the sign-in on the host that composer runs on.",
    manualCommand: null,
    terminalActionLabel: "Sign in from a terminal",
    terminalHint: `${name} prints a sign-in code that only exists in the terminal. Complete the sign-in there, then use Refresh above.`,
  };
}

/**
 * The guidance to show for this provider, or `null` when the terminal action
 * does not apply to it.
 *
 * Gated on the HOST's capability, not on the copy table: the table cannot
 * know which providers the connected host can open a terminal login for,
 * and a provider that gains the capability on the host gets the button here
 * without a renderer change. `loginCapability` comes from `providers.list`;
 * while that has not resolved (`undefined`/`null` state) the answer is "not
 * yet", never "no" - the caller shows the compact signed-out line and this
 * re-resolves when the state lands.
 */
export function resolveProviderTerminalSetup(
  providerId: ProviderId,
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): ProviderSetupGuidance | null {
  if (!providerSupportsTerminalLogin(loginCapability)) return null;
  return (
    providerSetupGuidance(providerId) ??
    defaultTerminalSignInGuidance(providerId)
  );
}

/**
 * The ordered steps for a surface: the post-action steps alone where a button
 * precedes them, or led by the sentence naming where the button lives.
 */
export function providerSetupSteps(
  guidance: ProviderSetupGuidance,
  hasTerminalAction: boolean,
): ReadonlyArray<string> {
  return hasTerminalAction
    ? guidance.stepsAfterAction
    : [guidance.noSurfaceStep, ...guidance.stepsAfterAction];
}
