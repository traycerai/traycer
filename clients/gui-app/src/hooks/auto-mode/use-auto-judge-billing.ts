import { useMemo } from "react";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQueryForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  autoJudgeBillingForRun,
  harnessHasNativeAutoJudge,
  providerRunsItsOwnJudge,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";
import { providersListReportsAutoJudge } from "@/lib/providers/provider-auto-judge";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { catalogLineKnowsAutoMode } from "@/components/home/data/landing-options";
import {
  judgeModelUnavailable,
  judgeProfileUnavailable,
  offeredJudgeProfileIds,
} from "@/components/settings/panels/auto-judge-selection";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const AUTO_JUDGE_GET_PARAMS = {};

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
/**
 * Whether every read the billing answer depends on has settled.
 *
 * Extracted for the complexity ceiling, like its neighbour below, but the
 * grouping is real: these are exactly the reads whose PENDING state must
 * publish `null` rather than a guess, and keeping them in one predicate is what
 * stops a later edit from adding a fourth read to the hook and forgetting one
 * of the two places readiness is decided.
 *
 * `isProviderNative` is an OR rather than a requirement: a provider running its
 * own classifier needs no judge record, which is what lets a host without
 * `autoJudge.get` still publish "no extra cost".
 */
function billingInputsSettled(input: {
  readonly providersSettled: boolean;
  readonly harnessesSettled: boolean;
  readonly providerJudgeUnknown: boolean;
  readonly isProviderNative: boolean;
  readonly judgeRecordAnswered: boolean;
}): boolean {
  const catalogsSettled =
    input.providersSettled &&
    input.harnessesSettled &&
    !input.providerJudgeUnknown;
  return (
    catalogsSettled && (input.isProviderNative || input.judgeRecordAnswered)
  );
}

/**
 * The judge harness id as a `GuiHarnessId`, or the run harness as a stand-in.
 *
 * `AutoJudgeSelection.harnessId` is a plain string on the wire, and the models
 * query takes the narrowed union. A stored id outside it cannot name a real
 * catalog, so the query is gated off for it anyway (`judgeHarnessId !== null`
 * plus a parse that fails) and the model read answers "cannot say".
 */
/**
 * The slugs the judge harness currently lists, or `undefined` while the catalog
 * has not answered - the value {@link judgeModelUnavailable} reads as "cannot
 * say". Extracted for the complexity ceiling, same reason as its neighbours.
 */
function offeredModelSlugs(
  data:
    | { readonly models: ReadonlyArray<{ readonly slug: string }> }
    | undefined,
): ReadonlyArray<string> | undefined {
  return data?.models.map((model) => model.slug);
}

function guiHarnessIdFor(judgeHarnessId: string | null): GuiHarnessId {
  const parsed = guiHarnessIdSchema.safeParse(judgeHarnessId);
  return parsed.success ? parsed.data : "traycer";
}

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

export function useAutoJudgeBilling(
  hostId: string | null,
  harnessId: GuiHarnessId | null,
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
  const query = useHostQuery<HostRpcRegistry, "autoJudge.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.get",
    params: AUTO_JUDGE_GET_PARAMS,
    options: { enabled: supported, refetchOnWindowFocus: false },
  });
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
  const selection = query.data?.selection ?? null;
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
  // The judge harness's own model catalog. Cache-only by this query's own
  // design, and gated on there being a stored judge at all, so a composer adds
  // no fetch for a host with no record. `undefined` until it answers, which
  // `judgeModelUnavailable` reads as "cannot say" rather than "gone" - the same
  // direction as the profile read beside it, and the one that keeps the
  // disclosure steady on a cold load.
  const judgeModelsQuery = useGuiHarnessModelsQueryForClient(
    client,
    guiHarnessIdFor(judgeHarnessId),
    null,
    { enabled: autoModeHost && judgeHarnessId !== null, subscribed: false },
  );
  const storedModelUnavailable = judgeModelUnavailable(
    selection?.model ?? "",
    offeredModelSlugs(judgeModelsQuery.data),
  );
  // The host's own verdict that it CANNOT run the judge it has stored
  // (`provider-disabled`, `no-default`, `unsupported-harness`). Optional on the
  // wire, so an older host answers `undefined` and reads as "not blocked".
  const blocked = query.data?.blocked ?? null;
  // The provider-native answer needs the two catalog reads and nothing else;
  // every other answer needs the host-wide selection as well. Splitting them is
  // what lets a host without `autoJudge.get` still publish "no extra cost" -
  // and `isProviderNative` can only be true for a non-null `harnessId`
  // (`providerRunsItsOwnJudge` returns `false` for a null one), so that arm is
  // guaranteed to be the one `autoJudgeBillingForRun` takes.
  const loaded = billingInputsSettled({
    providersSettled,
    harnessesSettled,
    providerJudgeUnknown,
    isProviderNative,
    judgeRecordAnswered: query.data !== undefined,
  });

  return useMemo(
    () =>
      loaded
        ? autoJudgeBillingForRun({
            judgeHarnessId,
            runHarnessId: harnessId,
            isProviderNative,
            blocked,
            judgeRecordUnrunnable:
              storedProfileUnavailable || storedModelUnavailable,
          })
        : null,
    [
      loaded,
      judgeHarnessId,
      harnessId,
      isProviderNative,
      blocked,
      storedProfileUnavailable,
      storedModelUnavailable,
    ],
  );
}
