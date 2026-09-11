/**
 * Docs: see ../SETTINGS.md (Fallback).
 * Update that file whenever this settings surface changes.
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  tierGroupsNameDestinationFor,
  type FallbackPolicy,
} from "@traycer/protocol/host/fallback-policy";
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useFallbackPolicyQuery } from "@/hooks/providers/use-fallback-policy-query";
import { useFallbackInFlightCountQuery } from "@/hooks/providers/use-fallback-in-flight-count-query";
import { useFallbackPolicySetMutation } from "@/hooks/providers/use-fallback-policy-set-mutation";
import { useFallbackPolicyResetMutation } from "@/hooks/providers/use-fallback-policy-reset-mutation";
import { useFallbackPolicyRestoreTierGroupsMutation } from "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation";
import { useFallbackPolicyPreviewTierGroupsQuery } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";
import { useFallbackSettingsProfileLabels } from "@/components/settings/panels/fallback/fallback-profile-labels";
import { useFallbackEffortOptions } from "@/components/settings/panels/fallback/fallback-effort-options";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  selectGlobalLastRunSettings,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import { fallbackProviderModelLabel } from "@/components/chat/fallback/fallback-identity";
import { noSwitchDestinationText } from "@/components/chat/fallback/fallback-copy";
import { providerSupportsManagedProfiles } from "@/components/settings/panels/provider-settings-tabs";
import { FallbackLadderEditor } from "@/components/settings/panels/fallback/fallback-ladder-editor";
import { FallbackBehaviorGroup } from "@/components/settings/panels/fallback/fallback-behavior-group";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";
import { FallbackDangerZone } from "@/components/settings/panels/fallback/fallback-danger-zone";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";
import { FallbackAllowedDestinations } from "@/components/settings/panels/fallback/fallback-allowed-destinations";
import {
  applyGroupsInverse,
  keyedGroupsMatch,
  withTierGroups,
  type FallbackGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import {
  createFallbackPolicyDraftState,
  createFallbackSaveRequestId,
  fallbackDisplayOrderEnabling,
  fallbackLadderFrom,
  fallbackPolicyDraftReducer,
  fallbackPolicyValuesEqual,
  fallbackSaveInFlight,
  draftIsRefused,
  moveFallbackRung,
  refusedDraftOnScreen,
  validateFallbackPolicyDraft,
  type FallbackPolicyDraftState,
  type FallbackRefusedDraft,
  type FallbackPolicyField,
  type FallbackSaveCarries,
  type FallbackSaveFailureOutcome,
  type FallbackSaveNoticeOutcome,
} from "@/components/settings/panels/fallback/fallback-policy-draft";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";

/**
 * Settings ▸ Host ▸ Fallback.
 *
 * The whole configuration surface for automatic provider fallback: there is no
 * per-chat and no per-task control anywhere in the app, by decision. What a
 * chat gets are the actions on its own cards when a fallback arms.
 */
export function FallbackSettingsPanel(): ReactNode {
  const scope = useHostScope();
  const realBinding = useHostBinding();

  // The same governed narrow the agent-guide section makes, for the same
  // reason: only a fully-resolved scope re-provides the client, so a
  // connecting or vanished pick renders under the ambient context where the
  // gate holds it inert rather than letting it read - or SAVE - through the
  // active host's client. `hostId` has to be spread explicitly; `...realBinding`
  // satisfies the field with the app-wide null, so omitting it compiles clean
  // and silently returns the panel to the ambient host.
  const scopedBinding =
    scope.status === "ready" && realBinding !== null && scope.client !== null
      ? { ...realBinding, hostClient: scope.client, hostId: scope.hostId }
      : null;

  const body = <FallbackSettingsPanelBody scope={scope} />;
  return (
    <SettingsPanelShell
      title="Fallback"
      description={fallbackPanelDescription(scope)}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <HostScopeGate scope={scope} skeleton={<FallbackPanelSkeleton />}>
        {scopedBinding === null ? (
          body
        ) : (
          <HostRuntimeContext.Provider value={scopedBinding}>
            {body}
          </HostRuntimeContext.Provider>
        )}
      </HostScopeGate>
    </SettingsPanelShell>
  );
}

/**
 * The one panel description in Settings that names its host, and the exception
 * is deliberate.
 *
 * The surface's rule is that a panel states nothing about which host it is
 * scoped to, because the sidebar picker already carries the name and an inert
 * readout was that same fact printed twice. This sentence is not a readout: it
 * says what the scope MEANS, and the thing it has to rule out is the reading
 * that this configures every agent on the machine. The policy is per Traycer
 * USER per host and covers that user's chat agents - never terminal agents,
 * which cannot be reconfigured in place and get no fallback at all - and a link
 * into this section from a chat on another host would otherwise silently edit
 * the wrong machine's policy. The host name is the subject that sentence needs,
 * not an ambient label.
 *
 * With no host resolved the clause is dropped rather than rendered against
 * "No host": the gate below is already saying there is nothing to configure.
 */
function fallbackPanelDescription(scope: HostScope): string {
  const base = "When a turn fails on a provider error, try these in order.";
  if (scope.host === null) return base;
  return `${base} Applies to your chat agents on ${scope.hostLabel}.`;
}

function FallbackSettingsPanelBody(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const query = useFallbackPolicyQuery();
  const inFlightCountQuery = useFallbackInFlightCountQuery();
  /**
   * Bumped when a reset has replaced the stored policy wholesale, to remount
   * the editor onto the refetched read.
   *
   * The editor seeds its reducer once and ignores later reads, which is what
   * stops a background refetch yanking a control out from under someone
   * mid-edit. A reset is the one case where that is wrong: the value it seeded
   * from is gone, and the policy the host will serve is not even the one the
   * reset RETURNED - clearing the seed marker means the next read re-seeds the
   * default model groups.
   *
   * So this is bumped from a SUCCESSFUL post-reset read and from nothing else.
   * Not from the mutation settling: "the host reset the row" and "we have read
   * what it now holds" are two facts, and remounting on the first re-seeds the
   * editor from whatever the cache still holds - the policy from before the
   * reset, presented as its result. When the read fails, the editor stays put
   * and says so (`reset-unrefreshed`), which is recoverable; a remount onto
   * stale values is not, because nothing afterwards marks them as stale.
   */
  const [resetGeneration, setResetGeneration] = useState(0);
  /**
   * Whether the NEXT mount of the editor should put focus back on Reset.
   *
   * Separate from `resetGeneration` rather than derived from it (`> 0` would do
   * for the first reset and then never turn off, so a later host switch - which
   * also remounts, through the other half of the key - would steal focus onto a
   * button nobody pressed). The editor clears it once it has been honoured.
   */
  const [returnFocusToReset, setReturnFocusToReset] = useState(false);

  /**
   * The authoritative read of what the host actually has, for the two cases that
   * need one: a save whose reply was lost, and a reset - whose result is by
   * construction not the value it returned. Every control on this page is
   * seeded once and never re-reads, which is what stops a background refetch
   * yanking a control out from under someone mid-edit. The one thing that
   * does poll is the in-flight count, and it polls its own cache entry and
   * seeds nothing (`useFallbackInFlightCountQuery`).
   */
  const refetchPolicy =
    useCallback(async (): Promise<FallbackPolicy | null> => {
      const result = await query.refetch();
      // `isSuccess`, NOT `data !== undefined`. A failed refetch keeps the data
      // it already had: TanStack's `QueryObserverRefetchErrorResult` types
      // `data` as PRESENT alongside `isError: true`, and the cache backs that
      // up - the query's error reducer spreads the previous state and never
      // clears `data`. This editor is only ever mounted after a successful
      // initial read, so a failed read-back here does not return `undefined`;
      // it returns the policy from BEFORE the save whose outcome is in
      // question. Reading that as an authoritative answer is precisely the
      // false claim the unknown-outcome notice exists to prevent - it would
      // settle "did my save land?" with a value that predates the save.
      //
      // `null` means "no answer", which is what the caller's notice already
      // says, so a failed read-back leaves the uncertainty standing.
      if (!result.isSuccess) return null;
      return result.data.policy;
    }, [query]);

  const clearResetFocusIntent = useCallback((): void => {
    setReturnFocusToReset(false);
  }, []);

  // Gated on having NO usable policy, not on `isError` alone. `isError` is set
  // by any failed fetch on this query, including the read-back the editor runs
  // itself after a save whose reply was lost - and that is the one moment the
  // editor must survive. Replacing it wholesale there takes the draft, the
  // uncertainty notice and the "Check again" button off screen together,
  // leaving no way to find out what the host stored and no record that a save
  // was ever in doubt. So the load-error view is for a load that produced
  // nothing to edit; once there is a policy, a later fetch failure is the
  // editor's own business and it reports it in place.
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <div
          role="alert"
          className="rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-ui-sm text-muted-foreground"
        >
          Couldn&apos;t load fallback settings for this host.
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load fallback settings",
              message: null,
              code: null,
              source: "Fallback settings",
            })}
            presentation="link"
            className="ml-1 h-auto p-0"
          />
        </div>
      );
    }
    return <FallbackPanelSkeleton />;
  }

  return (
    <FallbackPolicyEditor
      // Remount on a host switch so one machine's draft can never be saved to
      // another's policy, and on a reset so the editor re-seeds from the
      // refetched policy. This is also what seeds the reducer, which is why
      // there is no hydration effect anywhere in this file.
      key={`${scope.hostId ?? ""}:${resetGeneration}`}
      initialPolicy={query.data.policy}
      // The polled count once it has answered, else the one this read carried.
      inFlightCount={
        inFlightCountQuery.data?.inFlightCount ?? query.data.inFlightCount
      }
      storedPolicyUnreadable={query.data.storedPolicyUnreadable}
      hostLabel={scope.host === null ? null : scope.hostLabel}
      refetchPolicy={refetchPolicy}
      returnFocusToReset={returnFocusToReset}
      onFocusReturned={clearResetFocusIntent}
      onPolicyReplaced={() => {
        // The remount below unmounts the Reset button the confirmation dialog
        // captured as its opener, so the shared dialog's own restoration has
        // nowhere to go. Focus follows the control across the replacement
        // instead of falling to the document body.
        setReturnFocusToReset(true);
        setResetGeneration((generation) => generation + 1);
      }}
    />
  );
}

