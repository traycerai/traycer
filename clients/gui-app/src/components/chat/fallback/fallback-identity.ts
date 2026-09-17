import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatRunSettings,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { FallbackModelTarget } from "@traycer/protocol/host/chat-fallback";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  ORDERED_PROVIDERS,
  guiHarnessIdToProviderId,
  providerCliIdForHarness,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostQueries } from "@/hooks/host/use-host-queries";
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
 *
 * `modelLabelFor` is REQUIRED rather than optional, and that is the whole point
 * of the parameter: an optional resolver is a raw slug by default, and the
 * default is what every call site quietly took. The sentence this builds sits
 * beside cards that already resolve their models
 * ({@link fallbackTupleIdentity}), so a chat named "Claude Fable" on the card
 * and "claude-fable-5-1[1m]" in the menu underneath it is exactly the
 * disagreement this module exists to prevent.
 */
export function fallbackProviderModelLabel(
  tuple: ChatRunSettings,
  modelLabelFor: FallbackModelLabelResolver,
): string {
  const providerLabel = fallbackProviderLabelForHarness(tuple.harnessId);
  return `${providerLabel} · ${modelLabelFor(tuple.harnessId, tuple.model)}`;
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
 * Resolves a run tuple's model SLUG to the catalogue label a user recognises.
 *
 * `(harnessId, model) => label` - "claude-fable-5-1[1m]" becomes "Claude
 * Fable". Returns the slug unchanged when nothing can say otherwise, which is
 * the only honest degradation: a harness the user has since disabled, a cold
 * catalogue slot, a model the provider has dropped. A slug is ugly; a blank or
 * an invented name is wrong.
 */
export type FallbackModelLabelResolver = (
  harnessId: string,
  model: string,
) => string;

/**
 * The pair of resolvers every routing surface needs to name a tuple.
 *
 * They always travel together - an account label with a raw model slug beside
 * it is exactly the half-resolved state this pairing exists to prevent - so
 * helpers that take both take this rather than two positional arguments.
 */
export interface FallbackIdentityResolvers {
  readonly labelFor: FallbackProfileLabelResolver;
  readonly modelLabelFor: FallbackModelLabelResolver;
}

const NO_MODEL_HARNESSES: readonly GuiHarnessId[] = [];

/** One harness's model catalogue, as `agent.gui.listModels` answers it. */
type GuiModelCatalogue = ResponseOfMethod<
  HostRpcRegistry,
  "agent.gui.listModels"
>["models"];

/** What one harness's catalogue read has produced so far. */
interface ModelCatalogueRead {
  readonly models: GuiModelCatalogue | undefined;
  /**
   * Loaded, or failed and not coming - never "still in flight".
   *
   * SETTLED rather than loaded, and the distinction is a bound rather than a
   * nicety. The only caller that asks is one that must decide whether WAITING
   * would help, and a catalogue whose read failed will never resolve; a caller
   * that waited for "loaded" would wait forever and say nothing at all. Failed
   * counts as settled, that caller proceeds with the raw slug, and the user is
   * told something true rather than left in silence.
   */
  readonly settled: boolean;
}

/**
 * The two questions a surface can ask of a set of model catalogues.
 *
 * Almost every caller wants only the first and takes {@link
 * useFallbackModelLabels}: a card renders whatever is resolved now and
 * repaints when more arrives, so "not yet" costs it nothing.
 *
 * `settledFor` exists for the one surface that cannot repaint - the transcript
 * announcer CONSUMES a confirmed manual switch, advancing a sequence counter so
 * the event is never observed again, which makes whatever name it held at that
 * instant the name that user hears permanently.
 */
export interface FallbackModelCatalogues {
  readonly labelFor: FallbackModelLabelResolver;
  /** Whether this harness's catalogue has settled. Unasked-for ids are settled. */
  readonly settledFor: (harnessId: string) => boolean;
}

/**
 * Every harness a pending fallback can NAME a model for. Three, not two.
 *
 * The account that failed, where the chat has BEEN moved (`targetTuple`), and
 * where it is still only PLANNED to move (`impendingAction.target`). That third
 * one is the whole cancellation window: the host writes `targetTuple` only once
 * a destination is committed, so throughout the grace hold - exactly while the
 * user is deciding - the destination exists only as the planned tuple. A
 * subject list without it leaves that catalogue unsubscribed and the planned
 * model named by its raw slug for the entire window it is being approved in.
 *
 * Shared rather than spelled out per caller because the card and the transcript
 * announcer must name the same places; two hand-written lists is how one of
 * them silently ends up a tuple short, which is the bug this replaced.
 */
export function pendingFallbackHarnessSubjects(
  pending: PendingFallback,
): ReadonlyArray<string | null> {
  return [
    pending.failedTuple.harnessId,
    pending.targetTuple?.harnessId ?? null,
    pending.impendingAction?.target?.harnessId ?? null,
  ];
}

/**
 * Resolves model slugs to catalogue labels for the tuples one surface renders.
 *
 * ## Why this exists
 *
 * Every routing surface printed `tuple.model` raw, so a countdown card read
 * "Switching to claude-fable-5-1[1m] · medium on Simar Personal" - a provider's
 * internal identifier, bracket suffix and all, in a sentence a user is supposed
 * to make a decision from. The settings page has resolved slugs to labels since
 * it shipped (`catalogModelForFamily(models, resolved)?.label`); the chat
 * surfaces simply never did, so one product named one model two ways depending
 * on which screen you were looking at.
 *
 * ## Shape
 *
 * A resolver FUNCTION, exactly like {@link useFallbackProfileLabels} beside it,
 * and for the same reason: a surface names several tuples from one read - the
 * countdown card's failed and target pair, the return banner's preferred and
 * fallback pair, a menu's worth of rows - and a hook per tuple would issue a
 * query per chip.
 *
 * ## Cost
 *
 * One `agent.gui.listModels` per DISTINCT harness named in `tuples`, which is
 * one or two in practice and never the rail. It rides the shared cache slot the
 * app-load prefetcher already fills with the same cache-only contract
 * (`staleTime`/`gcTime: Infinity`), so on a warm host this adds no request at
 * all - this is the "label surfaces warming their one subject harness" lane the
 * catalogue module documents, widened only to the two subjects a hop has.
 *
 * Gated on AVAILABILITY as that lane requires: a failed tuple is durable and
 * can name a harness the user has since disabled or never installed, and an
 * availability-blind read would hit that provider's `listModels` and retry the
 * failure on every mount of the card.
 */
export function useFallbackModelCatalogues(
  client: HostClient<HostRpcRegistry> | null,
  /**
   * The harnesses whose catalogues this surface needs, `null` entries ignored.
   *
   * Harness IDS rather than tuples, because that is all the hook reads and a
   * caller does not always hold a tuple: the transcript announcer resolves its
   * subjects inside an effect event, off live store state, so it subscribes to
   * the ids it needs and never assembles an array of tuples at render.
   */
  harnessIdsInPlay: ReadonlyArray<string | null>,
  enabled: boolean,
): FallbackModelCatalogues {
  const harnessesQuery = useGuiHarnessesQueryForClient(client, {
    enabled,
    subscribed: enabled,
  });
  const available = harnessesQuery.data?.harnesses;

  // The wanted harnesses as a stable STRING, computed every render rather than
  // memoised on `tuples`.
  //
  // `tuples` is a fresh array literal at most call sites - a card assembles it
  // from its own props each render - so a memo keyed on it would rebuild on
  // every frame anyway, and keying a memo on a value DERIVED from it is the
  // shape that needs a lint suppression. Deriving the string directly is both
  // honest and cheaper: it is a set over one to three ids, and the string is
  // what the memos below actually depend on. A harness id is an enum slug and
  // cannot contain a space, so the join and split are exact inverses.
  const wantedKey = [
    ...new Set(harnessIdsInPlay.flatMap((id) => (id === null ? [] : [id]))),
  ]
    .sort()
    .join(" ");

  const harnessIds = useMemo<readonly GuiHarnessId[]>(() => {
    if (available === undefined || wantedKey === "") return NO_MODEL_HARNESSES;
    // `available && enabled`, not `available` alone. The two are separate wire
    // fields and a DISABLED harness can still report itself available, so the
    // bare check let one into `requests` and issued `listModels` against a
    // provider the user had switched off. That is not merely a wasted call:
    // `useGuiHarnessModelsWarmup`'s contract spells out the consequence - an
    // errored query refetches on the next enabled mount, so the failure retries
    // for as long as the surface keeps mounting. `available && enabled` is also
    // exactly how the catalog itself defines a settled-usable row
    // (`lastSettledAvailable`), so this agrees with its own source.
    //
    // The cost is accepted and documented in that same contract: a tuple
    // persisted by a historical chat can name a harness that is now disabled,
    // and its model then shows as the raw slug. A slug for a provider the user
    // turned off is the honest answer; a retrying request for it is not.
    const availableIds = new Set(
      available.flatMap((harness) =>
        harness.available && harness.enabled ? [harness.id] : [],
      ),
    );
    return wantedKey.split(" ").flatMap((harnessId) => {
      // `safeParse` rather than trusting the id: a tuple's harness is typed as
      // the wire's `HarnessId`, and only a `GuiHarnessId` has a GUI model
      // catalogue to ask about. The two unions list the same members today, so
      // this refuses nothing - it is here because they are SEPARATELY declared,
      // and the first terminal-only vendor would otherwise reach `listModels`
      // for a harness that has no catalogue.
      const parsed = guiHarnessIdSchema.safeParse(harnessId);
      return parsed.success && availableIds.has(parsed.data)
        ? [parsed.data]
        : [];
    });
  }, [available, wantedKey]);

  const requests = useMemo(
    () =>
      harnessIds.map((harnessId) => ({
        method: "agent.gui.listModels" as const,
        // `null`: these cards name a tuple, not a workspace, and a
        // project-scoped catalogue would resolve the same slugs anyway.
        params: { harnessId, workingDirectory: null },
      })),
    [harnessIds],
  );

  // `combine` projects to catalogue DATA rather than handing back the result
  // array, and it is not an optimisation. `useQueries` returns a FRESH
  // result-array reference on every render, so without this the memo below -
  // and therefore the resolver it returns - was rebuilt every frame. For the
  // cards that is only wasted work; for the transcript announcer it is a
  // correctness problem, because that surface lists this resolver in an
  // effect's dependencies, and an unstable resolver would re-run the effect on
  // every render. TanStack structurally shares the COMBINED value, so this
  // array stays referentially stable for as long as the catalogues do.
  const modelCatalogues = useHostQueries<
    HostRpcRegistry,
    "agent.gui.listModels",
    ReadonlyArray<ModelCatalogueRead>
  >({
    client,
    cacheKeyIdentity: undefined,
    requests,
    options: {
      enabled,
      subscribed: enabled,
      staleTime: Infinity,
      gcTime: Infinity,
    },
    combine: (
      results: Array<
        UseQueryResult<
          ResponseOfMethod<HostRpcRegistry, "agent.gui.listModels">,
          HostRpcError
        >
      >,
    ): ReadonlyArray<ModelCatalogueRead> =>
      results.map((result) => ({
        models: result.data?.models,
        // Answered, failed, or switched off. The third arm reads this hook's
        // own `enabled` rather than inferring idleness from the result, and
        // that is the load-bearing choice: a DISABLED query sits at
        // `isPending` with `isFetching` false forever, so a `!isFetching` test
        // would call it settled - but so is a query that has mounted and not
        // yet started its fetch, and calling THAT settled is precisely the
        // premature answer this flag exists to prevent.
        settled: result.isSuccess || result.isError || !enabled,
      })),
  });

  // One map per catalogue read rather than a linear scan per chip: a menu
  // resolves one label per row, and re-walking a provider's whole model array
  // for each of them is the accidental O(rows x models) this avoids - the same
  // argument the profile resolver's own memo makes.
  // NESTED maps rather than one map under a composite `harness<sep>slug` key.
  // A composite key needs a separator that appears in neither half, and a model
  // slug is provider-authored free text - `claude-fable-5-1[1m]` already
  // carries brackets - so any separator choice is an assumption about a string
  // we do not own. Nesting has no separator to choose and no pair of distinct
  // inputs can collide.
  const byHarness = useMemo(() => {
    const outer = new Map<string, ReadonlyMap<string, string>>();
    harnessIds.forEach((harnessId, index) => {
      const models = modelCatalogues[index].models;
      if (models === undefined) return;
      const inner = new Map<string, string>();
      for (const model of models) {
        inner.set(model.slug.toLowerCase(), model.label);
      }
      outer.set(harnessId, inner);
    });
    return outer;
  }, [harnessIds, modelCatalogues]);

  // Keyed off the WANTED ids, not off `harnessIds`, and that distinction is the
  // whole of this memo.
  //
  // `harnessIds` is what survived two filters - the harness list having
  // arrived, and the row being available - so an id still waiting on EITHER is
  // absent from it. Walking only `harnessIds` therefore reported every such id
  // settled: before `agent.gui.listHarnesses` answers, that is every id in
  // play, which is exactly the premature answer the model-catalogue `settled`
  // flag exists to prevent, one layer higher up. The manual-switch announcer
  // CONSUMES its event, so a single settled-too-early read there names the raw
  // slug permanently.
  const unsettled = useMemo(() => {
    const pendingIds = new Set<string>();
    // Nothing is in flight when the hook is off, matching `settled`'s own third
    // arm - a disabled query sits at `isPending` forever and waiting on it
    // would never end.
    if (!enabled) return pendingIds;
    // The same `safeParse` gate `harnessIds` applies, and for the same reason
    // turned around: a harness with no GUI catalogue never has `listModels`
    // called for it, so there is nothing here to wait FOR. Deferring on one
    // would hold an announcement open against a request that is never going to
    // be made - the failure `settledFor`'s own note below warns about, arrived
    // at from the other direction. Applied to the WANTED list rather than per
    // branch, because it is a fact about the id alone and holds before the
    // harness list has said anything.
    const wanted =
      wantedKey === ""
        ? []
        : wantedKey
            .split(" ")
            .filter((id) => guiHarnessIdSchema.safeParse(id).success);

    // A failed harness read settles the AVAILABILITY wait rather than blocking
    // it - the same trade the catalogue flag makes, for the same reason:
    // waiting on a read that is never coming would swap a clumsy label for
    // silence about a switch that happened.
    //
    // Read OUT HERE, not inside the no-data branch, and that placement is the
    // whole point. TanStack's error reducer SPREADS existing state and never
    // clears `data` ("flag existing data as invalidated if we get a background
    // error"), so a refetch failure after one success leaves `isError` true
    // WITH the last good rows still retained. An `isError` test reachable only
    // when `available === undefined` therefore never fires in that case, and a
    // cached `availabilityPending` row was re-added on every render for as long
    // as the refetch kept failing. `settledFor` would never come back true, and
    // the manual-switch announcer - which CONSUMES its event - stays silent
    // about a switch that already happened. Indefinite silence is the worse
    // half of this trade, not the safer one.
    const harnessReadFailed = harnessesQuery.isError;

    if (available === undefined) {
      if (!harnessReadFailed) for (const id of wanted) pendingIds.add(id);
      return pendingIds;
    }

    // Model reads below are still honoured on a harness-read error: this gate
    // is only about waiting for an AVAILABILITY verdict that is not coming.
    if (!harnessReadFailed) {
      const rowById = new Map(available.map((row) => [String(row.id), row]));
      for (const id of wanted) {
        const row = rowById.get(id);
        // Pending is not an unavailable verdict. A row still deciding gets left
        // out of `harnessIds` by the `available` filter above, so without this
        // it would read settled while its answer - and the catalogue fetch that
        // follows it - are both still outstanding.
        //
        // `row.enabled`, and NOT `lastSettledAvailable !== false`, which this
        // used to test. That field answers "what did we last conclude", and the
        // question here is "is an answer still coming" - a re-probe of a row
        // that previously answered unavailable can succeed, and settling on its
        // stale negative consumed the announcement with a raw slug that no
        // later resolution could correct. The accumulator's own negative guard
        // exists to stop stale MODELS being resurrected mid-probe, which is a
        // different question from whether a one-shot sentence should wait.
        //
        // The `enabled` gate has to be explicit because dropping the old field
        // would otherwise let disabled rows through: the accumulator forces
        // `lastSettledAvailable` false whenever `enabled` is false, so that
        // test had been doing this filtering as a side effect.
        if (
          row !== undefined &&
          row.enabled &&
          row.availabilityPending &&
          !row.available &&
          row.error === null
        ) {
          pendingIds.add(id);
        }
      }
    }

    harnessIds.forEach((harnessId, index) => {
      if (!modelCatalogues[index].settled) pendingIds.add(harnessId);
    });
    return pendingIds;
  }, [
    available,
    enabled,
    harnessIds,
    harnessesQuery.isError,
    modelCatalogues,
    wantedKey,
  ]);

  return useMemo(
    () => ({
      labelFor: (harnessId: string, model: string): string =>
        // Lower-cased on both sides, matching the engine's own family match
        // (`candidateFamilyMatchesSlug`), so "GPT-5" and "gpt-5" are one model
        // here exactly as they are to the walk.
        byHarness.get(harnessId)?.get(model.toLowerCase()) ?? model,
      // An id NOBODY asked about reads settled, and that is the safe default
      // rather than an oversight: this set holds the subjects a caller listed
      // and is still waiting on, so an id outside it has no read in flight for
      // anyone to wait for. A caller that treated "unknown" as unsettled would
      // block on a request that was never going to be made.
      settledFor: (harnessId: string): boolean => !unsettled.has(harnessId),
    }),
    [byHarness, unsettled],
  );
}

/**
 * The label half of {@link useFallbackModelCatalogues}, for the surfaces that
 * only ever need to name a model.
 *
 * Which is nearly all of them: a card, a chip or a menu row renders whatever is
 * resolved at this frame and repaints when the catalogue lands, so it has no
 * use for `settledFor` and should not have to destructure past it.
 */
export function useFallbackModelLabels(
  client: HostClient<HostRpcRegistry> | null,
  harnessIdsInPlay: ReadonlyArray<string | null>,
  enabled: boolean,
): FallbackModelLabelResolver {
  return useFallbackModelCatalogues(client, harnessIdsInPlay, enabled).labelFor;
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
  modelLabelFor: FallbackModelLabelResolver,
): FallbackDestinationDescription {
  const identity = fallbackTupleIdentity(tuple, labelFor, modelLabelFor);
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
 *
 * `modelLabelFor` resolves the CONCRETE model and nothing else. The family arm
 * is deliberately left raw: `modelFamily` is an equivalence-GROUP name the user
 * typed into Settings, not a catalogue slug, and the two are not
 * interchangeable even when they happen to spell the same string. Passing a
 * family through a slug resolver would relabel `gpt-5` - a family that is also
 * a slug - as that model's catalogue label, and the row would then claim to
 * name a model the host explicitly could not resolve. {@link
 * FallbackDestinationDescription.modelIsFamily} keeps its meaning for the same
 * reason: it says which of the two arms produced the label, and the resolver
 * changes neither arm's identity.
 */
export function fallbackDestinationOfModelTarget(
  target: FallbackModelTarget,
  labelFor: FallbackProfileLabelResolver,
  modelLabelFor: FallbackModelLabelResolver,
): FallbackDestinationDescription {
  const model = target.model;
  return {
    providerLabel: fallbackHarnessLabelFor(target.harnessId),
    profileLabel: labelFor(target.profileId),
    modelLabel:
      model === null
        ? target.modelFamily
        : modelLabelFor(target.harnessId, model),
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
  modelLabelFor: FallbackModelLabelResolver,
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
    fallbackDestinationOfTuple(pair.destination, labelFor, modelLabelFor),
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
  modelLabelFor: FallbackModelLabelResolver,
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
    // The CATALOGUE label, degrading to the slug when nothing can say. Every
    // surface reads `identity.model`, so resolving it here is what stops one
    // card saying "Claude Fable" while the one beside it says
    // "claude-fable-5-1[1m]".
    model: modelLabelFor(harnessId, tuple.model),
    providerId: providerCliIdForHarness(harnessId),
  };
}
