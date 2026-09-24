import { useMemo } from "react";
import {
  guiHarnessIdSchema,
  readableModelMatch,
  resolveModelBySlug,
  type GuiHarnessId,
  type GuiHarnessOption,
  type ListGuiAgentModelsResponse,
} from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useAutoJudgeVerdictForClient } from "@/hooks/auto-mode/use-auto-judge-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  autoJudgeBillingForRun,
  autoJudgeTarget,
  harnessHasNativeAutoJudge,
  providerRunsItsOwnJudge,
  type AutoJudgeBilling,
  type AutoJudgeTarget,
} from "@/lib/auto-mode/auto-judge-billing";
import { providersListReportsAutoJudge } from "@/lib/providers/provider-auto-judge";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import {
  catalogLineKnowsAutoMode,
  modelDisplayLabel,
} from "@/components/home/data/landing-options";
import {
  judgeModelUnavailable,
  judgeProfileUnavailable,
  offeredJudgeProfileIds,
} from "@/components/settings/panels/auto-judge-selection";

/**
 * Whether every read the billing answer depends on has settled.
 *
 * Extracted for the complexity ceiling, like its neighbour below, but the
 * grouping is real: these are exactly the reads whose PENDING state must
 * publish `null` rather than a guess, and keeping them in one predicate (with
 * the catalog half in {@link nativeJudgeQuestionDecided}) is what stops a later
 * edit from adding a read to the hook and forgetting one of the places
 * readiness is decided.
 *
 * `isProviderNative` is an OR rather than a requirement: a provider running its
 * own classifier needs no judge record, which is what lets a host without
 * `autoJudge.get` still publish "no extra cost".
 */
function billingInputsSettled(input: {
  /** {@link nativeJudgeQuestionDecided}: the two catalogs, and their version. */
  readonly nativeDecided: boolean;
  readonly isProviderNative: boolean;
  readonly judgeRecordAnswered: boolean;
  /**
   * The judge harness's MODEL catalog, `true` when it has succeeded or when
   * there is no judge model for it to name.
   *
   * Paired with `judgeRecordAnswered` rather than folded into
   * `nativeDecided`, because it is only required on the arms that name a
   * judge: the provider-native answer is resolved from `providers.list` and
   * the harness catalog alone, and making "no extra cost" wait on a model read
   * it never consults would withhold the one disclosure that is always safe to
   * publish.
   */
  readonly judgeModelsSettled: boolean;
}): boolean {
  return (
    input.nativeDecided &&
    (input.isProviderNative ||
      (input.judgeRecordAnswered && input.judgeModelsSettled))
  );
}

/**
 * Whether the provider-native question - does this run's own provider review
 * its commands - has a settled answer: both catalogs it is read from have
 * succeeded, and the providers line is new enough to report the preference
 * where it matters. Every billing answer waits on it, and so does the judge's
 * model read, which a provider-native run never needs.
 */
function nativeJudgeQuestionDecided(input: {
  readonly providersSettled: boolean;
  readonly harnessesSettled: boolean;
  readonly providerJudgeUnknown: boolean;
}): boolean {
  return (
    input.providersSettled &&
    input.harnessesSettled &&
    !input.providerJudgeUnknown
  );
}

/**
 * The ROWS the judge harness currently lists, or `undefined` while the catalog
 * has not answered - the value {@link judgeModelUnavailable} reads as "cannot
 * say". Extracted for the complexity ceiling, same reason as its neighbours.
 *
 * Rows, not slugs. A slug list cannot answer whether the catalog covers the
 * stored slug: a row also matches through its `metadata.resolvedModel`, and
 * mapping to `.slug` throws that evidence away before the resolver can use it.
 */
function offeredJudgeModels(
  data: ListGuiAgentModelsResponse | undefined,
): ReadonlyArray<GuiAgentModelOption> | undefined {
  return data?.models;
}