function FallbackPolicyEditor(props: {
  readonly initialPolicy: FallbackPolicy;
  readonly inFlightCount: number;
  readonly storedPolicyUnreadable: boolean;
  readonly hostLabel: string | null;
  /**
   * Re-reads the host's own policy, answering `null` when the read failed.
   *
   * Two callers: the unknown-outcome read-back, and the reset - which cannot
   * take its own response as the answer. Nothing else on this page re-reads
   * the policy; the in-flight count polls on its own cache entry.
   */
  readonly refetchPolicy: () => Promise<FallbackPolicy | null>;
  readonly returnFocusToReset: boolean;
  readonly onFocusReturned: () => void;
  readonly onPolicyReplaced: () => void;
}): ReactNode {
  const {
    initialPolicy,
    inFlightCount,
    storedPolicyUnreadable,
    hostLabel,
    refetchPolicy,
    returnFocusToReset,
    onFocusReturned,
    onPolicyReplaced,
  } = props;
  const compact = useSettingsDensity() === "compact";
  const setMutation = useFallbackPolicySetMutation();
  const resetMutation = useFallbackPolicyResetMutation();
  const restoreMutation = useFallbackPolicyRestoreTierGroupsMutation();
  const [state, dispatch] = useReducer(
    fallbackPolicyDraftReducer,
    initialPolicy,
    createFallbackPolicyDraftState,
  );
  /**
   * A read-back of the host's policy is running.
   *
   * Covers BOTH read-backs - the unknown-outcome one and the post-reset one -
   * because they share the one "Check again" affordance, and a flag named for
   * only one of them would have to be read as covering the other.
   */
  const [readBackInFlight, setReadBackInFlight] = useState(false);
  /**
   * The latest reducer state, for the handlers that run LONG after the render
   * that created them.
   *
   * Exactly one kind of handler needs this: an "Undo" on a removal toast. The
   * toast outlives the render it was raised from, and a callback closing over
   * `state` would apply its inverse to the draft as it stood at deletion time -
   * which is the whole-snapshot behaviour that undo is being fixed to stop
   * doing. Every other handler here runs from an event on the current render.
   */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /**
   * The per-row "resolves to" verdicts, asked for only while the groups on
   * screen are the groups the host has.
   *
   * The gate is one condition doing three jobs, which is why it is this one and
   * not a validity check:
   *
   *  - **it is askable.** The request schema requires a non-empty `modelFamily`,
   *    so the empty row "Add a model" creates cannot be encoded at all. An
   *    uncommitted list holding one would be a malformed request produced by
   *    ordinary editing.
   *  - **the answer is attributable.** Verdicts pair to rows by `candidateIndex`,
   *    which is sound only while the list they were computed for is the list
   *    being rendered. Previewing a list the editor is not showing would put one
   *    model's verdict under another.
   *  - **it costs a catalog read per candidate.** Text fields commit on blur, so
   *    this fires once per committed change rather than once per keystroke.
   *
   * Group validity is implied rather than re-checked: a match means these groups
   * came back from the host, which validated them. Deliberately NOT gated on the
   * whole draft being valid - a bad value in the ladder or the timings says
   * nothing about what a model family resolves to, and blanking every verdict
   * line for it would be an unrelated surface going dark.
   */
  // Resolved once for the whole editor: one providers read builds one label
  // map, rather than each card rebuilding it (D190).
  const profileLabelFor = useFallbackSettingsProfileLabels();
  // Same shape, same reason: one model-catalog read per distinct harness in the
  // draft serves every row's Effort control.
  const effortOptions = useFallbackEffortOptions(state.draft.tierGroups);

  const previewQuery = useFallbackPolicyPreviewTierGroupsQuery(
    keyedGroupsMatch(state.keyedTierGroups, state.persisted.tierGroups)
      ? state.draft.tierGroups
      : null,
  );

  /**
   * A keystroke in a TEXT field: the draft moves and the inline validation
   * message follows it, but nothing is sent.
   *
   * Text is the one control kind whose intermediate states are not values the
   * user means. "opus" passes through "o", "op", "opu", and a save per character
   * writes three model families nobody asked for, spends a catalog read per
   * candidate previewing each, and makes the response to "o" arrive while "op"
   * is on screen. Every other control here - switches, selects, arrows, buttons -
   * produces a complete value per interaction and commits immediately.
   *
   * Validation still runs per keystroke, which is the point of separating the
   * two: the message under a blank family name has to appear as it goes blank,
   * not when the field is left.
   */
  const editDraft = useCallback(
    (
      next: FallbackPolicy,
      field: FallbackPolicyField,
      keyedTierGroups: readonly KeyedGroup[] | null,
    ): void => {
      dispatch({ type: "edited", policy: next, field, keyedTierGroups });
    },
    [],
  );

  /**
   * The read-back that settles a save whose outcome the host never reported.
   *
   * Driven from the failure itself rather than from an effect: the request that
   * went unanswered is right here, and an effect watching for the state to
   * contain one would be a second trigger for the same episode. A read-back
   * that fails leaves the notice standing with its own "Check again", which is
   * the honest state - we still do not know.
   */
  const reconcileUnknownSave = useCallback(
    async (requestId: number): Promise<void> => {
      setReadBackInFlight(true);
      try {
        const policy = await refetchPolicy();
        if (policy === null) return;
        dispatch({ type: "reconciled", requestId, policy });
      } finally {
        setReadBackInFlight(false);
      }
    },
    [refetchPolicy],
  );

  /**
   * The one write path. Every control reaches the host through this and nothing
   * else, which is what makes the ticket's three save outcomes a property of the
   * panel rather than of whichever control happened to be edited:
   *
   *  - invalid draft: kept on screen with its error, and NOTHING is sent;
   *  - host rejection: the reducer reverts to the persisted value (unless the
   *    draft has moved on since) and prints the host's reason;
   *  - no answer at all: the draft stands and a read-back settles it.
   */
  const commit = useCallback(
    (
      next: FallbackPolicy,
      field: FallbackPolicyField,
      // The candidate identities after this edit, or `null` from a control that
      // does not touch model groups. Stated at every call site rather than
      // defaulted: the groups editor is the only thing that can say which row
      // an insert, a removal or a move produced.
      keyedTierGroups: readonly KeyedGroup[] | null,
    ): void => {
      dispatch({ type: "edited", policy: next, field, keyedTierGroups });
      if (validateFallbackPolicyDraft(next).kind === "invalid") return;
      // Minted here rather than read back off the reducer: the `edited` above
      // has not been applied yet, so the revision this request carries is not
      // observable from this side. The id is the handle the reducer pairs with
      // it, and it is what lets two in-flight saves be told apart.
      const requestId = createFallbackSaveRequestId();
      dispatch({ type: "save-started", field, requestId, carries: "draft" });
      void setMutation
        .mutateAsync({ policy: next })
        .then((response) => {
          dispatch({
            type: "save-succeeded",
            requestId,
            policy: response.policy,
          });
        })
        .catch((error: unknown) => {
          const failure = classifyFallbackSaveFailure(error, "draft");
          dispatch({
            type: "save-failed",
            requestId,
            message: failure.message,
            field,
            outcome: failure.outcome,
          });
          if (failure.outcome === "unknown") {
            void reconcileUnknownSave(requestId).catch(() => {
              // Deliberately nothing. A read-back that fails leaves the notice
              // standing with its own "Check again" - we still do not know -
              // which is reached by NOT dispatching `reconciled`, and that has
              // already happened by the time this runs.
              //
              // `refetchPolicy` returns `null` on a failed read-back because it
              // tests `isSuccess`; it does NOT reach that by the promise
              // rejecting, since `refetch()` resolves with an error-carrying
              // result rather than throwing. So this arm is unreached today,
              // and it is here because that is a library default rather than a
              // guarantee of ours: without it the `void` discard would surface
              // a rejection the renderer never handles, instead of the standing
              // notice promised above.
            });
          }
        });
    },
    [setMutation, reconcileUnknownSave],
  );

  /**
   * "Undo" on a removal toast: the inverse of that one removal, applied to the
   * draft as it stands NOW rather than to the snapshot the toast was raised
   * from. See `FallbackGroupsInverse`.
   */
  const undoGroupsChange = useCallback(
    (inverse: FallbackGroupsInverse): void => {
      const current = stateRef.current;
      const groups = applyGroupsInverse(current.keyedTierGroups, inverse);
      // Nothing to put back - the row is already there, or the group holding it
      // has since been deleted. A commit here would be a save with no change in
      // it.
      if (groups === current.keyedTierGroups) return;
      commit(withTierGroups(current.draft, groups), "tierGroups", groups);
    },
    [commit],
  );

  /**
   * The read that turns a CONFIRMED reset into a rendered one.
   *
   * Shared by the reset itself and by the banner's "Try again", because they
   * are the same act: the host has already replaced the row, and the only thing
   * missing is a read of what it now holds. On success the panel remounts the
   * editor onto that read (`onPolicyReplaced`); on failure the editor stays
   * exactly where it is and the banner says the reset went through and could
   * not be shown.
   *
   * Both outcomes are dispatched from here rather than returned, so the two
   * callers cannot render the same failure two different ways.
   *
   * `requestId` is `null` from the retry, where the reset is long settled and
   * there is no in-flight request left to name.
   */
  const refreshAfterReset = useCallback(
    async (requestId: number | null): Promise<void> => {
      setReadBackInFlight(true);
      try {
        const policy = await refetchPolicy();
        if (policy === null) {
          // A retry that fails changes nothing, and says so by dispatching
          // nothing: the notice this would raise is the notice already on
          // screen, and re-raising it would only re-render the same sentence.
          if (requestId === null) return;
          dispatch({
            type: "reset-unrefreshed",
            requestId,
            message:
              "Your settings were reset, but we couldn't load what's on the host.",
          });
          return;
        }
        onPolicyReplaced();
      } finally {
        setReadBackInFlight(false);
      }
    },
    [refetchPolicy, onPolicyReplaced],
  );

  /**
   * "Restore the default model groups".
   *
   * Dispatches `save-succeeded` with the response, unlike the reset below: a
   * restore does not clear the seed marker, so what comes back IS what a
   * subsequent read would produce and the editor can take it directly.
   */
  const restoreDefaultGroups = useCallback((): void => {
    const requestId = createFallbackSaveRequestId();
    // A restore sends nothing from the screen - the host picks the default
    // groups - so it must not make the displayed values count as dispatched
    // (D339), and if its own reply is lost the notice has to say that the
    // RESTORE is what went unanswered (D347).
    dispatch({
      type: "save-started",
      field: "tierGroups",
      requestId,
      carries: "restore",
    });
    void restoreMutation
      .mutateAsync({})
      .then((response) => {
        dispatch({
          type: "save-succeeded",
          requestId,
          policy: response.policy,
        });
      })
      .catch((error: unknown) => {
        // The same noun the dispatch above carries. Two spellings of "what
        // this request is" would be two things to keep in step, so both read
        // `restore`.
        const failure = classifyFallbackSaveFailure(error, "restore");
        dispatch({
          type: "save-failed",
          requestId,
          message: failure.message,
          field: "tierGroups",
          outcome: failure.outcome,
        });
        if (failure.outcome === "unknown") {
          void reconcileUnknownSave(requestId).catch(() => {
            // Nothing, for the reason spelled out at the `commit()` call site:
            // a read-back that fails leaves the notice standing with its own
            // "Check again", and an unowned rejection would replace that
            // honest state with a renderer error nobody handles.
          });
        }
      });
  }, [restoreMutation, reconcileUnknownSave]);

  /**
   * The reset, which is NOT a `commit`.
   *
   * `commit` sends a draft the controls built and writes the response back into
   * the reducer. A reset replaces the whole row and clears the seed marker, so
   * the authoritative policy afterwards is the one the next READ produces, not
   * the one this call returns. So it reads, and remounts only onto that read -
   * dispatching `save-succeeded` with the response here is the exact bug that
   * would show the user an empty model-group list the host is about to re-seed.
   *
   * The reset and the read are reported separately, because they can differ. The
   * mutation settling means the host confirmed the reset and nothing more; the
   * invalidation the mutation fires does not refetch and could not report a
   * failure if it did (see `use-fallback-policy-reset-mutation.ts`). A failed
   * read after a confirmed reset is therefore NOT a failed reset, and calling it
   * one would tell the user their settings are intact when they have just been
   * cleared.
   */
  const resetAll = useCallback((): void => {
    const requestId = createFallbackSaveRequestId();
    // As the restore above: a reset sends DEFAULTS, not the values on screen,
    // so "what's on screen was sent" must stay unsupported by it (D339), and a
    // lost reply is described as the reset's, not the display's (D347).
    dispatch({
      type: "save-started",
      field: "danger",
      requestId,
      carries: "reset",
    });
    // Two-argument `then`, not `.then(…).catch(…)`. A trailing `catch` sits
    // downstream of the fulfilment handler and so answers for the refresh as
    // well as for the mutation - and the handler below classifies whatever it
    // receives as a failed SAVE, which is the one claim this path must never
    // make about a reset the host confirmed. This form binds it to the
    // mutation's own rejection and nothing else.
    void resetMutation.mutateAsync({}).then(
      () => {
        void refreshAfterReset(requestId).catch(() => {
          // Deliberately nothing, and unreached: `refetchPolicy` reports a
          // failed read by answering `null` rather than by rejecting - the same
          // library fact spelled out at the `commit()` call site. Kept because
          // that is a TanStack default rather than a guarantee of ours, and
          // because an unowned rejection would replace an accurate banner with
          // a renderer error nobody handles.
        });
      },
      (error: unknown) => {
        // `reset`, which is what makes the refusal say so. This handler is
        // bound to the mutation's own rejection and nothing else (see the
        // two-argument `then` above), so it never sees a failed READ - which
        // would not be a refused reset and must not wear this wording.
        const failure = classifyFallbackSaveFailure(error, "reset");
        dispatch({
          type: "save-failed",
          requestId,
          message: failure.message,
          field: "danger",
          outcome: failure.outcome,
        });
        if (failure.outcome === "unknown") {
          void reconcileUnknownSave(requestId).catch(() => {
            // Nothing, for the reason spelled out at the `commit()` call site:
            // a read-back that fails leaves the notice standing with its own
            // "Check again", and an unowned rejection would replace that
            // honest state with a renderer error nobody handles.
          });
        }
      },
    );
  }, [resetMutation, refreshAfterReset, reconcileUnknownSave]);

  const checkSaveOutcomeAgain = useCallback((): void => {
    const unknown = stateRef.current.unknownSave;
    if (unknown === null) return;
    // The "Check again" button, so this is the call a person reaches
    // DELIBERATELY - and the one whose failure the standing notice already
    // describes. Same guard and same reason as the `commit()` call site.
    void reconcileUnknownSave(unknown.requestId).catch(() => {
      // Nothing: the notice and its "Check again" stay exactly as they are,
      // which is the honest state when the read-back could not answer either.
    });
  }, [reconcileUnknownSave]);

  /**
   * The banner's "Try again" - the second half of the reset, retried on its
   * own.
   *
   * Distinct from `checkSaveOutcomeAgain`, which asks the host what it stored
   * for a save whose answer never came and may adopt what comes back into this
   * editor. Nothing is in question here: the reset is confirmed and the host's
   * row is known, so this only reads it, and a successful read remounts the
   * editor exactly as the reset itself would have.
   */
  const retryResetRefresh = useCallback((): void => {
    void refreshAfterReset(null).catch(() => {
      // Nothing, and unreached: same reason as at the `resetAll` call site.
    });
  }, [refreshAfterReset]);

  const enabledRungs = new Set(state.draft.ladder);
  const saveInFlight = fallbackSaveInFlight(state);
  const saveStatusFor = (
    field: FallbackPolicyField,
    className: string,
  ): ReactNode => (
    <FallbackSaveStatus
      state={state}
      field={field}
      className={className}
      saveInFlight={saveInFlight}
      readBackInFlight={readBackInFlight}
      onCheckAgain={checkSaveOutcomeAgain}
    />
  );

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
      {storedPolicyUnreadable ? <UnreadablePolicyNotice /> : null}
      {state.unrefreshedReset === null ? null : (
        <UnrefreshedResetNotice
          message={state.unrefreshedReset.message}
          // The banner's strongest sentence is about the VALUES on screen, and
          // it expires the moment they change: after an edit the display is the
          // user's own draft, which a save since may well have stored. What
          // stays true either way is that the reset's result has never been
          // read, so the weaker sentence takes over rather than the banner
          // going away.
          //
          // The revision compared here is the reset's DISPATCH revision, not
          // the one current when its read failed - the read is a round trip and
          // this panel disables only Reset and Restore during it, so a save
          // submitted inside that window had already moved the revision by the
          // time the failure arrived, and the banner called a post-reset policy
          // "the settings you had before the reset".
          //
          // D327 orders the three cases: a ROLLBACK is checked first, because
          // it is neither of the other two and the banner says nothing about
          // provenance there.
          displaySubject={unrefreshedResetSubject(state)}
          readBackInFlight={readBackInFlight}
          onTryAgain={retryResetRefresh}
        />
      )}
      <SettingsGroup
        title="Fallback"
        tone="default"
        dataTestId="settings-fallback-group"
        fill={false}
      >
        <SettingsRow
          label="Automatic fallback"
          description={masterToggleDescription(inFlightCount)}
          control={
            <MasterFallbackToggle
              checked={state.draft.enabled}
              onCheckedChange={(next) => {
                commit({ ...state.draft, enabled: next }, "enabled", null);
              }}
            />
          }
        />
        {saveStatusFor("enabled", "px-5 pb-4")}
        <div className="border-b border-border/40 px-5 py-4 last:border-b-0">
          {state.draft.enabled ? null : (
            <p className="mb-3 text-ui-sm text-muted-foreground">
              Off - these settings take effect when you turn on automatic
              fallback.
            </p>
          )}
          <FallbackLadderEditor
            displayOrder={state.displayOrder}
            enabled={enabledRungs}
            onToggle={(rung, next) => {
              const nextEnabled = new Set(enabledRungs);
              if (next) {
                nextEnabled.add(rung);
              } else {
                nextEnabled.delete(rung);
              }
              // Turning a step ON may have to move it: an externally authored
              // policy can store `notify` early, and a step sitting after the
              // terminal step is one that can never run. Disabling deliberately
              // does NOT move anything, so the row can be below `notify` by the
              // time it is switched back on.
              //
              // That is the only way left for a row to arrive there enabled -
              // `moveFallbackRung` refuses a move whose ends straddle the fixed
              // slot, and a hydrated policy is rendered as stored, never
              // rewritten. It is the only one because that rule exists, not
              // because a fixed slot implies it: holding `notify` still says
              // nothing about the other rows crossing it. Same
              // dispatch-then-commit shape as `onMove`, so what is sent and what
              // is shown stay the same order.
              const nextOrder = next
                ? fallbackDisplayOrderEnabling(state.displayOrder, rung)
                : state.displayOrder;
              if (nextOrder !== state.displayOrder) {
                dispatch({ type: "reordered", displayOrder: nextOrder });
              }
              commit(
                {
                  ...state.draft,
                  ladder: [...fallbackLadderFrom(nextOrder, nextEnabled)],
                },
                "ladder",
                null,
              );
            }}
            onMove={(from, to) => {
              const nextOrder = moveFallbackRung(state.displayOrder, from, to);
              // The move was refused - an out-of-range index, or one whose ends
              // straddle the fixed `notify` slot. The arrows are disabled at
              // that boundary, but a DRAG can still ask, and the answer has to
              // be nothing rather than a save carrying the order that is
              // already stored. Same rule and same reason as `undoGroupsChange`.
              if (nextOrder === state.displayOrder) return;
              dispatch({ type: "reordered", displayOrder: nextOrder });
              commit(
                {
                  ...state.draft,
                  ladder: [...fallbackLadderFrom(nextOrder, enabledRungs)],
                },
                "ladder",
                null,
              );
            }}
            profileStepHint={<ProfileStepHint />}
            // The DRAFT, not the persisted policy, and that is the whole reason
            // this evaluates client-side: the hint has to answer for what is on
            // screen, so editing the equivalent models below clears it the
            // moment the user adds a destination for their own model. A host
            // call could only answer for what is saved.
            tierStepHint={<TierStepHint policy={state.draft} />}
          />
          {saveStatusFor("ladder", "mt-3")}
        </div>
      </SettingsGroup>
      <FallbackBehaviorGroup
        policy={state.draft}
        onChange={(next) => {
          commit(next, "behavior", null);
        }}
        status={saveStatusFor("behavior", "px-5 pb-4")}
      />
      {/* Lane G3's FC8 surface, mounted here rather than inside the groups
          editor: it edits `destinationExclusions`, a policy field of its own,
          and the groups editor owns `tierGroups`. `null` identities are
          correct BECAUSE of that - the exclusion never adds, removes or
          reorders a candidate row, so the rows keep the identities they have.
          If that ever stops being true this mount is wrong and has to carry a
          keyed list instead. `field: "tierGroups"` only decides which group
          the panel's one status line renders under, which is the group this
          control sits above. */}
      <FallbackAllowedDestinations
        policy={state.draft}
        onChange={(next) => {
          commit(next, "tierGroups", null);
        }}
      />
      <FallbackTierGroupsEditor
        policy={state.draft}
        groups={state.keyedTierGroups}
        // `null` on anything short of an answer - an older host, a read in
        // flight, a refused read, an invalid draft. It renders no verdict line
        // at all, which is the honest absence; the alternative is a client-side
        // guess at what a family resolves to, and the renderer has none of the
        // inputs that question needs.
        preview={previewQuery.data?.candidates ?? null}
        labelFor={profileLabelFor}
        effortOptions={effortOptions}
        previewPending={previewQuery.isFetching}
        // The distinction `preview` cannot make (FC9). `preview` is
        // data-or-null and a null renders no line, so a FAILED check was
        // indistinguishable from a host that was never asked - the user got no
        // answer, no explanation and no way to ask again. `isError` is the one
        // fact that separates them, and it is false for both of the reasons
        // this query answers nothing on purpose: a gate that is closed (an
        // invalid draft, groups the editor is not showing) leaves the query
        // disabled and `pending`, and an older host that does not advertise the
        // method never runs it either. So this is exactly "we asked and it
        // failed", which is exactly the state a retry can fix.
        previewUnavailable={previewQuery.isError}
        onRetryPreview={() => {
          void previewQuery.refetch();
        }}
        onChange={(next, groups) => {
          editDraft(next, "tierGroups", groups);
        }}
        onCommit={(next, groups) => {
          commit(next, "tierGroups", groups);
        }}
        onUndo={undoGroupsChange}
        onRestoreDefaults={restoreDefaultGroups}
        // Also while an ordinary save is in flight: a restore replaces the whole
        // list, and starting one on top of an unanswered `set` would leave two
        // answers about the same rows racing each other into the draft.
        restorePending={restoreMutation.isPending || saveInFlight}
        status={saveStatusFor("tierGroups", "mt-3")}
      />
      <FallbackOverridesMatrix
        policy={state.draft}
        // The editor's four-row order, not the ladder: a step the base ladder
        // does not contain can still be turned ON for one failure, and it has
        // to land where the user put it rather than at the end.
        rungOrder={state.displayOrder}
        onChange={(next) => {
          commit(next, "overrides", null);
        }}
        status={saveStatusFor("overrides", "mt-3")}
      />
      <FallbackDangerZone
        hostLabel={hostLabel}
        isPending={saveInFlight}
        onConfirm={resetAll}
        focusResetOnMount={returnFocusToReset}
        onFocusApplied={onFocusReturned}
        status={saveStatusFor("danger", "px-5 pb-4")}
      />
    </div>
  );
}

