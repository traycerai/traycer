import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";

// The memory act's MODEL, apart from its components: fast refresh only keeps
// state for a module that exports components alone, and both the page and the
// stage read these.

/** How far the Traycer memories write got. */
export type TraycerMemoryOutcome =
  | { readonly kind: "saved" }
  /**
   * The host is holding the edit with no connection to the configuration, so
   * it is in force nowhere yet. `uploadId` is how `environment.status` names
   * it later; a retry looks for it there instead of sending it again.
   */
  | {
      readonly kind: "queued";
      readonly uploadId: string | null;
      readonly environmentId: string;
    }
  | { readonly kind: "failed"; readonly refused: boolean };

/** How the last write of one provider's memories went. */
export interface ProviderMemoryOutcome {
  readonly kind: "saved" | "failed";
  /** The value it wrote, so a choice that has moved since is not answered by it. */
  readonly value: boolean;
}

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
  readonly traycerOutcome: TraycerMemoryOutcome | null;
  readonly providerOutcomes: ReadonlyMap<ProviderId, ProviderMemoryOutcome>;
}

export function emptyMemoryDraft(hostId: string | null): OnboardingMemoryDraft {
  return {
    hostId,
    traycer: null,
    providers: new Map(),
    traycerOutcome: null,
    providerOutcomes: new Map(),
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
    traycerOutcome: null,
    providerOutcomes: new Map(),
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
  /** What the host holds now. `true` means Traycer applies no override. */
  readonly stored: boolean;
  /** The last write's outcome, while it is still about this value. */
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
    const outcome = draft.providerOutcomes.get(provider.providerId) ?? null;
    rows.push({
      providerId: provider.providerId,
      name,
      value,
      stored: provider.nativeMemory ?? true,
      outcome: outcome?.value === value ? outcome : null,
    });
  }
  return { rows, withoutSwitch };
}

/**
 * Whether Continue still has to write this row: the choice differs from what
 * the host holds and no write of this value has landed. A choice that matches
 * the host already is never resent.
 */
export function memoryRowNeedsWrite(row: OnboardingMemoryRow): boolean {
  return row.value !== row.stored && row.outcome?.kind !== "saved";
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
  /** The setting is on, from before or by this act's own save. */
  readonly traycerLocked: boolean;
  readonly rows: ReadonlyArray<OnboardingMemoryRow>;
  readonly withoutSwitch: ReadonlyArray<string>;
  /** The last save stopped short: a write failed, or Traycer's is held. */
  readonly interrupted: boolean;
}

export function memoryViewFor(input: {
  readonly draft: OnboardingMemoryDraft;
  /** The host reads Traycer memories as on for its configuration. */
  readonly alreadyOn: boolean;
  /** `undefined` until `providers.list` has answered. */
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly providerControls: ProviderMemoryControls;
}): OnboardingMemoryView {
  const { draft, providerControls } = input;
  const listed =
    input.providers === undefined
      ? { rows: [], withoutSwitch: [] }
      : memoryRowsFor(input.providers, draft);
  // A host that cannot write the switch shows none: every selected provider
  // is then one whose settings stay as they are.
  const switchable = providerControls === "ready";
  const rows = switchable ? listed.rows : [];
  const withoutSwitch =
    providerControls === "unsupported"
      ? [...listed.rows.map((row) => row.name), ...listed.withoutSwitch]
      : listed.withoutSwitch;
  const traycerLocked =
    input.alreadyOn || draft.traycerOutcome?.kind === "saved";
  const chosen = draft.traycer === null ? null : draft.traycer || traycerLocked;
  const traycerShort =
    draft.traycerOutcome !== null && draft.traycerOutcome.kind !== "saved";
  const failedRow = rows.some((row) => row.outcome?.kind === "failed");
  return {
    chosen,
    traycerLocked,
    rows,
    withoutSwitch,
    interrupted: chosen === true && (traycerShort || failedRow),
  };
}