/**
 * The judge's MODEL dimension, as the two facts the billing answer needs: is
 * the stored model gone, and has the read that would say so actually answered.
 *
 * Both halves in one helper because they share one gate. A harness this build
 * cannot name has no catalog to consult, so there is nothing to find missing
 * AND nothing to wait for - and splitting them invites a caller that waits on a
 * query it also decided not to run. Extracted for the complexity ceiling, the
 * same reason as its neighbours.
 */
function storedJudgeModelState(
  applicable: boolean,
  storedModelSlug: string,
  models: ListGuiAgentModelsResponse | undefined,
  modelsSucceeded: boolean,
): { readonly unavailable: boolean; readonly settled: boolean } {
  if (!applicable) return { unavailable: false, settled: true };
  return {
    unavailable: judgeModelUnavailable(
      storedModelSlug,
      offeredJudgeModels(models),
    ),
    settled: modelsSucceeded,
  };
}

/**
 * What the judge's model-catalog query should target, and whether it applies.
 *
 * `AutoJudgeSelection.harnessId` is a plain string on the wire while the models
 * query takes the narrowed union, so an unrecognized id has to resolve to
 * SOMETHING - and the two facts have to travel together, which is why this
 * returns a pair rather than a nullable id.
 *
 * It used to be a bare `GuiHarnessId` falling back to `"traycer"`, with a note
 * claiming the query was "gated off" for an unrecognized id. It was not: the
 * gate read `judgeHarnessId !== null`, which is TRUE for an unrecognized id, so
 * the fallback stopped being an unused placeholder and became the harness whose
 * catalog the stored slug was compared against - reporting almost any such
 * judge as gone. `applicable` is the gate that note assumed existed; the
 * `harnessId` beside it is only ever a cache key for a query that is off.
 */
function judgeModelsQueryTarget(judgeHarnessId: string | null): {
  readonly harnessId: GuiHarnessId;
  readonly applicable: boolean;
} {
  const parsed = guiHarnessIdSchema.safeParse(judgeHarnessId);
  return parsed.success
    ? { harnessId: parsed.data, applicable: true }
    : { harnessId: "traycer", applicable: false };
}

/**
 * The display name of the judge's model, from its harness's catalog.
 *
 * The same read-only lookup the composer's own model pill uses
 * (`findSelectedModel`): a slug that matches a row directly or through its
 * `metadata.resolvedModel` names that row. `null` when the catalog has no row
 * for it, and the row shows the slug instead - an unknown model is still a
 * model the judge runs on.
 */
export function autoJudgeModelLabel(
  models: ReadonlyArray<GuiAgentModelOption> | undefined,
  modelSlug: string,
): string | null {
  if (models === undefined) return null;
  const model = readableModelMatch(resolveModelBySlug(models, modelSlug));
  return model === null ? null : modelDisplayLabel(model);
}

/**
 * The run harness's `judgeDefaultModel`, which is what Automatic's fallback
 * judges on for that harness. `null` when its row names none (the conversation's
 * own model judges then), or the catalog has not answered.
 */
function runJudgeDefaultModel(
  harnessId: GuiHarnessId | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): string | null {
  if (harnessId === null || harnesses === undefined) return null;
  const row = harnesses.find((candidate) => candidate.id === harnessId);
  return row?.judgeDefaultModel ?? null;
}

/**
 * {@link autoJudgeTarget} for this composer's run, from the `autoJudge.get`
 * record (`undefined` while it has not answered). Extracted for the complexity
 * ceiling, like its neighbours.
 */
function runJudgeTarget(
  record: AutoJudgeGetResponse | undefined,
  harnessId: GuiHarnessId | null,
  runModelSlug: string,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): AutoJudgeTarget {
  return autoJudgeTarget({
    selection: record?.selection ?? null,
    effective: record?.effective,
    blocked: record?.blocked,
    runHarnessId: harnessId,
    runModelSlug,
    runJudgeDefaultModel: runJudgeDefaultModel(harnessId, harnesses),
  });
}