/**
 * The master switch, as a component so it can READ its row's description.
 *
 * `SettingsRow` publishes its description's id through
 * `SettingsRowDescriptionContext`, and only something rendered INSIDE the
 * `control` slot is below that provider - which the inline `<Switch>` this
 * replaces was not, being JSX built one component up. So the switch carried a
 * bare `aria-label` and the paragraph explaining what turning it off does
 * ("Recovery already in progress continues; stop it from the chat. … 2 in
 * progress right now.") was visible text with no programmatic relationship to
 * the control it explains. The two timing Selects in the Behavior group
 * already consume the same context; this is the row that did not (AX8).
 *
 * The count in that description is the reason it matters more here than
 * elsewhere: it is the fact the toggle DECISION turns on, and a keyboard user
 * landing on the switch had no way to hear it.
 */
function MasterFallbackToggle(props: {
  readonly checked: boolean;
  readonly onCheckedChange: (next: boolean) => void;
}): ReactNode {
  const describedById = useSettingsRowDescriptionId();
  return (
    <Switch
      checked={props.checked}
      onCheckedChange={props.onCheckedChange}
      aria-label="Automatic fallback"
      aria-describedby={describedById}
    />
  );
}

/**
 * What the master switch does, in three sentences - and the third is the one
 * that is not obvious.
 *
 * Fixed copy, agreed as written. Each sentence answers a question the previous
 * wording left open:
 *
 *  - **what stops** - NEW recovery, not the feature's effects;
 *  - **what does not** - work already in progress runs to its end, and the
 *    place to stop THAT is the chat's own card, which has the stop action. A
 *    user who reads "turning this off stops fallback" and then watches a chat
 *    go on waiting has been told something false by omission;
 *  - **what this switch is not.** Claude Code, Codex and the rest have their
 *    own retry and fallback behaviour, and this page does not reach it. Without
 *    the sentence, a user turning this off can reasonably believe they have
 *    stopped ALL automatic recovery on their machine, and then be surprised by
 *    their coding agent's own. That belief is the expensive one, because the
 *    remedy for it is in a different product.
 *
 * "Traycer recovery" rather than "fallback" as the subject of the first
 * sentence, for the same reason: the noun has to be ours specifically, or the
 * third sentence has nothing to contrast with.
 */
