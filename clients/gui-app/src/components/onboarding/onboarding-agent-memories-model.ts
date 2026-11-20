import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { TraycerStanding } from "@/components/onboarding/onboarding-memory-save";

// The memory act's MODEL, apart from its components: fast refresh only keeps
// state for a module that exports components alone, and both the page and the
// stage read these.

/** How this act's last write of one provider's memories went. */
export interface ProviderMemoryOutcome {
  readonly kind: "saved" | "failed";
  /** The value it wrote, so a choice that has moved since is not answered by it. */
  readonly value: boolean;
}

/**
 * This act's last write of each provider's memories on one host. Kept apart
 * from the draft, like what the act knows of its Traycer write: turning
 * Traycer off or choosing on another host replaces the choices, and the host
 * still holds what was written.
 */
export type ProviderWrites = ReadonlyMap<ProviderId, ProviderMemoryOutcome>;
export const NO_PROVIDER_WRITES: ProviderWrites = new Map();

/**
 * Everything the memory act remembers across Back and Next. Held by the tour,
 * not the act, because the act unmounts on every step change.
 *
 * Nothing in here is written anywhere until Continue: showing the act, picking
 * a card and flipping switches only change this.
 */
export interface OnboardingMemoryDraft {
  /** The host these choices are for. A different host starts over. */
  readonly hostId: string | null;
  /** `null` until a card is picked; then the Traycer switch. */
  readonly traycer: boolean | null;
  /**
   * Only the switches the person has flipped. A provider with no entry is
   * off, which is what makes a newly selected provider start off exactly once
   * and an explicit choice survive any number of visits.
   */
  readonly providers: ReadonlyMap<ProviderId, boolean>;
  /**
   * The last save stopped on a read that failed, or found no configuration.
   * What it knows of its Traycer write is kept per configuration, outside
   * the draft, because it outlives the choices.
   */
  readonly traycerUnreached: boolean;
}

export function emptyMemoryDraft(hostId: string | null): OnboardingMemoryDraft {
  return {
    hostId,
    traycer: null,
    providers: new Map(),
    traycerUnreached: false,
  };
}

/**
 * The Traycer switch. Turning it off drops every provider choice made under
 * it: off is "leave my providers alone", never a request to turn their
 * memories back on.
 */
export function withTraycerChoice(
  draft: OnboardingMemoryDraft,
  traycer: boolean,
): OnboardingMemoryDraft {
  if (traycer) return { ...draft, traycer: true };
  return {
    ...draft,
    traycer: false,
    providers: new Map(),
    traycerUnreached: false,
  };
}

export function withProviderChoice(
  draft: OnboardingMemoryDraft,
  providerId: ProviderId,
  value: boolean,
): OnboardingMemoryDraft {
  const providers = new Map(draft.providers);
  providers.set(providerId, value);
  return { ...draft, providers };
}

/** One switch on the act: a selected provider whose memories this host can turn off. */
export interface OnboardingMemoryRow {
  readonly providerId: ProviderId;
  readonly name: string;
  /** The switch: `false` is "turn this provider's memories off". */
  readonly value: boolean;
  /**
   * What the host holds, as far as the act can tell: its own last write of
   * this provider once that landed, otherwise the host's provider list, where
   * `true` means Traycer applies no override. `null` when that write failed,
   * since the host may or may not have taken it.
   */
  readonly stored: boolean | null;
  /** The act's last write of this provider, while it is still about this value. */
  readonly outcome: ProviderMemoryOutcome | null;
}

/** Whether the provider half of the act can show its switches. */
export type ProviderMemoryControls =
  | "loading"
  | "failed"
  | "unsupported"
  | "ready";

export interface OnboardingMemoryRows {
  readonly rows: ReadonlyArray<OnboardingMemoryRow>;
  /**
   * Selected providers that get no switch, by name. The wire cannot say
   * whether that is a provider with no memories of its own or an installed
   * version Traycer cannot enforce the switch for, so the act says only that
   * their settings stay as they are.
   */
  readonly withoutSwitch: ReadonlyArray<string>;
}

/**
 * The rows for the providers the Providers act left SELECTED - enabled on
 * this host - whose memories the host says it can turn off. A provider that
 * is only detected is not selected, and Traycer's own provider has no
 * memories of its own to mention.
 */
