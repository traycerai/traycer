import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
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
  const labelProviderId = guiHarnessIdToProviderId(harnessId);
  return {
    // A harness outside `ORDERED_PROVIDERS` has no display name to give, so
    // the harness id is the honest fallback rather than a blank chip. This is
    // the degradation for a future harness, not a case a user meets today.
    providerLabel:
      labelProviderId === null
        ? harnessId
        : providerDisplayName(labelProviderId),
    profileLabel: labelFor(tuple.profileId),
    harnessId,
    model: tuple.model,
    providerId: providerCliIdForHarness(harnessId),
  };
}
