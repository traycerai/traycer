import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatRunSettings,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { FallbackModelTarget } from "@traycer/protocol/host/chat-fallback";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  ORDERED_PROVIDERS,
  guiHarnessIdToProviderId,
  providerCliIdForHarness,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The shipped name for the ambient (unnamed) profile.
 *
 * The vocabulary table fixes this: "Terminal account", never "ambient",
 * "default profile", or a blank. It is a real account with a real identity - it
 * simply has no user-given name - so the surfaces name it rather than leaving a
 * gap where every other row has a chip.
 */
export const TERMINAL_ACCOUNT_LABEL = "Terminal account";

/**
 * How much of a profile id stands in for a label that cannot be resolved.
 *
 * Mirrors the host's `FALLBACK_PROFILE_ID_PREFIX_LENGTH` (D118). Kept in step
 * deliberately: the same profile can be named by a host-written transcript
 * notice and by a card rendered here, and two different truncations of one id
 * read as two different accounts.
 */
const PROFILE_ID_PREFIX_LENGTH = 8;

/**
 * The label map for one providers read, as a pure function.
 *
 * Split out of {@link useFallbackProfileLabels} so a surface that ALREADY holds
 * a providers read can apply this rule without taking a second one - Settings ▸
 * Fallback's per-row preview is the case (D190). Pulling it out rather than
 * restating it in the other tree is the whole point: two implementations of the
 * disambiguation would be two ways to name one account, and two truncations of
 * one id read as two different accounts.
 */
export function buildFallbackProfileLabels(
  providers: ResponseOfMethod<HostRpcRegistry, "providers.list">["providers"],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const provider of providers) {
    const perLabel = new Map<string, number>();
    for (const profile of provider.profiles) {
      perLabel.set(profile.label, (perLabel.get(profile.label) ?? 0) + 1);
    }
    for (const profile of provider.profiles) {
      if (profile.kind === "ambient") continue;
      const shared = (perLabel.get(profile.label) ?? 0) > 1;
      labels.set(
        profile.profileId,
        shared
          ? `${profile.label} [${profile.profileId.slice(0, PROFILE_ID_PREFIX_LENGTH)}]`
          : profile.label,
      );
    }
  }
  return labels;
}

/**
 * One id against a built map, with the host's own degradation.
 *
 * An unresolvable id becomes a short PREFIX rather than the full identifier
 * (D118): a profile deleted mid-traversal still has to be named on the surface
 * describing it, and a prefix stays recognisable against Settings without
 * printing a raw uuid at a person.
 */
export function resolveFallbackProfileLabel(
  labels: ReadonlyMap<string, string>,
  profileId: string,
): string {
  return labels.get(profileId) ?? profileId.slice(0, PROFILE_ID_PREFIX_LENGTH);
}

/**
 * Profile id -> the name a card shows for it.
 *
 * Takes only the id: profile ids are unique across providers, so a provider
 * argument would be a parameter the implementation ignores - and one that a
 * caller could get wrong without anything noticing.
 */
export type FallbackProfileLabelResolver = (profileId: string | null) => string;

/**
 * Provider display names keyed by the WIRE id, as a map.
 *
 * The `fallback-wait` background row carries `providerId` as an open `string`
 * (`subscribe.ts`), for the same reason the traversal's `reason` is one: a
 * strict enum on a field that is only ever rendered as a label would fail the
 * whole frame on a provider a released client has not heard of. Indexing
 * `Record<ProviderId, string>` with that string is the cast the type-safety
 * table forbids, so the lookup goes through a map whose key type is `string`
 * by construction - built from `ORDERED_PROVIDERS`, which is exhaustive over
 * `ProviderId`, and through `providerDisplayName` so this agrees with
 * {@link fallbackTupleIdentity} rather than diverging on `traycer`.
 *
 * An unrecognised id degrades to itself. That is deliberately NOT the reason
 * label's `null`: a label the card can omit is optional, but the account being
 * waited on is the row's whole subject, and a row titled "Waiting for 's
 * limit" is worse than one naming an id the user can at least recognise.
 */
const PROVIDER_LABEL_BY_WIRE_ID: ReadonlyMap<string, string> = new Map(
  ORDERED_PROVIDERS.map((provider) => [
    provider.providerId,
    providerDisplayName(provider.providerId),
  ]),
);

export function fallbackProviderLabelFor(providerId: string): string {
  return PROVIDER_LABEL_BY_WIRE_ID.get(providerId) ?? providerId;
}