export function memoryRowsFor(
  providers: ReadonlyArray<ProviderCliState>,
  draft: OnboardingMemoryDraft,
  writes: ProviderWrites,
): OnboardingMemoryRows {
  const rows: OnboardingMemoryRow[] = [];
  const withoutSwitch: string[] = [];
  for (const provider of providers) {
    if (!provider.enabled || provider.providerId === "traycer") continue;
    const name = PROVIDER_DISPLAY_NAMES[provider.providerId];
    if (provider.nativeMemorySupported !== true) {
      withoutSwitch.push(name);
      continue;
    }
    const value = draft.providers.get(provider.providerId) ?? false;
    const written = writes.get(provider.providerId) ?? null;
    rows.push({
      providerId: provider.providerId,
      name,
      value,
      stored: heldValue(provider, written),
      outcome: written?.value === value ? written : null,
    });
  }
  return { rows, withoutSwitch };
}

/**
 * A write of the act's own outranks the list: the list may be a read from
 * before that write, and the read its write asks for may not have landed yet
 * or may have failed.
 */
function heldValue(
  provider: ProviderCliState,
  written: ProviderMemoryOutcome | null,
): boolean | null {
  if (written === null) return provider.nativeMemory ?? true;
  return written.kind === "saved" ? written.value : null;
}

/**
 * Whether Continue still has to write this row: the choice differs from what
 * the host holds, or the act's last write of it failed and what the host
 * holds is unknown. A choice the host holds already is never resent.
 */
export function memoryRowNeedsWrite(row: OnboardingMemoryRow): boolean {
  return row.stored === null || row.value !== row.stored;
}

/** "A", "A and B", "A, B and C". */
export function joinProviderNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the act shows, derived from the draft and the host's two reads. */
export interface OnboardingMemoryView {
  /**
   * `null` while the cards are up, then the Traycer switch as shown - which
   * is on whenever the setting already is. The act never writes `false`, so
   * an off switch over an on setting would be a claim it cannot keep; a
   * choice made before the read arrived yields to the read.
   */
  readonly chosen: boolean | null;
  /**
   * Traycer memories in the configuration the host serves, as last read,
   * with what the act knows of its own write there. `null` before a read
   * names a configuration.
   */
  readonly traycerStanding: TraycerStanding | null;
  /**
   * The setting is on - from before, or by this act's own save - or this
   * act's change to it is held for the configuration or has not reached this
   * host yet. The act cannot take any of these back, so its switch cannot
   * offer to.
   */
  readonly traycerLocked: boolean;
  readonly rows: ReadonlyArray<OnboardingMemoryRow>;
  readonly withoutSwitch: ReadonlyArray<string>;
  /** The last save stopped short: a write failed, or Traycer's is not on yet. */
  readonly interrupted: boolean;
}

export function memoryViewFor(input: {
  readonly draft: OnboardingMemoryDraft;
  readonly traycerStanding: TraycerStanding | null;
  /** `undefined` until `providers.list` has answered. */
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  /** The act's provider writes on the host the draft is for. */
  readonly providerWrites: ProviderWrites;
  readonly providerControls: ProviderMemoryControls;
}): OnboardingMemoryView {
  const { draft, providerControls } = input;
  const listed =
    input.providers === undefined
      ? { rows: [], withoutSwitch: [] }
      : memoryRowsFor(input.providers, draft, input.providerWrites);
  // A host that cannot write the switch shows none: every selected provider
  // is then one whose settings stay as they are.
  const switchable = providerControls === "ready";
  const rows = switchable ? listed.rows : [];
  const withoutSwitch =
    providerControls === "unsupported"
      ? [...listed.rows.map((row) => row.name), ...listed.withoutSwitch]
      : listed.withoutSwitch;
  const standing = input.traycerStanding;
  // A held or unread change is on its way, not in this draft: turning the
  // switch off would neither withdraw it nor stop it landing.
  const traycerLocked =
    standing === "on" || standing === "held" || standing === "unconfirmed";
  const chosen = draft.traycer === null ? null : draft.traycer || traycerLocked;
  const traycerShort =
    draft.traycerUnreached ||
    (standing !== null && standing !== "on" && standing !== "off");
  // A provider's failure stops the act only where Traycer memories are on:
  // anywhere else the next save starts with Traycer's own write.
  const failedRow =
    standing === "on" && rows.some((row) => row.outcome?.kind === "failed");
  return {
    chosen,
    traycerStanding: standing,
    traycerLocked,
    rows,
    withoutSwitch,
    interrupted: chosen === true && (traycerShort || failedRow),
  };
}