const MASTER_TOGGLE_DESCRIPTION =
  "Stops new Traycer recovery. Recovery already in progress continues; stop it from the chat. Your coding agent's own recovery settings are unchanged.";

/**
 * The master toggle's helper, plus the count the decision turns on.
 *
 * The count is polled while the page is open, by
 * `useFallbackInFlightCountQuery`: "right now" is a claim about the present,
 * and the policy read that also carries it is read once. It is deliberately a
 * plain number with no link: every chat that is holding or waiting already
 * shows its own card with its own stop action, and a list here would be a
 * second place to act on them. It is APPENDED to the fixed copy rather than
 * woven into it -
 * "stop it from the chat" is where a reader is sent, and how many there are is
 * a separate fact that is absent when it is zero.
 */
function masterToggleDescription(inFlightCount: number): string {
  if (inFlightCount === 0) return MASTER_TOGGLE_DESCRIPTION;
  return `${MASTER_TOGGLE_DESCRIPTION} ${inFlightCount} in progress right now.`;
}

/**
 * What the panel says when the stored policy could not be read.
 *
 * The host answers a corrupt row with the DEFAULT policy plus this flag rather
 * than throwing, precisely so this page still renders and the user can
 * overwrite it - a panel that failed to load would leave the bad row with no
 * way to replace it. So the copy has to be clear that what is on screen is not
 * what is stored, and that saving is the repair.
 */
/**
 * A reset the host confirmed, whose result this page could not read.
 *
 * A banner rather than a line under the danger zone, because it is not about
 * the button that was pressed - it is about every control above it. The reset
 * SUCCEEDED and cleared the seed marker, so the host's row is now the default
 * plus whatever the next read re-seeds; the values still rendered are the ones
 * from before it. That is a claim about the whole editor, and it has to sit
 * where the whole editor is, next to the other notice that says the same kind
 * of thing.
 *
 * "Try again", not "Check again": there is nothing to check. The question the
 * unknown-outcome notice asks - what did the host store? - is already answered
 * here, and only the read is outstanding.
 */
/**
 * What the controls are currently showing, which decides how much the staleness
 * banner is entitled to say about them.
 *
 * Three, not the two this was a boolean for. The third arrived with the fifth
 * pass: a refusal ROLLBACK is neither the pre-reset policy nor the user's own
 * edit, and calling it "your own edit" put the banner in direct contradiction
 * with the save notice under the control, which was simultaneously describing
 * the same values as the settings from before the reset.
 *
 * A union rather than a second boolean so the impossible pair cannot be
 * spelled, and so the `switch` below is exhaustive - a fourth subject becomes a
 * compile error rather than a silently missing sentence.
 */
type UnrefreshedResetSubject = "pre-reset-values" | "own-edit" | "rollback";