/**
 * A known harness, from the open `harnessId` string a destination row carries.
 *
 * `fallbackModelTargetSchema.harnessId` is `z.string()` on the wire - the same
 * deliberate openness the reason and provider fields have - so it cannot be
 * handed to anything typed `GuiHarnessId` without the cast the type-safety
 * table forbids. Resolving it through `ORDERED_PROVIDERS` returns the TYPED id
 * when the harness is one this build knows, which is what lets a row render the
 * provider glyph, and `null` when it is not.
 *
 * A caller that only needs the words uses {@link fallbackHarnessLabelFor},
 * which degrades to the id itself: a row saying `some-new-harness · sonnet` is
 * recognisable, and a row with a blank where the provider goes is not.
 */
export function fallbackKnownHarnessFor(
  harnessId: string,
): FallbackTupleIdentity["harnessId"] | null {
  return (
    ORDERED_PROVIDERS.find((provider) => provider.harnessId === harnessId)
      ?.harnessId ?? null
  );
}

export function fallbackHarnessLabelFor(harnessId: string): string {
  const known = ORDERED_PROVIDERS.find(
    (provider) => provider.harnessId === harnessId,
  );
  return known === undefined
    ? harnessId
    : providerDisplayName(known.providerId);
}

/**
 * The provider display name for a GUI harness - "Claude Code", never `claude`.
 *
 * Pulled out of {@link fallbackTupleIdentity} so a surface that needs the words
 * and nothing else can have them without a providers read: the account label is
 * what forces that query, and a sentence about a MODEL does not name an
 * account. Same rule, one definition, so a card cannot call one provider two
 * things.
 */
function fallbackProviderLabelForHarness(harnessId: GuiHarnessId): string {
  const providerId = guiHarnessIdToProviderId(harnessId);
  // A harness outside `ORDERED_PROVIDERS` has no display name to give, so the
  // harness id is the honest fallback rather than a blank. This is the
  // degradation for a future harness, not a case a user meets today.
  return providerId === null ? harnessId : providerDisplayName(providerId);
}

/**
 * "Claude Code · default" - a chat's provider and model, and nothing else.
 *
 * The subject of every sentence about what a chat IS rather than where it is
 * going: the error card's explanation of a withheld switch, and the destination
 * menu's empty state. Deliberately WITHOUT the account and without the effort
 * that {@link fallbackDestinationRowTitle} and
 * {@link fallbackDestinationSentence} carry - "No other model is set up for
 * Claude Code · opus · high on work" reads as a claim about that account at
 * that effort, when the fact is about the model.
 *
 * One function for both surfaces on purpose. They are explaining one host
 * verdict, and the rule this file exists to enforce is that two surfaces
 * describing one thing must not describe it in two ways.
 */
export function fallbackProviderModelLabel(tuple: ChatRunSettings): string {
  return `${fallbackProviderLabelForHarness(tuple.harnessId)} · ${tuple.model}`;
}

export interface FallbackTupleIdentity {
  /** "Claude Code" - `PROVIDER_DISPLAY_NAMES`, never a harness id. */
  readonly providerLabel: string;
  /** The profile's label, "Terminal account", or a short id prefix. */
  readonly profileLabel: string;
  readonly harnessId: GuiHarnessId;
  readonly model: string;
  /** `null` for a harness with no provider CLI - the chip degrades to the model. */
  readonly providerId: ProviderId | null;
}

/**
 * Resolves profile ids to labels for one host.
 *
 * Returns a FUNCTION rather than a resolved value because the surfaces resolve
 * several tuples from one providers read - the grace card's failed and target
 * tuples, the return banner's preferred and fallback pair, a menu's worth of
 * rows - and a hook per tuple would issue a query per chip.
 *
 * Unresolvable ids degrade to a short PREFIX, matching the host's own rule
 * (D118): a profile the user deleted mid-traversal still has to be named on the
 * card that is describing it, and a prefix stays recognisable against Settings
 * without printing a full identifier into the UI. Duplicate labels are
 * disambiguated the same way the host does, so a chat showing two accounts
 * called "work" can tell them apart.
 */
export function useFallbackProfileLabels(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): FallbackProfileLabelResolver {
  const providers = useProvidersListForClient(client, {
    enabled,
    subscribed: enabled,
  });
  const data = providers.data;
  // Built once per providers read rather than per chip: a menu resolves one
  // label per row, and re-walking every provider's profile array for each of
  // them is the accidental O(rows x profiles) the memo exists to avoid.
  const byId = useMemo(
    () =>
      data === undefined
        ? new Map<string, string>()
        : buildFallbackProfileLabels(data.providers),
    [data],
  );

  return useMemo(
    () =>
      (profileId: string | null): string =>
        profileId === null
          ? TERMINAL_ACCOUNT_LABEL
          : resolveFallbackProfileLabel(byId, profileId),
    [byId],
  );
}

/**
 * A DESTINATION as every fallback surface names it.
 *
 * One description feeding a menu row's title, a card's headline and the
 * transcript announcer's sentence, because those three were saying different
 * things about one place. The card said "Switching to Terminal account" - an
 * account name with no provider and no model - while the menu row beside it
 * said `Codex · gpt`, the equivalence-group FAMILY rather than the model the
 * click would actually launch. A user could not tell from either which model
 * they were about to run, and the two surfaces disagreed about the same row.
 */
