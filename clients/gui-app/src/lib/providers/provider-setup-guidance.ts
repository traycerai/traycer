import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerSupportsTerminalLogin,
  providerTerminalLoginPackBlock,
} from "@/components/providers/provider-signin-availability";
import {
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import type { ProviderTerminalLoginScopeSupport } from "@/hooks/providers/use-provider-terminal-login-scope-support";

/**
 * What the picker says and does for a provider whose sign-in has to happen in
 * a real terminal - the host's `terminalLogin` capability.
 *
 * WHETHER a provider gets the terminal action is the capability's call
 * (`resolveProviderTerminalSetup`): the host declares it for exactly the
 * providers whose headless login cannot work (Copilot prints its device code
 * where only a terminal shows it; Reasonix's `setup` exits 0 without a
 * credential; Qwen, Droid, OMP and OpenCode have no login command at all, so
 * the host launches the CLI itself and the sign-in is a step inside it). WHAT
 * the action says is copy, decided here: a generic sign-in framing by
 * default, overridden per provider where that framing is wrong.
 *
 * Two kinds of override. `TERMINAL_SIGN_IN_COPY` re-words the generic
 * sign-in for the launch-the-CLI providers: the default says the terminal
 * "prints a sign-in code", but what actually opens is the CLI's own UI, and
 * a user left in front of a TUI with no instruction is where that flow
 * stalls - so the first step names the thing to type. It stays the GENERIC
 * guidance in every other respect (no manual command, the same labels), so
 * an old host that declares no capability still shows nothing for them.
 *
 * Reasonix is the full override. The generic surfaces describe a sign-in: "Sign in
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
   * The first step on a start page whose host can open the terminal only
   * from an Epic (it negotiated the pre-scope `providers.startTerminalLogin`
   * major), naming that route. Distinct from `noSurfaceStep`, which also
   * names the start page - the one surface this host cannot open it from.
   */
  readonly epicOnlyStep: string;
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
    epicOnlyStep:
      "Open a chat and choose “Set up in terminal” from its model picker. This host's version can open Reasonix's setup wizard from a chat, but not from the start page.",
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
 * The sentences that differ for a provider whose sign-in terminal opens the
 * CLI itself rather than a login command. Each names the step the user takes
 * INSIDE that CLI, which is the one thing the generic copy cannot say.
 */
interface TerminalSignInCopy {
  readonly summary: string;
  /** Replaces the generic "Complete the sign-in in that terminal." step. */
  readonly firstStep: string;
  readonly terminalHint: string;
}

const TERMINAL_SIGN_IN_COPY: {
  readonly [k in ProviderId]?: TerminalSignInCopy;
} = {
  qwen: {
    summary: "Qwen Code signs in from inside its own terminal UI.",
    firstStep:
      "Type /auth in that terminal, choose a sign-in method and finish in the browser.",
    terminalHint:
      "Qwen Code opens in that terminal. Type /auth and complete the sign-in there, then use Refresh above.",
  },
  droid: {
    summary: "Droid signs in from inside its own terminal UI.",
    firstStep: "Follow the sign-in prompt Droid shows when it starts.",
    terminalHint:
      "Droid opens in that terminal and prompts you to sign in. Complete it there, then use Refresh above.",
  },
  omp: {
    summary:
      "Oh My Pi signs in from inside its own terminal UI, one provider account at a time.",
    firstStep:
      "Type login followed by the provider (for example login anthropic) in that terminal and follow the prompts.",
    terminalHint:
      "Oh My Pi opens in that terminal. Run login <provider> and complete the sign-in there, then use Refresh above.",
  },
  opencode: {
    summary:
      "OpenCode signs in from a terminal, one provider account at a time.",
    firstStep:
      "Pick the provider and sign-in method in that terminal and follow the prompts.",
    terminalHint:
      "OpenCode asks for the provider and sign-in method in that terminal. Complete it there, then use Refresh above.",
  },
};

/**
 * The generic terminal sign-in copy for a provider with no override. Reached
 * only through `providerTerminalGuidance`, which is what keeps the picker and
 * the banner describing one flow the same way. The launch-the-CLI providers re-word the
 * three sentences that would otherwise describe a sign-in code nothing prints
 * (`TERMINAL_SIGN_IN_COPY`) and keep everything else.
 */
export function defaultTerminalSignInGuidance(
  providerId: ProviderId,
): ProviderSetupGuidance {
  const name = PROVIDER_DISPLAY_NAMES[providerId];
  const copy = TERMINAL_SIGN_IN_COPY[providerId] ?? null;
  return {
    summary:
      copy?.summary ??
      `${name} signs in from a terminal: it prints a sign-in code that only exists there.`,
    stepsAfterAction: [
      copy?.firstStep ?? "Complete the sign-in in that terminal.",
      "Refresh this list.",
    ],
    noSurfaceStep:
      "Choose “Sign in from a terminal” from a chat's model picker or the start page's. It opens the sign-in on the host that composer runs on.",
    epicOnlyStep: `Open a chat and choose “Sign in from a terminal” from its model picker. This host's version can open the ${name} sign-in from a chat, but not from the start page.`,
    manualCommand: null,
    terminalActionLabel: "Sign in from a terminal",
    terminalHint:
      copy?.terminalHint ??
      `${name} prints a sign-in code that only exists in the terminal. Complete the sign-in there, then use Refresh above.`,
  };
}

/**
 * THE copy for a provider's terminal flow: its override if the table has one,
 * the generic sign-in copy otherwise.
 *
 * Every surface that renders a terminal action resolves through this - the
 * picker's setup CTA (via `resolveProviderTerminalSetup` below) and the
 * composer banner's `TerminalLoginRow`. The banner used to fall back to its
 * OWN inline copy of the generic sentences when the override table returned
 * `null`, which is the same two sentences written twice, and the copy
 * diverged the moment a provider needed different ones:
 * `TERMINAL_SIGN_IN_COPY` reached the picker and the banner went on telling a
 * Qwen user to read a sign-in code that nothing prints. A provider with no
 * terminal sign-in at all never reaches either surface - the capability gate
 * (`providerSupportsTerminalLogin`) decides that, not the copy.
 */
export function providerTerminalGuidance(
  providerId: ProviderId,
): ProviderSetupGuidance {
  return (
    providerSetupGuidance(providerId) ??
    defaultTerminalSignInGuidance(providerId)
  );
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
 * `state` is the `providers.list` row; while that has not resolved (`null`)
 * the capability answer is "not yet", never "no" - it re-resolves when the row
 * lands. It takes the whole row rather than `loginCapability` alone because a
 * second fact on the same row gates the SAME button: whether the provider's
 * managed pack would let the host spawn its CLI at all (`packPreparing`).
 */
export interface ProviderTerminalSetup {
  readonly guidance: ProviderSetupGuidance;
  /** Whether the connected host can open the sign-in terminal itself. */
  readonly canStartTerminal: boolean;
  /**
   * The pack state blocking that terminal RIGHT NOW, or `null`. Transient
   * where `canStartTerminal` is permanent: the host advertises the capability,
   * and will honour it once the download lands - so this is not folded into
   * `canStartTerminal`, whose `false` means "there is no button on this host
   * at all" and leads the copy with the manual route.
   */
  readonly packPreparing: ProviderPackPreparing | null;
}

export function resolveProviderTerminalSetup(
  providerId: ProviderId,
  state: ProviderCliState | null,
): ProviderTerminalSetup | null {
  const override = providerSetupGuidance(providerId);
  if (!providerSupportsTerminalLogin(state?.loginCapability)) {
    // No host-run terminal, so only a provider with its own manual route has
    // anything left to offer; the generic sign-in copy is all button.
    return override === null
      ? null
      : { guidance: override, canStartTerminal: false, packPreparing: null };
  }
  return {
    guidance: providerTerminalGuidance(providerId),
    canStartTerminal: true,
    packPreparing: providerTerminalLoginPackBlock(state),
  };
}

/**
 * What to render where the button would be while `packPreparing` blocks it -
 * the same "Preparing X… 43%" / "X setup failed - …" sentence every other
 * gated surface shows, so the picker cannot phrase the wait a fourth way.
 */
export function providerSetupPreparingLabel(
  setup: ProviderTerminalSetup,
  providerId: ProviderId,
): string | null {
  if (setup.packPreparing === null) return null;
  return providerPackPreparingLabel(
    setup.packPreparing,
    PROVIDER_DISPLAY_NAMES[providerId],
  );
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
  /**
   * No button this copy can vouch for: the host declares no terminal
   * sign-in, or there is no host to ask / its manifest is not recorded yet.
   * The manual command is the route; no claim is made about the machine.
   */
  | "unsupported-host"
  /**
   * A button on this host, but only in an Epic: the host negotiated the
   * pre-scope `providers.startTerminalLogin` major, which cannot carry the
   * scope the start page needs. The steps lead with that route - the
   * post-action steps alone would tell the user to finish in a terminal
   * nothing here can open, and the generic guidance has no manual command to
   * fall back on.
   */
  | "unsupported-scope"
  /**
   * A button here in principle, but the provider's pack cannot spawn yet. The
   * preparing label stands where the button would; the steps read as they do
   * for `here`, because that is what they will be once it lands.
   */
  | "preparing";

/**
 * Where this surface's action is, from the three facts that decide it. Shared
 * so the auth line and the model list cannot classify the same state
 * differently - the reason they were wrong about old hosts in the first place.
 *
 * `scopeSupport` is the third because the first two cannot see it: the
 * provider row says this provider HAS a terminal sign-in, and the surface says
 * where a button would go, but neither knows whether this host's negotiated
 * `providers.startTerminalLogin` can carry the scope that surface needs. On the
 * release just before the scope bump it cannot, and only for the landing
 * surface - so the same provider on the same host is `here` in an Epic and
 * `unsupported-scope` on the start page. See
 * `useProviderTerminalLoginScopeSupported`.
 */
export function providerSetupActionPlacement(
  setup: ProviderTerminalSetup,
  hasSurface: boolean,
  scopeSupport: ProviderTerminalLoginScopeSupport,
): ProviderSetupActionPlacement {
  // Permanent reasons first: a pack that will finish downloading does not
  // change a host that can never carry this scope.
  if (!setup.canStartTerminal) return "unsupported-host";
  // `unsupported-scope` leads the steps with "this host's version can open
  // the sign-in from a chat" - a claim only a RECORDED pre-scope manifest
  // proves. An unknown manifest, or no host at all, gets the claim-free copy.
  if (scopeSupport === "unknown") return "unsupported-host";
  if (scopeSupport === "unsupported") return "unsupported-scope";
  if (setup.packPreparing !== null) return "preparing";
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
  if (placement === "unsupported-scope") {
    return [guidance.epicOnlyStep, ...guidance.stepsAfterAction];
  }
  return guidance.stepsAfterAction;
}
