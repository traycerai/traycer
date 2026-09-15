import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * Page 1's tile model, pure and away from the markup: one `WelcomeTileModel`
 * per provider the page shows, derived from the host's `providers.list` row
 * (or its absence). The table this encodes is ticket 2.2's; the three
 * derivations at the top are ported from the deleted onboarding act, which
 * drew the same facts as list rows.
 */

export type WelcomeInstallState = "detected" | "missing" | "pending";

/** Whether the provider's CLI is on this machine, from the host's candidates. */
export function installStateFor(
  state: ProviderCliState | undefined,
): WelcomeInstallState {
  if (state === undefined) return "pending";
  if (state.candidates.some((candidate) => candidate.available)) {
    return "detected";
  }
  // The host raises `availabilityPending` while its shell-environment probe
  // runs; the candidates under-report until it lands, so nothing is
  // "missing" yet.
  if (state.availabilityPending) return "pending";
  if (state.candidates.some((candidate) => candidate.versionPending)) {
    return "pending";
  }
  return "missing";
}

export interface WelcomeAccountLine {
  readonly text: string;
  readonly tone: "good" | "muted";
  /** The long form, for a tooltip; `null` when the text is the whole story. */
  readonly title: string | null;
}

const TRAYCER_READY_LINE: WelcomeAccountLine = {
  text: "Ready with your Traycer subscription",
  tone: "good",
  title: null,
};

/** Mirrors Settings' `ProviderAuthLine`: the account as one short line. */
export function accountLineFor(state: ProviderCliState): WelcomeAccountLine {
  if (state.providerId === "traycer" && state.enabled) {
    return TRAYCER_READY_LINE;
  }
  if (!state.enabled) return { text: "Disabled", tone: "muted", title: null };
  const { auth } = state;
  if (state.authPending) {
    return { text: "Checking account…", tone: "muted", title: null };
  }
  if (auth.status === "authenticated") {
    return {
      text: auth.label ?? "Signed in",
      tone: "good",
      title: auth.detail,
    };
  }
  if (auth.status === "configured") {
    return {
      text: "Configured, not verified",
      tone: "muted",
      title: auth.detail,
    };
  }
  if (auth.status === "unavailable") {
    return {
      text: "Status check failed",
      tone: "muted",
      title: auth.detail,
    };
  }
  if (auth.status === "unauthenticated") {
    return { text: "Not signed in", tone: "muted", title: null };
  }
  if (state.apiKey.configured) {
    return { text: "API key set", tone: "good", title: null };
  }
  return { text: "Account status unavailable", tone: "muted", title: null };
}

/**
 * Whether flipping this switch off would leave the host with no provider at
 * all - the one toggle the page refuses. An unknown row cannot be the last
 * enabled one, because it is not known to be enabled.
 */
export function disablingLastEnabledFor(
  state: ProviderCliState | undefined,
  enabled: boolean,
  enabledProviderCount: number,
): boolean {
  if (state === undefined) return false;
  return enabled && enabledProviderCount <= 1;
}

export type WelcomeTileInstall =
  | WelcomeInstallState
  | "builtIn"
  | "unavailable";

export interface WelcomeTileModel {
  readonly providerId: ProviderId;
  readonly name: string;
  readonly install: WelcomeTileInstall;
  /** "Installed" | "Not found" | "Detecting…" | "Built in" | "Unavailable" */
  readonly badge: string;
  /** False while the row is unknown. */
  readonly enabled: boolean;
  /** Only a real account line (decision 22); never a placeholder. */
  readonly subtitle: string | null;
  readonly subtitleTone: "good" | "muted";
  /** The long-form state, for the tile's tooltip. */
  readonly tooltip: string | null;
  readonly switchDisabled: boolean;
  /** Identity pieces only (icon, name, badge) - never the switch. */
  readonly dimmed: boolean;
}

const BADGE_LABELS: Readonly<Record<WelcomeTileInstall, string>> = {
  detected: "Installed",
  missing: "Not found",
  pending: "Detecting…",
  builtIn: "Built in",
  unavailable: "Unavailable",
};

export const WELCOME_HOST_UNAVAILABLE_TOOLTIP =
  "Traycer can't reach this machine right now.";
export const WELCOME_TRAYCER_OFF_TOOLTIP =
  "Uses your Traycer subscription. Off until you turn it on.";
export const WELCOME_DETECTED_OFF_TOOLTIP =
  "Turn on to let Traycer check your account.";
export const WELCOME_UNAUTHENTICATED_TOOLTIP =
  "Not signed in. Sign in from Settings ▸ Providers.";

export function welcomeInstallTooltip(name: string): string {
  return `Install ${name} on this machine to use it.`;
}

/**
 * One tile per requested id, in the requested order, from whatever the host
 * has said so far.
 *
 * `hostUnavailable` is the caller's reading of the list query: a disabled
 * query (no host bound) never leaves `pending` with an idle fetch, and a
 * hard error leaves no data - both are "Unavailable", never an eternal
 * "Detecting…".
 */