/**
 * The banner's body, which is the only part that varies.
 *
 * Written out per case rather than assembled from a shared clause: the shared
 * half differs in capitalisation between the two forms that carry it, and
 * splicing that at runtime made a sentence harder to read than the duplication
 * it saved.
 */
function unrefreshedResetBody(subject: UnrefreshedResetSubject): string {
  switch (subject) {
    // D330: a reset that succeeded proves the host WROTE something, not that
    // what it wrote differs from this. Resetting an already-default policy
    // yields the same values back, and the follow-up get that would have shown
    // that is exactly the request that failed - so the old "not what this host
    // is using now" asserted an inequality the client cannot know.
    case "pre-reset-values":
      return "The settings below are the ones you had before the reset - they may not be what this host is using now; the settings on this host haven't been re-read since the reset.";
    case "own-edit":
      return "You have changed things since, so what's below is your own edit. Either way, what the reset left on this host has not been read yet.";
    // D327: the notice under the control already says where these values came
    // from ("your last saved settings are back on screen", or that they still
    // predate the reset). The banner's subject is the RESET, so here it says
    // only that, and the two stop making the same decision in two places.
    case "rollback":
      return "What the reset left on this host has not been read yet.";
  }
}

function UnrefreshedResetNotice(props: {
  readonly message: string;
  /**
   * What the controls hold right now - see {@link UnrefreshedResetSubject}.
   *
   * `pre-reset-values` is the only case where the banner names the displayed
   * values as out of date. Once anything has been submitted since the reset
   * went out, that is the user's own draft, which a save since may have stored;
   * and once a refusal has rolled the display back, D327 gives the provenance
   * sentence to the save notice and leaves this banner with its own subject -
   * the reset - alone. Two places describing one set of values is how the two
   * of them came to disagree.
   */
  readonly displaySubject: UnrefreshedResetSubject;
  readonly readBackInFlight: boolean;
  readonly onTryAgain: () => void;
}): ReactNode {
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-5 py-4"
      data-testid="fallback-reset-unrefreshed"
    >
      <div className="font-medium text-ui-sm text-amber-600 dark:text-amber-400">
        {props.message}
      </div>
      {/* A `div`, not the `p` its sibling notice uses: this one carries a
          button, and a spinner inside a paragraph is invalid nesting the
          moment the retry is running. */}
      <div className="mt-1 max-w-[68ch] text-ui-sm text-muted-foreground">
        {unrefreshedResetBody(props.displaySubject)}
        <Button
          type="button"
          variant="link"
          className="ml-1 h-auto p-0 text-ui-sm"
          disabled={props.readBackInFlight}
          onClick={props.onTryAgain}
          data-testid="fallback-reset-retry"
        >
          Try again
          {props.readBackInFlight ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant="orbit"
            />
          ) : null}
        </Button>
      </div>
    </div>
  );
}

function UnreadablePolicyNotice(): ReactNode {
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-5 py-4"
      data-testid="fallback-policy-unreadable"
    >
      <div className="font-medium text-ui-sm text-amber-600 dark:text-amber-400">
        Your saved fallback settings couldn&apos;t be read
      </div>
      <p className="mt-1 max-w-[68ch] text-ui-sm text-muted-foreground">
        These are the defaults, not your settings. Automatic fallback is not
        running for you until you save - changing anything here replaces the
        unreadable copy.
      </p>
    </div>
  );
}

/**
 * The inline account of the last write, and it states BOTH values on purpose.
 *
 * A user who has just been told "couldn't save" needs to know which of the two
 * things they are looking at: their own edit (kept, so they can fix it) or the
 * value that is actually in force (restored, because the host refused theirs).
 * Saying only that something failed leaves the control ambiguous.
 */
