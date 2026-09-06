/**
 * Docs: see ../SETTINGS.md (Fallback).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useReducer, useState, type ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import {
  HostRpcError,
  isTransientHostRpcFailure,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
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
import { useFallbackPolicySetMutation } from "@/hooks/providers/use-fallback-policy-set-mutation";
import { useFallbackPolicyResetMutation } from "@/hooks/providers/use-fallback-policy-reset-mutation";
import { useFallbackPolicyRestoreTierGroupsMutation } from "@/hooks/providers/use-fallback-policy-restore-tier-groups-mutation";
import { useFallbackPolicyPreviewTierGroupsQuery } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";
import { useFallbackSettingsProfileLabels } from "@/components/settings/panels/fallback/fallback-profile-labels";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providerSupportsManagedProfiles } from "@/components/settings/panels/provider-settings-tabs";
import { FallbackLadderEditor } from "@/components/settings/panels/fallback/fallback-ladder-editor";
import { FallbackBehaviorGroup } from "@/components/settings/panels/fallback/fallback-behavior-group";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";
import { FallbackDangerZone } from "@/components/settings/panels/fallback/fallback-danger-zone";
import { FallbackTierGroupsEditor } from "@/components/settings/panels/fallback/fallback-tier-groups-editor";
import {
  keyedGroupsMatch,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import {
  createFallbackPolicyDraftState,
  fallbackLadderFrom,
  fallbackPolicyDraftReducer,
  moveFallbackRung,
  validateFallbackPolicyDraft,
  type FallbackPolicyDraftState,
  type FallbackPolicyField,
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
  /**
   * Bumped when a reset has replaced the stored policy wholesale, to remount
   * the editor onto the refetched read.
   *
   * The editor seeds its reducer once and ignores later reads, which is what
   * stops a background refetch yanking a control out from under someone
   * mid-edit. A reset is the one case where that is wrong: the value it seeded
   * from is gone, and the policy the host will serve is not even the one the
   * reset RETURNED - clearing the seed marker means the next read re-seeds the
   * default model groups. So the reset awaits its own refetch and then remounts,
   * which re-seeds from what the host actually has rather than from the
   * response.
   */
  const [resetGeneration, setResetGeneration] = useState(0);

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
  if (query.data === undefined) return <FallbackPanelSkeleton />;

  return (
    <FallbackPolicyEditor
      // Remount on a host switch so one machine's draft can never be saved to
      // another's policy, and on a reset so the editor re-seeds from the
      // refetched policy. This is also what seeds the reducer, which is why
      // there is no hydration effect anywhere in this file.
      key={`${scope.hostId ?? ""}:${resetGeneration}`}
      initialPolicy={query.data.policy}
      inFlightCount={query.data.inFlightCount}
      storedPolicyUnreadable={query.data.storedPolicyUnreadable}
      hostLabel={scope.host === null ? null : scope.hostLabel}
      onPolicyReplaced={() => {
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
  readonly onPolicyReplaced: () => void;
}): ReactNode {
  const {
    initialPolicy,
    inFlightCount,
    storedPolicyUnreadable,
    hostLabel,
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
   * The one write path. Every control reaches the host through this and nothing
   * else, which is what makes the ticket's two failure kinds a property of the
   * panel rather than of whichever control happened to be edited:
   *
   *  - invalid draft: kept on screen with its error, and NOTHING is sent;
   *  - host rejection: the reducer reverts to the persisted value and prints
   *    the host's reason.
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
      dispatch({ type: "save-started", field });
      void setMutation
        .mutateAsync({ policy: next })
        .then((response) => {
          dispatch({ type: "save-succeeded", policy: response.policy });
        })
        .catch((error: unknown) => {
          dispatch({
            type: "save-failed",
            message: fallbackSaveErrorMessage(error),
            field,
          });
        });
    },
    [setMutation],
  );

  /**
   * The reset, which is NOT a `commit`.
   *
   * `commit` sends a draft the controls built and writes the response back into
   * the reducer. A reset replaces the whole row and clears the seed marker, so
   * the authoritative policy afterwards is the one the next READ produces, not
   * the one this call returns. The mutation therefore awaits its own refetch and
   * the editor remounts onto it - dispatching `save-succeeded` with the response
   * here is the exact bug that would show the user an empty model-group list the
   * host is about to re-seed.
   */
  /**
   * "Restore the default model groups".
   *
   * Dispatches `save-succeeded` with the response, unlike the reset below: a
   * restore does not clear the seed marker, so what comes back IS what a
   * subsequent read would produce and the editor can take it directly.
   */
  const restoreDefaultGroups = useCallback((): void => {
    dispatch({ type: "save-started", field: "tierGroups" });
    void restoreMutation
      .mutateAsync({})
      .then((response) => {
        dispatch({ type: "save-succeeded", policy: response.policy });
      })
      .catch((error: unknown) => {
        dispatch({
          type: "save-failed",
          message: fallbackSaveErrorMessage(error),
          field: "tierGroups",
        });
      });
  }, [restoreMutation]);

  const resetAll = useCallback((): void => {
    dispatch({ type: "save-started", field: "danger" });
    void resetMutation
      .mutateAsync({})
      .then(() => {
        onPolicyReplaced();
      })
      .catch((error: unknown) => {
        dispatch({
          type: "save-failed",
          message: fallbackSaveErrorMessage(error),
          field: "danger",
        });
      });
  }, [resetMutation, onPolicyReplaced]);

  const enabledRungs = new Set(state.draft.ladder);

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
      {storedPolicyUnreadable ? <UnreadablePolicyNotice /> : null}
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
            <Switch
              checked={state.draft.enabled}
              onCheckedChange={(next) => {
                commit({ ...state.draft, enabled: next }, "enabled", null);
              }}
              aria-label="Automatic fallback"
            />
          }
        />
        <FallbackSaveStatus
          state={state}
          field="enabled"
          className="px-5 pb-4"
        />
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
              commit(
                {
                  ...state.draft,
                  ladder: [
                    ...fallbackLadderFrom(state.displayOrder, nextEnabled),
                  ],
                },
                "ladder",
                null,
              );
            }}
            onMove={(from, to) => {
              const nextOrder = moveFallbackRung(state.displayOrder, from, to);
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
          />
          <FallbackSaveStatus state={state} field="ladder" className="mt-3" />
        </div>
      </SettingsGroup>
      <FallbackBehaviorGroup
        policy={state.draft}
        onChange={(next) => {
          commit(next, "behavior", null);
        }}
        status={
          <FallbackSaveStatus
            state={state}
            field="behavior"
            className="px-5 pb-4"
          />
        }
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
        previewPending={previewQuery.isFetching}
        onChange={(next, groups) => {
          editDraft(next, "tierGroups", groups);
        }}
        onCommit={(next, groups) => {
          commit(next, "tierGroups", groups);
        }}
        onRestoreDefaults={restoreDefaultGroups}
        restorePending={restoreMutation.isPending}
        status={
          <FallbackSaveStatus
            state={state}
            field="tierGroups"
            className="mt-3"
          />
        }
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
        status={
          <FallbackSaveStatus
            state={state}
            field="overrides"
            className="mt-3"
          />
        }
      />
      <FallbackDangerZone
        hostLabel={hostLabel}
        isPending={state.saveInFlight}
        onConfirm={resetAll}
        status={
          <FallbackSaveStatus
            state={state}
            field="danger"
            className="px-5 pb-4"
          />
        }
      />
    </div>
  );
}