export function buildWelcomeTiles(input: {
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly hostUnavailable: boolean;
  readonly ids: ReadonlyArray<ProviderId>;
}): ReadonlyArray<WelcomeTileModel> {
  const { providers, hostUnavailable, ids } = input;
  return ids.map((providerId) =>
    buildWelcomeTile(
      providerId,
      providers?.find((provider) => provider.providerId === providerId),
      hostUnavailable,
    ),
  );
}

function tile(input: {
  readonly providerId: ProviderId;
  readonly install: WelcomeTileInstall;
  readonly enabled: boolean;
  readonly subtitle: WelcomeAccountLine | null;
  readonly tooltip: string | null;
  readonly switchDisabled: boolean;
  readonly dimmed: boolean;
}): WelcomeTileModel {
  return {
    providerId: input.providerId,
    name: providerDisplayName(input.providerId),
    install: input.install,
    badge: BADGE_LABELS[input.install],
    enabled: input.enabled,
    subtitle: input.subtitle?.text ?? null,
    subtitleTone: input.subtitle?.tone ?? "muted",
    tooltip: input.tooltip,
    switchDisabled: input.switchDisabled,
    dimmed: input.dimmed,
  };
}

function buildWelcomeTile(
  providerId: ProviderId,
  state: ProviderCliState | undefined,
  hostUnavailable: boolean,
): WelcomeTileModel {
  const name = providerDisplayName(providerId);
  if (hostUnavailable) {
    return tile({
      providerId,
      install: "unavailable",
      enabled: state?.enabled ?? false,
      subtitle: null,
      tooltip: WELCOME_HOST_UNAVAILABLE_TOOLTIP,
      switchDisabled: true,
      dimmed: true,
    });
  }
  if (state === undefined) {
    return tile({
      providerId,
      install: "pending",
      enabled: false,
      subtitle: null,
      tooltip: null,
      switchDisabled: true,
      dimmed: true,
    });
  }
  if (providerId === "traycer") {
    // Built in: there is no CLI to find and no account to check - the
    // subscription IS the account, so it is CONNECTED whether or not it is
    // on (decision 26). The ready line stays in both states and nothing is
    // dimmed; the switch and the off tooltip are the only things that say
    // it is off.
    return tile({
      providerId,
      install: "builtIn",
      enabled: state.enabled,
      subtitle: TRAYCER_READY_LINE,
      tooltip: state.enabled ? null : WELCOME_TRAYCER_OFF_TOOLTIP,
      switchDisabled: false,
      dimmed: false,
    });
  }
  const install = installStateFor(state);
  if (install === "missing") {
    // Info-only (decision 3): a provider that is not on this machine cannot
    // be turned on from here, and offering the switch would invite a
    // failure. Settings owns installs and sign-ins.
    return tile({
      providerId,
      install,
      enabled: state.enabled,
      subtitle: null,
      tooltip: welcomeInstallTooltip(name),
      switchDisabled: true,
      dimmed: true,
    });
  }
  if (install === "pending") {
    return tile({
      providerId,
      install,
      enabled: state.enabled,
      subtitle: null,
      tooltip: null,
      switchDisabled: true,
      dimmed: true,
    });
  }
  if (!state.enabled) {
    return tile({
      providerId,
      install,
      enabled: false,
      subtitle: null,
      tooltip: WELCOME_DETECTED_OFF_TOOLTIP,
      switchDisabled: false,
      dimmed: true,
    });
  }
  return tile({
    providerId,
    install,
    enabled: true,
    subtitle: enabledSubtitle(state),
    tooltip: enabledTooltip(state),
    switchDisabled: false,
    dimmed: false,
  });
}

/**
 * Decision 22: the subtitle is a REAL account line or nothing - the label
 * the host attached to an authenticated account, and only that. A generic
 * "Signed in" with no label, "Checking account…", "Not signed in",
 * "Configured, not verified" and the rest are status text that belongs in
 * the tooltip, where it does not read as a call to action on a page that
 * offers none.
 */
function enabledSubtitle(state: ProviderCliState): WelcomeAccountLine | null {
  if (state.authPending) return null;
  if (state.auth.status !== "authenticated") return null;
  if (state.auth.label === null) return null;
  return accountLineFor(state);
}

function enabledTooltip(state: ProviderCliState): string | null {
  const line = accountLineFor(state);
  if (state.authPending) return line.text;
  if (state.auth.status === "authenticated") {
    // With a label the subtitle already says who; the tooltip adds the
    // detail if there is one. Without a label the tooltip is the only place
    // the account is described at all.
    if (state.auth.label !== null) return state.auth.detail;
    return state.auth.detail ?? line.text;
  }
  if (state.auth.status === "unauthenticated") {
    return WELCOME_UNAUTHENTICATED_TOOLTIP;
  }
  return line.text;
}