function FallbackSaveStatus(props: {
  readonly state: FallbackPolicyDraftState;
  /** Renders only for the group the last edit came from. */
  readonly field: FallbackPolicyField;
  /** Alignment for the group this is rendered inside; groups differ. */
  readonly className: string;
  readonly saveInFlight: boolean;
  /** A read-back is running, so "Check again" is already answered. */
  readonly readBackInFlight: boolean;
  readonly onCheckAgain: () => void;
}): ReactNode {
  const {
    localError,
    hostError,
    activeField,
    unrefreshedReset,
    unknownSave,
    lastConfirmedRequestId,
  } = props.state;
  // D330. After a reset whose read failed, `persisted` is the PRE-reset policy
  // and the host's row has been replaced by something nobody here has seen. It
  // stops being unverified only when a post-reset write is confirmed (a read
  // that succeeds clears the banner outright, so `unrefreshedReset !== null`
  // already means no read has landed since).
  //
  // Every sentence claiming a value "is in force" or naming what the host "is
  // using" needs this, not just the revert arm that first needed it: two
  // refusals with no post-reset success leave the pre-reset policy on screen
  // and EQUAL to `persisted`, and equality with an invalidated baseline is not
  // evidence that the baseline is current.
  const persistedUnverified =
    unrefreshedReset !== null &&
    !(
      lastConfirmedRequestId !== null &&
      lastConfirmedRequestId > unrefreshedReset.requestId
    );
  const { saveInFlight, readBackInFlight, onCheckAgain } = props;
  // One status PLACE for the whole panel, under the group that was last acted
  // on - which is where the person is looking, and where a message about
  // "your edit" has to be to mean anything. One place, not one message: what
  // `activeField` decides is WHERE this renders, and the block below is what
  // decides how much it has to say there.
  const mine = activeField === props.field;
  if (!mine) return null;
  // BOTH, when both are set, rather than the local error returning first.
  //
  // They are statements about different things - "what you just typed is
  // invalid and was not sent" and "an earlier request's outcome is unknown" -
  // and only one of them was ever a reason to hide the other. The collision is
  // reachable now that a failure preserves a validation error it did not judge:
  // the failure also claims `activeField`, so its own notice landed in a group
  // whose status line was already spoken for, and an early return took the
  // notice AND the only "Check again" off the page while its ticket stayed
  // open. That is the R9 defect from the other side - an affordance dropped
  // because a rendered claim was keyed on something other than the fact it
  // describes - and it predates the preservation on the `refused-kept` arm,
  // which never wrote `localError` and so could always be masked by one.
  if (localError !== null || hostError !== null) {
    return (
      <div className={cn("space-y-1", props.className)}>
        {localError === null ? null : (
          <p
            role="alert"
            className="text-ui-sm text-destructive"
            data-testid="fallback-local-error"
          >
            {localError} Your edit was kept so you can fix it - nothing has been
            saved.
          </p>
        )}
        {hostError === null ? null : (
          <div
            role="alert"
            className="text-ui-sm text-destructive"
            data-testid="fallback-host-error"
          >
            {hostError.message}{" "}
            {saveNoticeConsequence(
              hostError.outcome,
              saveNoticeStatus(props.state, persistedUnverified),
            )}
            {/* Gated on the TICKET, not on the notice that accompanied it. A
                newer save that succeeds discharges the ticket, and this button
                then re-read for a request that was no longer outstanding and
                returned immediately - a control that looked like recovery and
                did nothing. Both outcomes that carry a ticket offer it. */}
            {unknownSave !== null &&
            (hostError.outcome === "unknown" ||
              hostError.outcome === "refused-unverified") ? (
              <Button
                type="button"
                variant="link"
                className="ml-1 h-auto p-0 text-ui-sm"
                disabled={readBackInFlight}
                onClick={onCheckAgain}
                data-testid="fallback-check-again"
              >
                Check again
                {readBackInFlight ? (
                  <AgentSpinningDots
                    className="ml-1"
                    testId={undefined}
                    variant="orbit"
                  />
                ) : null}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }
  if (saveInFlight) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-ui-sm text-muted-foreground",
          props.className,
        )}
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant="orbit"
        />
        <span role="status">Saving…</span>
      </div>
    );
  }
  return null;
}

/**
 * Why the "another profile" step may be inert, said on the step itself.
 *
 * Only three providers have managed profiles at all, and the step can only
 * move a chat to an account that exists. A user with none has a step they can
 * turn on that will never once fire, which is the worst of the three states -
 * so it says so, and links to where the account is added.
 *
 * Provider-neutral copy, unlike the chat-side card which names the provider
 * that just failed: Settings has no failure and therefore no provider to name,
 * and naming one of the three arbitrarily would be worse than naming none.
 */
function ProfileStepHint(): ReactNode {
  const providers = useProvidersList({ enabled: true, subscribed: true });
  if (providers.data === undefined) return null;
  const hasSecondAccount = providers.data.providers.some(
    (provider) =>
      providerSupportsManagedProfiles(provider.providerId) &&
      provider.profiles.length > 0,
  );
  if (hasSecondAccount) return null;
  return (
    <p className="text-ui-sm text-muted-foreground">
      No other accounts to switch to yet.{" "}
      {/* `navigateToSettingsSection`, not a router `Link`. Settings renders in
          two places - a modal overlay and a system tab - and a panel cannot
          tell which is hosting it; a `Link` navigates the router, which is
          wrong under the overlay. That helper asks the modal bridge and does
          the right thing either way. */}
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-ui-sm"
        onClick={() => {
          navigateToSettingsSection("providers");
        }}
      >
        Add a profile in Providers
      </Button>
    </p>
  );
}

/**
 * Why the "equivalent model" step may be inert FOR THIS USER, said on the step.
 *
 * ## The subject problem, and how it is answered rather than dodged
 *
 * `ProfileStepHint` above can be provider-neutral because its fact is global:
 * no managed accounts anywhere means that step can never fire for any chat.
 * This step's inertness is PER MODEL - a user can have a full page of
 * equivalent models and still have a step that never fires, because the model
 * their chats actually run belongs to none of them. `claude/default` is that
 * case and it is the commonest Claude setup there is: group membership matches
 * the model SLUG, and `default`'s family lives only in its catalog label.
 *
 * Settings has no failed tuple to name, so the subject is the one the user
 * would recognise: **the model they last started a chat with on this host**.
 * That is a narrower claim than "your equivalent models are useless", and the
 * sentence says so out loud rather than letting the reader over-read it. It can
 * UNDER-warn - a user who last ran sonnet but whose other chats run `default`
 * sees nothing - and that is the right direction to be wrong in: the error card
 * catches them at the moment it matters, with the same sentence.
 *
 * Host-scoped deliberately (`useAddressableHostId`, which beneath this panel is
 * the panel's own host): the store buckets last-run settings per host because
 * hosts have different catalogs, and reading another host's tuple would name a
 * model this one may not serve.
 *
 * Silent when there is no remembered tuple - a fresh install, or a host nothing
 * has run on. Nothing is known, so nothing is claimed.
 *
 * ## Why the predicate is not a query
 *
 * `tierGroupsNameDestinationFor` is the protocol's, shared with the engine and
 * with the error card's verdict, so this cannot tell a user their step is inert
 * while the engine would have found them a destination. It moved into the
 * protocol FOR this call site: the question is asked about a draft that has
 * never been saved, which no RPC can answer.
 */
function TierStepHint({
  policy,
}: {
  readonly policy: FallbackPolicy;
}): ReactNode {
  const hostId = useAddressableHostId();
  const lastRun = useComposerRunSettingsStore((state) =>
    selectGlobalLastRunSettings(state, hostId),
  );
  if (lastRun === null) return null;
  if (
    tierGroupsNameDestinationFor({
      groups: policy.tierGroups,
      destinationExclusions: policy.destinationExclusions,
      harnessId: lastRun.harnessId,
      model: lastRun.model,
    })
  ) {
    return null;
  }
  return (
    <p className="text-ui-sm text-muted-foreground">
      {/* The SAME sentence the error card prints when it withholds "Switch…",
          from the same function, so a user who meets both is told one thing
          once. What is added here is only the subject clause - Settings is
          speaking about a model the user is not currently looking at, and a
          bare claim would read as a claim about all of them. */}
      {noSwitchDestinationText(fallbackProviderModelLabel(lastRun))} — the model
      you last started a chat with on this host.
    </p>
  );
}

/**
 * What follows the failure's own sentence, and it is the only part that makes a
 * claim about the HOST.
 *
 * Kept beside the outcome union rather than inlined per branch so the FOUR arms
 * are read together: the difference between them is the whole of FC7.
 *
 * ## Why it takes a second argument rather than growing more outcomes
 *
 * The union says what happened to one SAVE. Everything in `status` is a fact
 * about the PAGE at the moment of rendering - what the controls are showing,
 * and what the host has confirmed - which is independent of that save and
 * outlives it. Folding those in would mean an outcome per combination.
 *
 * ## Which arms claim what, because that is what decides the evidence needed
 *
 * TWO arms claim a setting is IN FORCE, not one as this used to say:
 * `refused-reverted` ("your last saved settings are back on screen and still in
 * force") and `refused-kept`'s confirmed branch. Each needs its own evidence,
 * and each was wrong for a different reason before this pass:
 *
 *  - `refused-reverted` reverts to `persisted`, which after an unread reset may
 *    be the PRE-reset policy the host has already discarded - so it would say
 *    "still in force" beside a banner saying those settings are not what the
 *    host is using. But `persisted` is only pre-reset until some write lands
 *    AFTER the reset; once one has, the rollback restores a policy the host is
 *    actively using and the stale sentence becomes the false one. Hence
 *    `persistedUnverified` rather than a bare "is the page stale".
 *  - `refused-kept` claims the DISPLAYED values are stored, and that takes TWO
 *    facts, not one (**D330**). Comparing the values against `persisted`
 *    settles only SAMENESS - see {@link fallbackPolicyValuesEqual} - and
 *    sameness with a copy the host may have discarded is not storage. So this
 *    arm consults `persistedUnverified` too, and where `persisted` is
 *    unverified it gives the same pre-reset account `refused-reverted` gives
 *    rather than claiming force. It deliberately says nothing about which
 *    request was newer: a refusal can arrive for a request OLDER than the one
 *    that succeeded, and it can arrive for a NEWER one that a correcting
 *    rollback then displaced, so any ordering word in this sentence is wrong
 *    half the time.
 *
 * Both of those arms also consult `authorityInvalidated`, and that was the
 * follow-up: `persistedUnverified` is only the CONFIRMED-reset case, so a reset
 * whose own reply was lost left both sentences claiming force over a row nobody
 * had read. The rule is now stated once for all three consumers of display
 * authority - `persistedUnverified || authorityInvalidated !== null` - which is
 * the same input {@link displayAccount} already took. See
 * {@link outstandingOperationAccount} for the sequence and for why the sentence
 * relates the two events with "also" and no order.
 *
 * The remaining two claim nothing about what is stored, and only one of them
 * needs a fact at all: `unknown` names the DRAFT it is uncertain about, which
 * is not always the draft on screen. `refused-unverified` composes unchanged,
 * and says "another change" rather than "an earlier change" for the same
 * ordering reason as above.
 */
/**
 * What the DISPLAYED values' own request is doing, from that request's actual
 * state rather than from a revision comparison (D330), and from POSITIVE
 * evidence rather than from elimination (D339).
 *
 * Two rewrites, one direction. `unknownSave.revision !== revision` was standing
 * in for "the display was never sent" and covered four situations, three of
 * which contradict it: a save in flight, a save the host confirmed, a rollback
 * this reducer performed, and only lastly an edit nobody dispatched. Splitting
 * those four out fixed the three, and left the LAST arm still reached by
 * elimination - which three further sequences satisfy with values that had in
 * fact been sent, because `pendingSaves` is the only record that a request
 * carried them and it is dropped the moment that request settles.
 *
 * So the last arm now asks the question directly, of the values rather than of
 * the request: is this display above everything this editor has ever
 * dispatched? Only that PROVES it unsent. Anything else that reaches the end -
 * dispatched, unconfirmed, unanswered by any outstanding ticket - is
 * `sent-unknown`, which claims neither verdict.
 */
/**
 * Which of the three things the staleness banner is looking at, as one function
 * rather than a nested ternary at the call site.
 *
 * D327 orders the cases and the order is the rule: a ROLLBACK is checked first,
 * because the banner says nothing about provenance there - the notice owns the
 * display's story, and the banner is left saying only that the reset is unread.
 * Otherwise the display is the pre-reset values when its revision is still the
 * one the reset was dispatched at, and the user's own live edit when it is not.
 *
 * Requires `unrefreshedReset` to be set; the banner does not render otherwise.
 */
function unrefreshedResetSubject(
  state: FallbackPolicyDraftState,
): UnrefreshedResetSubject {
  if (draftIsRefused(state)) return "rollback";
  if (state.unrefreshedReset === null) return "own-edit";
  return state.revision === state.unrefreshedReset.revision
    ? "pre-reset-values"
    : "own-edit";
}

type FallbackDisplayDispatch =
  | "unanswered"
  | "rollback"
  | "pending"
  | "confirmed"
  | "sent-unknown"
  | "loaded-unchanged"
  | "uncommitted"
  /**
   * A value the host refused that nothing restored - it is still in the
   * controls because reverting while another outcome was unknown would have
   * claimed the old value is in force.
   *
   * NOT named `refused-kept`, which `FallbackSaveNoticeOutcome` already uses on
   * a DIFFERENT axis: that one is a REQUEST outcome ("the host refused a
   * request that judged some other draft") and is what `saveNoticeConsequence`
   * switches on. A sequence can have either without the other, and two unions
   * in one file sharing a member name is a misreading waiting to happen.
   */
  | "refused-on-screen";

function displayDispatchState(input: {
  readonly revision: number;
  readonly unknownSave: FallbackPolicyDraftState["unknownSave"];
  readonly pendingSaves: FallbackPolicyDraftState["pendingSaves"];
  readonly confirmedViewRevision: number | null;
  readonly lastDispatchedRevision: number | null;
  /**
   * The refusal record IF it describes what is on screen, which carries the
   * disposition the two accounts differ on. `boolean` here was N1: both refusal
   * arms answered `true` and both got the rollback's sentence.
   */
  readonly refused: FallbackRefusedDraft | null;
  /** Whether the displayed values equal `persisted` - SAMENESS only (D330). */
  readonly matchesPersisted: boolean;
}): FallbackDisplayDispatch {
  // The display IS the unanswered draft - the most specific thing that can be
  // said, and the only case where the uncertainty is about what is visible.
  //
  // `carries` is load-bearing, not defensive. A reset or restore whose OWN
  // reply is lost creates an unknown outcome stamped with the revision current
  // at its dispatch - which is the display's revision, since neither sends a
  // draft and neither moves it. Without this check that request's uncertainty
  // is attached to whatever happens to be on screen, including an invalid edit
  // that was never sent anywhere: this arm returns before the positive gate is
  // ever consulted, so the gate cannot save it (D347).
  if (
    input.unknownSave !== null &&
    input.unknownSave.carries === "draft" &&
    input.unknownSave.revision === input.revision
  ) {
    return "unanswered";
  }
  // Checked before the two request lookups: neither refusal arm moves the
  // revision, so what is on screen is this reducer's value or a value the host
  // judged - not any request's live draft.
  //
  // The disposition is READ, not inferred (N1). A refusal that arrives while
  // another outcome is unknown deliberately does not revert, so the value the
  // host TURNED DOWN is still in the controls; calling that "your last saved
  // settings, put back" describes a restore that never happened. The two arms
  // are one `if` because they share the ordering, and two returns because they
  // are two different screens.
  if (input.refused !== null) {
    return input.refused.restoredPersisted ? "rollback" : "refused-on-screen";
  }
  if (input.pendingSaves.some((save) => save.revision === input.revision)) {
    return "pending";
  }
  if (
    input.confirmedViewRevision !== null &&
    input.confirmedViewRevision === input.revision
  ) {
    return "confirmed";
  }
  // The last two arms are the D339 split, and the ORDER is the point: "never
  // sent" is now claimed only on evidence, never by elimination.
  //
  // A display above every revision this editor has dispatched is an edit made
  // after the last thing that went out - that is what PROVES it unsent, and
  // nothing weaker does. Three sequences reach this point with values that were
  // sent: a read-back that adopted them, a correcting rollback that adopted
  // them, and a save that settled without confirming (its `pendingSaves` entry
  // is dropped when it settles, so the lookups above cannot see it). Each was
  // told "hasn't been sent" about values the host had received.
  const neverDispatched =
    input.lastDispatchedRevision === null ||
    input.revision > input.lastDispatchedRevision;
  if (!neverDispatched) return "sent-unknown";
  // Never dispatched splits in two, because "no draft was sent" does not make
  // the display an EDIT (D353). A panel that has only ever loaded a policy has
  // dispatched nothing and been edited by nobody, and calling that "a newer
  // edit that hasn't been sent" is false about both halves of the sentence.
  //
  // The discriminator is the VALUES, not an edit counter: a draft edited and
  // then changed back is, as a statement about what is on screen, what was
  // loaded.
  return input.matchesPersisted ? "loaded-unchanged" : "uncommitted";
}

/** The two independent questions a notice answers, resolved once (D353). */
interface FallbackSaveNoticeStatus {
  /**
   * A reset was confirmed, its read failed, and nothing has confirmed a
   * policy since - so `persisted` is the PRE-reset value and the host's own
   * row is unknown. No sentence may call anything in force while this holds.
   */
  readonly persistedUnverified: boolean;
  /**
   * The values on screen are the SAME as `persisted`. Sameness only; whether
   * `persisted` is still authoritative is `persistedUnverified`.
   */
  readonly draftConfirmed: boolean;
  /** What the displayed draft's own request is doing. */
  readonly displayDispatch: FallbackDisplayDispatch;
  /**
   * What the UNANSWERED request sent, which is a different question from
   * what the display is - and the `unknown` arm is the one place both are
   * spoken about in the same breath.
   */
  readonly unknownCarries: FallbackSaveCarries;
  /**
   * The operation whose unanswered outcome has taken away display authority,
   * or `null` while it is intact (D353). Only the host-claiming sentences
   * read it; the matrix in SETTINGS.md says which those are.
   */
  readonly authorityInvalidated: FallbackSaveCarries | null;
}

/**
 * Resolves everything the notice's two sentences read, so the component that
 * renders them holds no derivation of its own. Every field is derived from the
 * matrix axes in SETTINGS.md and nothing here is a per-case judgement.
 */
function saveNoticeStatus(
  state: FallbackPolicyDraftState,
  persistedUnverified: boolean,
): FallbackSaveNoticeStatus {
  return {
    persistedUnverified,
    // Compared as VALUES. `revision === persistedRevision` was an ordering
    // watermark standing in for this, and the two part company on both
    // adoption paths - a moved-on read-back stamps the revision while keeping
    // a draft it never confirmed, and the correcting rollback adopts a
    // confirmed policy without moving the revision at all. See
    // `fallbackPolicyValuesEqual`.
    //
    // SAMENESS only. That the display equals `persisted` says nothing about
    // whether `persisted` is still what the host holds - that is
    // `persistedUnverified`, and both are needed before anything may be called
    // in force.
    draftConfirmed: fallbackPolicyValuesEqual(state.draft, state.persisted),
    // A notice with the `unknown` outcome always has its ticket, so the
    // fallback here is unreachable; it is `"draft"` because that is the shape
    // every other outcome's sentence already assumes.
    unknownCarries: state.unknownSave?.carries ?? "draft",
    // The authority rule, stated once (D353), now read from the OBLIGATION
    // rather than from the notice (N2). An operation that does not carry the
    // display and has no answer may already have replaced the host's row, so
    // nothing on screen may be called what the host holds until something
    // re-reads it - and that stays true when the next failure replaces the
    // ticket, which is exactly what the previous carrier got wrong. The
    // reducer sets `unverifiedHostRow` only for a reset or restore, so no
    // "is it a draft" test belongs here any more.
    authorityInvalidated: state.unverifiedHostRow,
    displayDispatch: displayDispatchState({
      revision: state.revision,
      unknownSave: state.unknownSave,
      pendingSaves: state.pendingSaves,
      confirmedViewRevision: state.confirmedViewRevision,
      lastDispatchedRevision: state.lastDispatchedRevision,
      refused: refusedDraftOnScreen(state),
      matchesPersisted: fallbackPolicyValuesEqual(state.draft, state.persisted),
    }),
  };
}

/**
 * The account of the display given while `persisted` is a pre-reset policy the
 * host has replaced with something nobody here has read.
 *
 * D330 forbids "is in force", "is what this host is using now", and "no longer"
 * in use while that is true. A successful reset proves the host WROTE
 * something; it does not prove the result differs from what is on screen - an
 * already-default policy reset to defaults yields identical values - so this
 * hedges rather than asserting an inequality no client can know.
 */
const PRE_RESET_ROLLBACK_ACCOUNT =
  "What's back on screen is still the settings from before the reset, which may no longer be what this host is using.";

/**
 * The tail every host-claiming sentence ends in while an operation's outcome is
 * unknown, held as ONE string because three sentences carry it.
 *
 * Only the tail, not the whole clause: two of the three carriers put it after a
 * semicolon and one after a full stop, so the article's capitalisation stays at
 * the call site. Splicing that at runtime is the thing `unrefreshedResetBody`
 * already declined to do, and it is the load-bearing half - the part that must
 * not drift - that lives here.
 */
const OUTSTANDING_OPERATION_TAIL =
  "is also outstanding whose result is unknown, so what the host has now hasn't been re-read.";

/**
 * The account of the host's row when an operation that did NOT carry the
 * display has gone unanswered.
 *
 * ## Why the refusal consequences need this at all
 *
 * `unverifiedHostRow` and `persistedUnverified` are two different ways to lose
 * the right to say what the host holds, and the panel had THREE consumers of
 * that right while only two of them knew it:
 *
 *  - the DISPLAY account ({@link displayAccount}) reads `unverifiedHostRow`;
 *  - the two refusal consequences read `persistedUnverified` and nothing else.
 *
 * `persistedUnverified` is the narrower case - a reset the host CONFIRMED whose
 * read-back failed. A reset whose own reply was LOST never gets that far:
 * `unrefreshedReset` stays null, because nothing confirmed the reset, so
 * `persistedUnverified` is false while the host's row is every bit as unknown.
 * Reachable in four steps: a reset's reply is lost and its read fails, an
 * ordinary save then succeeds (which discharges the read-back ticket but
 * deliberately NOT the row obligation - a save dispatched after a lost reset
 * can still have been overwritten by it), and a later save is refused. The
 * revert then said "your last saved settings are back on screen and still in
 * force" while the host may already be holding defaults.
 *
 * ## Why it claims no order
 *
 * A lost reply is not dated. This state knows a refusal happened and knows an
 * operation is outstanding; it cannot know which the host applied first, so the
 * sentence relates them with "also" and stops. Both orderings were written and
 * both were false in some reachable sequence - the same finding
 * {@link displayAccount}'s confirmed arm records.
 */
function outstandingOperationAccount(carries: FallbackSaveCarries): string {
  return `a ${operationNoun(carries)} ${OUTSTANDING_OPERATION_TAIL}`;
}

function saveNoticeConsequence(
  outcome: FallbackSaveNoticeOutcome,
  status: FallbackSaveNoticeStatus,
): string {
  switch (outcome) {
    case "refused-reverted":
      if (status.persistedUnverified) {
        return `Your edit wasn't saved. ${PRE_RESET_ROLLBACK_ACCOUNT}`;
      }
      // The SECOND way display authority can be gone, and this arm consulted
      // only the first one for a whole pass. See
      // {@link outstandingOperationAccount}.
      if (status.authorityInvalidated !== null) {
        return `Your last saved settings are back on screen; ${outstandingOperationAccount(status.authorityInvalidated)}`;
      }
      return "Your last saved settings are back on screen and still in force.";
    case "refused-kept":
      // The refusal is about a request that judged some other draft, so the
      // question is what is on screen NOW - and "haven't been saved yet" is a
      // claim about that, not about the refusal.
      //
      // Both conditions, not just sameness. Two refusals after an unread reset
      // and with no success since leave the PRE-reset policy on screen and
      // equal to `persisted` - so equality holds while the host is known to
      // hold something else. This arm consults the same evidence the revert arm
      // does, and gives the same account, because it is describing the same
      // restored values.
      if (status.draftConfirmed) {
        if (status.persistedUnverified) {
          return `This change wasn't saved. ${PRE_RESET_ROLLBACK_ACCOUNT}`;
        }
        if (status.authorityInvalidated !== null) {
          return `This change wasn't saved. What's on screen is a different change the host has confirmed; ${outstandingOperationAccount(status.authorityInvalidated)}`;
        }
        return "This change wasn't saved. What's on screen is a different change the host has confirmed, and it is in force.";
      }
      return "The changes you have made since are still on screen and haven't been saved yet.";
    case "refused-unverified":
      return "This change wasn't saved. Another change is still unconfirmed, so what's stored may not be what you last saw.";
    case "unknown":
      // "What's on screen" is only the unanswered draft while the user has not
      // moved on. Where they have, the second sentence must describe what the
      // display's OWN request is doing - saying "hasn't been sent" about a save
      // that is in flight, or one the host has already stored, is a dispatch
      // claim read off a revision comparison.
      if (status.displayDispatch === "unanswered") {
        return "What's on screen is your change, not a confirmed setting - it may or may not have been saved.";
      }
      // The REQUEST account and the DISPLAY account are two different sentences
      // about two different things, and a no-draft request is where they come
      // apart hardest: the thing whose outcome is unknown is the reset, and the
      // thing on screen is whatever the user was editing. Naming the operation
      // matters - calling a restore "the reset" would be this panel's own
      // recurring defect one noun over.
      return `${unknownRequestAccount(status.unknownCarries)} ${displayAccount(status)}`;
  }
}

/**
 * What is uncertain, named as the operation that went unanswered.
 *
 * A draft save keeps the sentence it always had. The other two say what was
 * actually lost, because "that change" is not a thing the user made when the
 * unanswered request was a reset.
 */
/** The operation as the copy names it. */
function operationNoun(carries: FallbackSaveCarries): string {
  switch (carries) {
    case "draft":
      return "save";
    case "reset":
      return "reset";
    case "restore":
      return "restore";
  }
}

function unknownRequestAccount(carries: FallbackSaveCarries): string {
  switch (carries) {
    case "draft":
      return "That change may or may not have been saved.";
    case "reset":
      return "We don't know whether the reset went through - it hasn't been re-read.";
    case "restore":
      return "We don't know whether restoring the default groups went through - it hasn't been re-read.";
  }
}

/**
 * The account of the DISPLAY, from the matrix's first axis (D353, SETTINGS.md).
 *
 * `authorityInvalidated` is the second column of that axis: the right to say
 * what the HOST holds, which an unanswered `reset` or `restore` takes away. Only
 * the two states that make a host claim consult it - the matrix says which, and
 * that is why the rule is applied here once rather than restated per sentence.
 */
function displayAccount(status: {
  readonly persistedUnverified: boolean;
  readonly displayDispatch: FallbackDisplayDispatch;
  readonly authorityInvalidated: FallbackSaveCarries | null;
}): string {
  switch (status.displayDispatch) {
    case "pending":
      return "Another change is being saved.";
    case "confirmed":
      // The one sentence the authority rule bites on. A reset or restore whose
      // reply was lost may already have replaced the row, and nothing has
      // re-read it - so the confirmation is a fact about the PAST, and the
      // sentence keeps it rather than collapsing to "we don't know", which
      // would throw away a confirmation that really did happen (D353).
      if (status.authorityInvalidated !== null) {
        // NO ORDER, in either direction. "before the reset" said the
        // confirmation came first; "since then a reset was sent" said the
        // reset did - and BOTH are unknowable here, which the second wording
        // proved by being false in its own pin's sequence (R dispatched before
        // B was confirmed). A lost reply is not dated: all this state holds is
        // that a confirmation happened and that an operation is outstanding
        // with no answer. The sentence says those two facts and nothing that
        // relates them.
        //
        // The article stays capitalised here and lowercase in the two refusal
        // consequences that carry the same tail, which is why
        // `OUTSTANDING_OPERATION_TAIL` is the tail alone.
        return `What's on screen was confirmed as saved on this host. A ${operationNoun(status.authorityInvalidated)} ${OUTSTANDING_OPERATION_TAIL}`;
      }
      // Describes the DISPLAY's relation to the host, and says nothing about
      // who authored it or when (D347). `confirmedViewRevision` records that
      // the values on screen ARE the host's row; it does not record that they
      // are a change the user made. A read-back can adopt the ORIGINAL policy -
      // neither of the two saves in flight having committed - and confirmation
      // is then recorded over values nobody changed, where "a change you made
      // since has been saved" is false twice over: no change of theirs was
      // saved, and the controls are showing what was there all along.
      return "What's on screen is what this host has saved.";
    case "rollback":
      // Deferring to the rollback account rather than inventing a third
      // description of the same values.
      return status.persistedUnverified
        ? PRE_RESET_ROLLBACK_ACCOUNT
        : "What's back on screen is your last saved settings, put back.";
    case "sent-unknown":
      // Deliberately neutral, and deliberately NOT a dispatch verdict either
      // way. These values reached the host; what it did with them is the one
      // thing nobody here knows, and the two sentences that would resolve it -
      // "hasn't been sent" and "has been saved" - are both false (D339).
      return "What's on screen was sent, but we don't know what the host did with it.";
    case "loaded-unchanged":
      // No host claim at all, which is why this arm has no authority branch:
      // "what was loaded" is a fact about this page, and an unanswered reset
      // cannot make it false (D353).
      return "What's on screen is what was loaded; nothing has been changed since.";
    case "uncommitted":
      return "What's on screen is a newer edit that hasn't been sent.";
    case "refused-on-screen":
      // NOT the rollback's sentence, which is what N1 found this wearing. The
      // host turned this value down and the reducer deliberately did not put
      // `persisted` back - reverting while another outcome is unknown would
      // claim the old value is in force when the lost reply may already have
      // replaced it. So the values on screen were never saved and were never
      // restored, and the two words the rollback account turns on - "saved",
      // "put back" - are both false here. No host claim is made either, so
      // this arm needs no authority branch.
      return "What's on screen is a change the host turned down; it's kept here so you can fix it.";
    // Handled by the caller, which returns before reaching here.
    case "unanswered":
      return "What's on screen is your change, not a confirmed setting.";
  }
}

/**
 * A refused save is not always a refusal, and "nothing was saved" is a claim
 * about the host that most failures cannot support.
 *
 * The three arms are the three things the client actually knows, and the
 * transport's own error classes already draw the line:
 *
 *  - `RetryableTransportError` carries an explicit "the host never dispatched
 *    this request" guarantee (it is the class `createRetryingMessenger` keys
 *    its replay off, which is only safe because of that guarantee), so
 *    "nothing was saved" is TRUE and the revert is right.
 *  - any other `HostTransportFailureError` is the ambiguous case: the frame
 *    went out and no answer came back. The host may have committed and lost
 *    the reply. Claiming the old value is still in force here is at its worst
 *    exactly where it matters - the user turns automatic fallback OFF, the
 *    reply is lost, and the page tells them it is off while the host has it
 *    on. So the draft stands and a read-back settles it.
 *  - anything else came back FROM the host, which judged the value. That is a
 *    refusal, whatever its cause, and reverting is right.
 *
 * `isTransientHostRpcFailure` is deliberately not used: it merges the first
 * two arms, which is the defect, and it also folds in a host-ANSWERED fatal
 * marked `retryable` - which used to print "couldn't reach this host" about a
 * host that had just answered.
 *
 * ## Why it takes the operation
 *
 * One classifier serves all three dispatch sites, and it used to hard-code the
 * SAVE wording for every one of them - so the single refusal a user ever sees
 * for a destructive action read as an ordinary save failure: "Couldn't save:
 * <reason>" for a reset that was turned down. The reset is the one operation
 * where knowing WHICH request failed matters most, because the alternative
 * reading is that a reset went through. The `unknown` outcome already named
 * the operation correctly on its own consequence sentence
 * ({@link unknownRequestAccount}), so the inconsistency was visible inside one
 * panel.
 *
 * `carries` rather than a message per call site: the three arms below are the
 * three things the client KNOWS, and that judgement is the same whichever
 * operation was sent. Only the noun changes.
 */
function classifyFallbackSaveFailure(
  error: unknown,
  carries: FallbackSaveCarries,
): {
  readonly message: string;
  readonly outcome: FallbackSaveFailureOutcome;
} {
  if (!(error instanceof HostRpcError)) {
    return { message: refusedWithoutReason(carries), outcome: "refused" };
  }
  if (error instanceof RetryableTransportError) {
    return { message: unreachableHostMessage(carries), outcome: "refused" };
  }
  if (error instanceof HostTransportFailureError) {
    // No second clause, and that is the change rather than an omission. This
    // arm's outcome is `unknown`, whose consequence sentence already states
    // the uncertainty in the operation's own words - "That change may or may
    // not have been saved", "We don't know whether the reset went through".
    // The old "so we can't tell whether this was saved" said the same thing
    // one sentence earlier, in the wrong noun for two of the three
    // operations, and the two rendered back to back.
    return {
      message: "Lost contact with this host before it answered.",
      outcome: "unknown",
    };
  }
  return {
    message: `${refusalPrefix(carries)}: ${error.message}`,
    outcome: "refused",
  };
}

/**
 * The lead-in to a refusal the host EXPLAINED, which the reason completes.
 *
 * The draft keeps the wording it always had. The other two name what was
 * turned down, because a reset refused is not a save refused and the user has
 * no other way to tell which of the two they pressed was rejected.
 */
function refusalPrefix(carries: FallbackSaveCarries): string {
  switch (carries) {
    case "draft":
      return "Couldn't save";
    case "reset":
      return "Couldn't reset these settings";
    case "restore":
      return "Couldn't restore the default groups";
  }
}

/** A failure with no reason to append - a throw that is not a host answer. */
function refusedWithoutReason(carries: FallbackSaveCarries): string {
  switch (carries) {
    case "draft":
      return "Couldn't save these settings.";
    case "reset":
      return "Couldn't reset these settings.";
    case "restore":
      return "Couldn't restore the default groups.";
  }
}

/**
 * `RetryableTransportError` carries the host's guarantee that the request was
 * never dispatched, so this is the one failure that may say nothing happened -
 * and the verb has to be the operation's own, not "saved".
 */
function unreachableHostMessage(carries: FallbackSaveCarries): string {
  switch (carries) {
    case "draft":
      return "Couldn't reach this host, so nothing was saved.";
    case "reset":
      return "Couldn't reach this host, so nothing was reset.";
    case "restore":
      return "Couldn't reach this host, so nothing was restored.";
  }
}

function FallbackPanelSkeleton(): ReactNode {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-ui-sm text-muted-foreground"
      data-testid="fallback-panel-skeleton"
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant="orbit"
      />
      Loading fallback settings…
    </div>
  );
}