/**
 * Whether the judge's model catalog is read at all, and it is an ACTIVE read
 * when it is: the target now includes Automatic's default and fallback judges,
 * whose catalogs nothing else on this host is guaranteed to have warmed (a
 * composer pinned to a non-default host reads that host's slots, which the
 * app-load prefetcher never fills), and a read that neither fetches nor
 * observes the cache would leave the row waiting on it forever. Its own
 * `staleTime: Infinity` keeps a warm slot from ever being re-pulled.
 *
 * Only once the provider-native question is DECIDED, and never for a
 * provider-native run: that answer names no model, so reading one would only
 * wake a provider for nothing.
 */
function judgeModelsActivity(input: {
  readonly autoModeHost: boolean;
  readonly applicable: boolean;
  readonly nativeDecided: boolean;
  readonly isProviderNative: boolean;
}): { readonly enabled: boolean; readonly subscribed: boolean } {
  const wanted =
    input.autoModeHost &&
    input.applicable &&
    input.nativeDecided &&
    !input.isProviderNative;
  return { enabled: wanted, subscribed: wanted };
}

/** The target model's label from its harness's catalog, when there is one. */
function targetModelLabel(
  target: AutoJudgeTarget,
  models: ListGuiAgentModelsResponse | undefined,
): string | null {
  if (target.kind !== "judge") return null;
  return autoJudgeModelLabel(offeredJudgeModels(models), target.modelSlug);
}

/**
 * The stored judge MODEL, when there is one and it is the judge being named.
 *
 * `""` otherwise, which {@link judgeModelUnavailable} reads as "cannot say":
 * a stored selection is only compared against the catalog of the harness it
 * names, and under Automatic there is no stored model to lose.
 */
function storedJudgeModelSlug(
  selection: { readonly harnessId: string; readonly model: string } | null,
  target: AutoJudgeTarget,
): string {
  if (selection === null || target.kind !== "judge") return "";
  return selection.harnessId === target.harnessId ? selection.model : "";
}

/**
 * The composer's half of round 12's profile-availability read.
 *
 * Extracted rather than inlined because `useAutoJudgeBilling` is at gui-app's
 * complexity ceiling (16) and this is the branch that pushed it over - the same
 * reason `offeredJudgeProfileIds` lives beside the picker rather than in it.
 *
 * A null judge harness short-circuits: with no stored judge there is no profile
 * to have lost, and `offeredJudgeProfileIds` would have no row to look up.
 */
function storedJudgeProfileUnavailable(
  judgeHarnessId: string | null,
  storedProfileId: string | null,
  providers: ReadonlyArray<ProviderCliState> | undefined,
): boolean {
  if (judgeHarnessId === null) return false;
  return judgeProfileUnavailable(
    storedProfileId,
    offeredJudgeProfileIds(providers, judgeHarnessId),
  );
}

/**
 * Which pocket THIS composer's judged approvals would be charged to.
 *
 * Scoped to the composer's run target rather than the app-wide host, like
 * every other composer RPC: the judge runs on the machine the turn runs on, so
 * a composer pinned to another host must disclose that host's judge, not this
 * window's. A `null` target is the FOLLOWING case - the surface owns its
 * placement and resolves to the binding's host, which is exactly what
 * `useHostClientForHostId(null)` hands back a client for.
 *
 * **The host name is read off the CLIENT, never from an app-wide hook.** This
 * used to fall back to `useAddressableHostId()` for the `null` case, which is
 * banned inside a tab (root AGENTS.md: tabs bind a `hostId` for life) and was
 * subscribing every chat composer to the mutable app-wide selection - a
 * value it then discarded, since every caller passes a resolved id. It was
 * also the two-sources shape `useAddressableHostId`'s own doc warns about: the
 * capability gate's fallback named one host while the query ran on another's
 * client. `useReactiveHostReadiness` answers "which host is THIS client
 * addressing", so the following case keeps working - same value, same moment -
 * without anything here naming the selection.
 *
 * `autoJudge.get` is an OPTIONAL capability, so the read is gated on the
 * host advertising it. A host that predates auto mode - and the window before
 * any handshake completes - answers `null`, and the caller renders nothing:
 * the disclosure is additive, and an old host must change nothing.
 *
 * `harnessId` is the harness THIS composer will run, and it is here because the
 * provider's own classifier takes PRECEDENCE over the host-wide selection: a
 * provider set to `autoJudge: "provider"` bypasses Traycer's judge and the
 * policy entirely, so the stored selection describes a call that will never be
 * made. The `providers.list` read shares a key with the one
 * `HarnessModelPicker` already holds for this same client, so on the desktop
 * composer it costs nothing; the mobile toolbar has no picker mounted and is
 * the caller this read actually fetches for - which is the point, since that
 * row makes the same claim.
 */
