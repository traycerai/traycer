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
 * What to say and whether the button applies, or `null` when this provider has
 * nothing to say at all.
 *
 * The two answers come from ONE call because they are separately sourced and a
 * caller that derived them apart got them wrong: whether the ACTION applies is
 * the host's call (`terminalLogin`), while whether there is guidance to SHOW is
 * the copy table's. A host predating the capability - or any host at all, for a
 * provider the table knows and the host does not - can still be told where its
 * credentials go, which is how Reasonix's `reasonix setup` instructions
 * survived before this button existed. Gating the copy on the capability
 * dropped them and left a signed-out Reasonix at the generic error state with
 * no way forward.
 *
 * `loginCapability` comes from `providers.list`; while that has not resolved
 * (`undefined`/`null` state) the capability answer is "not yet", never "no" -
 * it re-resolves when the state lands.
 */
export interface ProviderTerminalSetup {
  readonly guidance: ProviderSetupGuidance;
  /** Whether the connected host can open the sign-in terminal itself. */
  readonly canStartTerminal: boolean;
}

export function resolveProviderTerminalSetup(
  providerId: ProviderId,
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): ProviderTerminalSetup | null {
  const override = providerSetupGuidance(providerId);
  if (!providerSupportsTerminalLogin(loginCapability)) {
    // No host-run terminal, so only a provider with its own manual route has
    // anything left to offer; the generic sign-in copy is all button.
    return override === null
      ? null
      : { guidance: override, canStartTerminal: false };
  }
  return {
    guidance: override ?? defaultTerminalSignInGuidance(providerId),
    canStartTerminal: true,
  };
}

/**
 * Where the terminal action is, from this surface's point of view - what the
 * steps have to lead with.
 */
export type ProviderSetupActionPlacement =
  /** A button right here, so the steps are what follows it. */
  | "here"
  /** A button, but on another surface (a fork dialog's picker). */
  | "other-surface"
  /** No button anywhere on this host - the manual command is the route. */
  | "unsupported-host";

/**
 * Where this surface's action is, from the two facts that decide it. Shared so
 * the auth line and the model list cannot classify the same state differently -
 * the reason they were wrong about old hosts in the first place.
 */
export function providerSetupActionPlacement(
  setup: ProviderTerminalSetup,
  hasSurface: boolean,
): ProviderSetupActionPlacement {
  if (!setup.canStartTerminal) return "unsupported-host";
  return hasSurface ? "here" : "other-surface";
}

/**
 * The ordered steps for a surface: the post-action steps alone where a button
 * precedes them, led by the sentence naming where the button lives, or - on a
 * host that cannot open one at all - by neither, since pointing at a button
 * this host never draws is the misdirection this copy exists to remove. The
 * manual command renders under the steps and carries that case.
 */
export function providerSetupSteps(
  guidance: ProviderSetupGuidance,
  placement: ProviderSetupActionPlacement,
): ReadonlyArray<string> {
  if (placement === "other-surface") {
    return [guidance.noSurfaceStep, ...guidance.stepsAfterAction];
  }
  return guidance.stepsAfterAction;
}