export interface FallbackDestinationDescription {
  /** "Claude Code" - `PROVIDER_DISPLAY_NAMES`, never a harness id. */
  readonly providerLabel: string;
  /** The profile's label, "Terminal account", or a short id prefix. */
  readonly profileLabel: string;
  /** The RESOLVED slug when the host resolved one; the family when it did not. */
  readonly modelLabel: string;
  /**
   * Whether {@link modelLabel} is a family rather than a resolved slug.
   *
   * Carried rather than inferred from the string, because the two are
   * indistinguishable by inspection - `gpt-5`'s family is `gpt-5` - and a
   * surface that wanted to qualify an unresolved name would have no way to
   * know it needed to.
   */
  readonly modelIsFamily: boolean;
  /** The effort as it was configured, or `null` when the tuple carries none. */
  readonly effortLabel: string | null;
}

/**
 * The effort a tuple actually carries, or `null`.
 *
 * Trimmed-and-emptied-to-null exactly as `resolveAgentReasoningLabel`'s own
 * normalisation does, and rendered RAW rather than through that resolver: the
 * resolver needs a model-catalog context these surfaces do not have, and its
 * own answer with no catalog entry is this same string. Matching its fallback
 * keeps a card and the turn footer from naming one effort two ways.
 */
function normalizedEffort(reasoningEffort: string | null): string | null {
  if (reasoningEffort === null) return null;
  const trimmed = reasoningEffort.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A committed run tuple as a destination - the card's and the announcer's side.
 *
 * A tuple's `model` IS resolved by construction: it is what the engine will
 * launch. So `modelIsFamily` is always false here, and the asymmetry with
 * {@link fallbackDestinationOfModelTarget} is the point rather than an
 * oversight - only a menu candidate can still be unresolved.
 */
export function fallbackDestinationOfTuple(
  tuple: ChatRunSettings,
  labelFor: FallbackProfileLabelResolver,
): FallbackDestinationDescription {
  const identity = fallbackTupleIdentity(tuple, labelFor);
  return {
    providerLabel: identity.providerLabel,
    profileLabel: identity.profileLabel,
    modelLabel: identity.model,
    modelIsFamily: false,
    effortLabel: normalizedEffort(tuple.reasoningEffort),
  };
}

/**
 * A `listTargets` equivalent-model row as a destination - the menu's side.
 *
 * Prefers the resolved `model` and falls back to `modelFamily`, which is the
 * whole of F7's rule: the row used to title itself with the family
 * unconditionally, so a group named `gpt` resolving to `gpt-6-astra` offered a
 * click whose model the user never saw. Effort comes from the row's own
 * `reasoningEffort`, which the engine re-derived against the DESTINATION's
 * catalog - never from the failed tuple, which may not have an equivalent
 * there at all.
 */
export function fallbackDestinationOfModelTarget(
  target: FallbackModelTarget,
  labelFor: FallbackProfileLabelResolver,
): FallbackDestinationDescription {
  const model = target.model;
  return {
    providerLabel: fallbackHarnessLabelFor(target.harnessId),
    profileLabel: labelFor(target.profileId),
    modelLabel: model ?? target.modelFamily,
    modelIsFamily: model === null,
    effortLabel: normalizedEffort(target.reasoningEffort),
  };
}

/**
 * "Codex · gpt-6-astra · high" - a destination menu row's title.
 *
 * The provider is always named here even though the section heading groups
 * these rows, because the heading says "Equivalent models" and not which
 * provider each one lives on; two rows from two providers are otherwise
 * distinguishable only by their glyph, which is decorative.
 */
export function fallbackDestinationRowTitle(
  destination: FallbackDestinationDescription,
): string {
  return [
    destination.providerLabel,
    destination.modelLabel,
    destination.effortLabel,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * "Codex · gpt-6-astra · high on Terminal account" - the one sentence a card
 * headline and the transcript announcer both name a destination with.
 *
 * `includeProvider` is the caller's fact, not this function's: only the caller
 * knows what the chat is moving FROM. A same-provider account switch reading
 * "Claude Code · … on work" would put the provider in front of a user for whom
 * nothing about the provider changed, and a cross-provider one that omitted it
 * would hide the only part that did.
 */
export function fallbackDestinationSentence(
  destination: FallbackDestinationDescription,
  includeProvider: boolean,
): string {
  const identity = [
    includeProvider ? destination.providerLabel : null,
    destination.modelLabel,
    destination.effortLabel,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return `${identity} on ${destination.profileLabel}`;
}

/**
 * Which pending offer a sentence is being asked for.
 *
 * A union rather than two functions because the announcer wants one call and
 * one dedupe key, and because the two share every rule that matters: the
 * destination is named the same way, and the provider clause appears iff the
 * chat is crossing providers. What differs is only which tuple is the source
 * and which is the destination - and for a return those are the exact reverse
 * of the forward switch.
 */
export type FallbackIdentitySubject =
  | { readonly kind: "fallback"; readonly pending: PendingFallback }
  | { readonly kind: "return"; readonly pending: PendingReturn };

/**
 * The resolved-identity sentence for a pending fallback or a return offer.
 *
 * The SAME string the grace card's headline renders, which is the point of
 * exporting it: an announcement that named a destination differently from the
 * row the user is looking at would be a second voice describing one event.
 *
 * `null` for a fallback the host has not named a destination for yet - a hold
 * whose candidate walk is still running, or a `notify` rung with nowhere to go.
 * A return always has one: the preferred tuple is where the chat came from.
 */
export function fallbackResolvedIdentitySentence(
  subject: FallbackIdentitySubject,
  labelFor: FallbackProfileLabelResolver,
): string | null {
  const pair =
    subject.kind === "return"
      ? {
          source: subject.pending.fallbackTuple,
          destination: subject.pending.preferredTuple,
        }
      : {
          source: subject.pending.failedTuple,
          destination: pendingFallbackDestinationTuple(subject.pending),
        };
  if (pair.destination === null) return null;
  return fallbackDestinationSentence(
    fallbackDestinationOfTuple(pair.destination, labelFor),
    pair.destination.harnessId !== pair.source.harnessId,
  );
}

/**
 * Where a pending fallback is heading, or `null`.
 *
 * The COMMITTED target first, the host's PREDICTION second, and the order is
 * the contract rather than a preference: `targetTuple` is written once a
 * destination is settled (by the user's pick or the engine's own commit),
 * while `impendingAction.target` is what the host expects to do when the
 * window ends. Once a destination is settled both carry it, so the fallback
 * only ever supplies an answer where there would otherwise be none.
 *
 * That "otherwise none" was the whole of the cancel window until the host
 * began publishing a plan: the frame carried `targetTuple: null` for the
 * entire hold, because the engine resolved and committed only after expiry -
 * so a card could count down at the user without ever saying what it was
 * counting down to.
 *
 * The single place that decision is made, so the card, the menu and the
 * transcript announcer cannot end up naming three different destinations.
 */
function pendingFallbackDestinationTuple(
  pending: PendingFallback,
): ChatRunSettings | null {
  if (pending.targetTuple !== null) return pending.targetTuple;
  const impending = pending.impendingAction;
  return impending === null ? null : impending.target;
}

/**
 * Whether a pending fallback is RESUMING the tuple that failed rather than
 * moving the chat off it.
 *
 * The wait rung's resume is the pending fallback shaped like that: once the
 * reset arrives, the host commits the FAILED tuple as the target and runs the
 * same switching phases a move runs, so `switching` names a destination that is
 * where the chat already is. Every surface that said "Switching to …" off that
 * destination told the user the chat had moved to the model it never left.
 *
 * The host's sameness rule - provider, model and account, the triple the
 * restamps select by - applied to the destination
 * {@link pendingFallbackDestinationTuple} names, so this cannot disagree with
 * the sentence it stands in for about which tuple is the destination.
 */
export function pendingFallbackResumesFailedTuple(
  pending: PendingFallback,
): boolean {
  const destination = pendingFallbackDestinationTuple(pending);
  if (destination === null) return false;
  const failed = pending.failedTuple;
  return (
    destination.harnessId === failed.harnessId &&
    destination.model === failed.model &&
    destination.profileId === failed.profileId
  );
}

/**
 * A run tuple as a card names it.
 *
 * Pure, taking the label resolver as an argument, so one providers read serves
 * every tuple a surface renders and so this is testable without a host.
 */
export function fallbackTupleIdentity(
  tuple: ChatRunSettings,
  labelFor: FallbackProfileLabelResolver,
): FallbackTupleIdentity {
  const harnessId = tuple.harnessId;
  // Two questions, deliberately answered by two different projections. The
  // LABEL asks "what do we call this provider", and every shipped harness has
  // an answer - `traycer` included, which is why the total projection is the
  // one that feeds it. `providerId` asks "is there a provider-CLI account
  // behind this", which is what the sign-in affordance routes on, and there
  // the honest answer for `traycer` is no. Reading one from the other would
  // either print a harness id in the copy or offer a sign-in that leads
  // nowhere.
  return {
    providerLabel: fallbackProviderLabelForHarness(harnessId),
    profileLabel: labelFor(tuple.profileId),
    harnessId,
    model: tuple.model,
    providerId: providerCliIdForHarness(harnessId),
  };
}