export function useAutoJudgeBilling(
  hostId: string | null,
  harnessId: GuiHarnessId | null,
  /**
   * The model this composer will run, `""` while its catalog loads. Under
   * Automatic's fallback the judge runs on the conversation's own harness, on
   * its `judgeDefaultModel` or else on this model, so the row names it.
   */
  runModelSlug: string,
): AutoJudgeBilling | null {
  const client = useHostClientForHostId(hostId);
  // Only the FALLBACK moved, and deliberately so: a named target still gates on
  // the id it was handed, exactly as before, so nothing waits on a directory
  // row it did not wait on yesterday. What changed is where the following
  // case's name comes from - the client this hook already resolved, rather
  // than the app-wide selection.
  const followingHostId = useReactiveHostReadiness(client).hostId;
  const resolvedHostId = hostId ?? followingHostId;
  const supported = useHostSupportsMethod(resolvedHostId, "autoJudge.get");
  // TWO gates, because this hook answers with TWO independent facts and only
  // one of them comes from `autoJudge.get`.
  //
  // `autoJudge.get` gates its own read and nothing else - per-method
  // negotiation, the rule this file has applied one method over twice now. What
  // it must NOT gate is the provider-native path: `autoJudgeBillingForRun`
  // takes that arm FIRST and resolves it from the harness catalog and
  // `providers.list` alone, with no host-wide selection involved. A host
  // advertising `providers.list@9.1`, a native classifier and
  // `providers.setAutoJudge` while omitting the host-wide getter is one
  // per-method negotiation permits, and gating both reads on the getter left it
  // with no "no extra cost" disclosure at all - for the one path that genuinely
  // bypasses the judge the getter describes.
  //
  // So the catalog reads are gated on the host having Auto mode AT ALL, proven
  // either way round: the getter it advertises, or the catalog line that can
  // spell the mode. Same two-proof shape as
  // `hostUnderstandsAutoPermissionMode`, and neither proof is evidence about
  // the other's method.
  //
  // Read unconditionally - `||` would make the hook call conditional.
  const listHarnessesLine = useHostMethodSchemaVersion(
    resolvedHostId,
    "agent.gui.listHarnesses",
  );
  const autoModeHost = supported || catalogLineKnowsAutoMode(listHarnessesLine);
  // The record, or `undefined` while there is no CURRENT one: none has
  // answered yet, or the one held was invalidated because an input the host
  // derives it from moved (see `useAutoJudgeVerdictForClient`, the reader
  // every surface naming the paying account shares). Treating the invalidated
  // answer as unanswered keeps the row saying nothing, rather than the old
  // pocket, until the host has answered again - and it keeps saying nothing if
  // that refetch fails, since the answer is still unknown.
  const record = useAutoJudgeVerdictForClient(client, supported);
  const providersQuery = useProvidersListForClient(client, {
    enabled: autoModeHost,
    subscribed: autoModeHost,
  });
  const providers = providersQuery.data?.providers;
  // SETTLED, not "has data". `providerRunsItsOwnJudge` reads an absent catalog
  // as `false`, which is the right direction for a host that cannot answer and
  // the wrong one for a host that has not answered YET: on the mobile toolbar
  // this read is cold (no picker mounted to have warmed it), so `autoJudge.get`
  // routinely resolves first and the row would publish "Uses your Traycer
  // credits" for a provider-native run, then flip to "no extra cost" when the
  // rows land. A user choosing Auto in that window chose on copy that was
  // wrong.
  //
  // SUCCESS ONLY - an earlier round counted `isError` as settled, on the
  // reasoning that "a host that cannot answer is what the `false` default is
  // for". That conflated two different things. The `false` default is for a
  // host that ANSWERS without the data (one predating `providers.list@9.1`,
  // whose successful response simply omits `autoJudge`); a transport failure is
  // an UNKNOWN, and turning it into `false` publishes "Uses your Traycer
  // credits" for a run the host may well review natively at no cost. The
  // disclosure is additive, so saying nothing is always available and is the
  // honest answer to a read that failed.
  const providersSettled = providersQuery.isSuccess;
  // The harness catalog is the second half of the native-judge question: the
  // persisted `autoJudge: "provider"` is a preference, and `nativeAutoJudge` is
  // whether there is still a classifier to delegate to. Same key the picker
  // holds for this client, and folded into the settled gate for the reason the
  // provider read is - classifying on an unanswered catalog would publish
  // "Uses your Traycer credits" and flip once the rows land.
  const harnessesQuery = useGuiHarnessesQueryForClient(client, {
    enabled: autoModeHost,
    subscribed: autoModeHost,
  });
  const harnesses = harnessesQuery.data?.harnesses;
  // Success only, for the same reason and by the same sweep: this read is just
  // as REQUIRED for the native-judge decision, so a failed one is equally an
  // unknown rather than a `false`.
  const harnessesSettled = harnessesQuery.isSuccess;
  const isProviderNative = useMemo(
    () => providerRunsItsOwnJudge({ harnessId, providers, harnesses }),
    [harnessId, providers, harnesses],
  );
  // A THIRD unknown, alongside the two settled reads above, and it is a version
  // rather than a status. `autoJudge` rides `providers.list@9.1`; a `9.0`
  // response strips the key, so `providerAutoJudgeFor`'s `?? "traycer"` answers
  // for every provider and `providerRunsItsOwnJudge` says `false` whatever the
  // host has stored. That default is right for a host with no notion of the
  // setting - and wrong for one that advertises `providers.setAutoJudge` on an
  // older list line, which per-method negotiation permits: there the user's own
  // choice of the provider's classifier reads back as Traycer's judge, and this
  // row would bill their Traycer credits for a review the provider is doing.
  //
  // It only bites where the preference is CONSULTED, which is a harness with a
  // classifier to delegate to. Everywhere else `false` is settled by the
  // catalog alone and the list line is irrelevant - so the gate is the pair,
  // not the version on its own, and the common host is unaffected.
  //
  // Read unconditionally - `&&` would make the hook call conditional - and
  // folded with the catalog answer below.
  const providersListVersion = useHostMethodSchemaVersion(
    resolvedHostId,
    "providers.list",
  );
  const providerJudgeUnknown =
    harnessHasNativeAutoJudge(harnessId, harnesses) &&
    !providersListReportsAutoJudge(providersListVersion);
  const nativeJudgeDecided = nativeJudgeQuestionDecided({
    providersSettled,
    harnessesSettled,
    providerJudgeUnknown,
  });
  const selection = record?.selection ?? null;
  // WHICH judge the host would call for this run, from `effective`: the
  // stored pick, Traycer's default, or - under Automatic's fallback - this
  // composer's own harness on its judge model or the conversation's model.
  // Only meaningful once the record has answered; the settled gate below
  // withholds the answer until it has.
  const target = useMemo(
    () => runJudgeTarget(record, harnessId, runModelSlug, harnesses),
    [record, harnessId, runModelSlug, harnesses],
  );
  const judgeHarnessId = selection === null ? null : selection.harnessId;
  // The stored judge's PROFILE, which the host's `blocked` cannot report:
  // `AutoJudgeBlocked.reason` has no missing-profile member, so a judge whose
  // explicit profile was removed reads as runnable here while Settings already
  // shows it as a record that cannot run. The composer's Auto row was still
  // promising the provider account would be charged for a judge that will not
  // run - every command escalates to the human instead.
  //
  // Same rule as Settings, through the same function rather than a second
  // spelling (`judgeProfileUnavailable`): ambient (`null`) is not a missing
  // profile, and an unanswered providers read is not either.
  const storedProfileUnavailable = storedJudgeProfileUnavailable(
    judgeHarnessId,
    selection?.profileId ?? null,
    providers,
  );
  // The judge harness's own model catalog: where the model LABEL comes from,
  // and where a stored model is checked for having left. An active read on its
  // own gate (`judgeModelsActivity`), and gated on there being a judge to name
  // at all, so a composer adds no fetch for a host that cannot run one or a run
  // its provider reviews itself. `undefined` until it answers, which
  // `judgeModelUnavailable` reads as "cannot say" rather than "gone" - the same
  // direction as the profile read beside it, and the one that keeps the
  // disclosure steady on a cold load.
  //
  // Gated on the harness PARSING, not merely on a judge existing. A stored id
  // outside this build's union used to fall through to a `"traycer"` stand-in
  // and compare the stored slug against TRAYCER's catalog, which reports almost
  // any such judge as gone. A harness this build cannot name has no catalog to
  // check, which is a "cannot say", not a verdict - and its label is the slug.
  const judgeModelsTarget = judgeModelsQueryTarget(
    target.kind === "judge" ? target.harnessId : null,
  );
  // `settled` is `true` for a target that names no judge: an inapplicable
  // query has nothing to wait for, which is exactly what the gate below needs.
  const judgeModelsQuery = useGuiHarnessModelsQueryForClient(
    client,
    judgeModelsTarget.harnessId,
    null,
    judgeModelsActivity({
      autoModeHost,
      applicable: judgeModelsTarget.applicable,
      nativeDecided: nativeJudgeDecided,
      isProviderNative,
    }),
  );
  // SUCCESS ONLY on the `settled` half, for the same reason `providersSettled`
  // and `harnessesSettled` above are: a read that has not answered is an
  // UNKNOWN, and turning it into "the model is fine" publishes "your provider
  // account will be charged" for a judge that may not run. Pending made that
  // claim early; a FAILED read made it permanently, because `data` stays
  // `undefined` forever and `judgeModelUnavailable` reads that as "cannot say".
  const { unavailable: storedModelUnavailable, settled: judgeModelsSettled } =
    storedJudgeModelState(
      judgeModelsTarget.applicable,
      storedJudgeModelSlug(selection, target),
      judgeModelsQuery.data,
      judgeModelsQuery.isSuccess,
    );
  const judgeModelLabel = targetModelLabel(target, judgeModelsQuery.data);
  // The provider-native answer needs the two catalog reads and nothing else;
  // every other answer needs the host-wide record as well. Splitting them is
  // what lets a host without `autoJudge.get` still publish "no extra cost" -
  // and `isProviderNative` can only be true for a non-null `harnessId`
  // (`providerRunsItsOwnJudge` returns `false` for a null one), so that arm is
  // guaranteed to be the one `autoJudgeBillingForRun` takes.
  const loaded = billingInputsSettled({
    nativeDecided: nativeJudgeDecided,
    isProviderNative,
    judgeRecordAnswered: record !== undefined,
    judgeModelsSettled,
  });

  return useMemo(
    () =>
      loaded
        ? autoJudgeBillingForRun({
            runHarnessId: harnessId,
            isProviderNative,
            target,
            judgeModelLabel,
            judgeRecordUnrunnable:
              storedProfileUnavailable || storedModelUnavailable,
          })
        : null,
    [
      loaded,
      harnessId,
      isProviderNative,
      target,
      judgeModelLabel,
      storedProfileUnavailable,
      storedModelUnavailable,
    ],
  );
}