/**
 * The master toggle's helper.
 *
 * The count is the policy read's `inFlightCount` and is deliberately a plain
 * number with no link: every chat that is holding or waiting already shows its
 * own card with its own stop action, and a list here would be a second place
 * to act on them. What the number is for is the toggle decision - turning
 * fallback off stops NEW failures from switching and leaves these to finish.
 */
function masterToggleDescription(inFlightCount: number): string {
  const base =
    "Turning this off stops new failures from switching. Chats already waiting or switching finish on their own";
  if (inFlightCount === 0) return `${base}.`;
  if (inFlightCount === 1) return `${base} - 1 in progress right now.`;
  return `${base} - ${inFlightCount} in progress right now.`;
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
}): ReactNode {
  const { localError, hostError, activeField, saveInFlight } = props.state;
  // One status line for the whole panel, rendered under the group that was
  // last edited - which is where the person is looking, and where a message
  // about "your edit" has to be to mean anything.
  const mine = activeField === props.field;
  if (!mine) return null;
  if (localError !== null) {
    return (
      <p
        role="alert"
        className={cn("text-ui-sm text-destructive", props.className)}
        data-testid="fallback-local-error"
      >
        {localError} Your edit was kept so you can fix it - nothing has been
        saved.
      </p>
    );
  }
  if (hostError !== null) {
    return (
      <p
        role="alert"
        className={cn("text-ui-sm text-destructive", props.className)}
        data-testid="fallback-host-error"
      >
        {hostError} Your last saved settings are back on screen and still in
        force.
      </p>
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
 * A refused save is not always a refusal.
 *
 * A transport failure says nothing about the value - the host never judged it -
 * so reporting it as a rejected setting would send someone editing a policy
 * that was fine. The two arms are worth keeping apart because they have
 * different fixes: retry, versus change the value.
 */
function fallbackSaveErrorMessage(error: unknown): string {
  if (!(error instanceof HostRpcError)) {
    return "Couldn't save these settings.";
  }
  if (isTransientHostRpcFailure(error)) {
    return "Couldn't reach this host, so nothing was saved.";
  }
  return `Couldn't save: ${error.message}`;
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
