/**
 * Docs: see ../SETTINGS.md (Agent selection → Auto mode).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useState, type ReactNode } from "react";
import type { AutoJudgeSelection } from "@traycer/protocol/host/auto-mode/contracts";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useAutoJudgeQuery } from "@/hooks/auto-mode/use-auto-judge-query";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import { AutoJudgePicker } from "@/components/settings/panels/auto-judge-picker";
import { AutoPolicyEditorDialog } from "@/components/settings/panels/auto-policy-editor-dialog";
import { useRelativeTimestamp } from "@/lib/relative-time";

/**
 * The two settings the `auto` permission mode depends on: WHICH agent runs
 * Traycer's judge on this machine, and WHAT policy that judge follows.
 *
 * Both are host RPCs, so this section is host-scoped like the agent-selection
 * guide below it - and it renders NOTHING rather than a notice of its own in
 * every state where that host cannot answer:
 *
 *   - a host that predates auto mode advertises neither method (they are
 *     optional capabilities with an `unsupported` degrade), and a row for a
 *     setting the machine has no notion of would be a control that silently
 *     does nothing;
 *   - a scope that is connecting, unreachable or vanished has no client to
 *     read through, so the rows are not MOUNTED (`isHostScopeUsable`, whose
 *     doc spells out why a hidden-but-mounted query is still the wrong host's
 *     query). The panel's copy for those states is the guide section's gate,
 *     one section down; a second identical notice here would just be the same
 *     sentence twice.
 *
 * The cost of skipping the gate's hidden `<Activity>` is that a transient
 * same-host disconnect closes an open policy dialog and drops its draft. That
 * is accepted here and not elsewhere: the judge row holds no draft at all, and
 * the policy dialog is a deliberate, explicitly-saved editing session rather
 * than the always-open editor the guide's Activity was introduced for.
 */
export function AutoModeSettingsSection(): ReactNode {
  const scope = useHostScope();
  const realBinding = useHostBinding();
  const scopedBinding = useScopedHostBinding(scope);
  const judgeSupported = useHostSupportsMethod(scope.hostId, "autoJudge.get");
  const policySupported = useHostSupportsMethod(scope.hostId, "autoPolicy.get");

  if (!isHostScopeUsable(scope.status)) return null;
  if (!judgeSupported && !policySupported) return null;
  const binding = scopedBinding ?? realBinding;
  if (binding === null) return null;

  return (
    <HostRuntimeContext.Provider value={binding}>
      {/* An in-card heading, not a `SettingsGroup`: this panel's body IS one
          card (it has to be - the guide editor fills its remaining height), so
          a group here would nest a card inside a card. */}
      <h2 className="border-b border-border/40 px-5 pt-4 pb-2 font-semibold text-ui-xs text-muted-foreground">
        Auto mode
      </h2>
      {/* Keyed by host: both rows read one machine's settings, and a draft or
          an in-flight pick must never carry across a host switch. A `null`
          host is a key in its own right - no `?? ""` fallback, since the
          transition to and from a real id remounts on its own. */}
      <AutoModeRows
        key={scope.hostId}
        hostId={scope.hostId}
        judgeSupported={judgeSupported}
        policySupported={policySupported}
      />
    </HostRuntimeContext.Provider>
  );
}

function AutoModeRows(props: {
  readonly hostId: string | null;
  readonly judgeSupported: boolean;
  readonly policySupported: boolean;
}): ReactNode {
  return (
    <>
      {props.judgeSupported ? <AutoJudgeRow hostId={props.hostId} /> : null}
      {props.policySupported ? <AutoPolicyRow /> : null}
    </>
  );
}

function AutoJudgeRow(props: { readonly hostId: string | null }): ReactNode {
  const query = useAutoJudgeQuery();
  const setJudge = useAutoJudgeSetMutation();
  const selection = query.data?.selection ?? null;
  // `mutate` (not the whole result object) is the dependency: a
  // `UseMutationResult` is a fresh object every render, and this callback is
  // installed into the picker's store through an effect - churning its
  // identity would re-`set()` that store on every render.
  const mutateJudge = setJudge.mutate;
  const commit = useCallback(
    (next: AutoJudgeSelection) => {
      mutateJudge({ selection: next });
    },
    [mutateJudge],
  );

  return (
    <SettingsRow
      label="Auto mode judge"
      description="The agent that reviews commands while a conversation runs in Auto mode. Traycer's default judge runs on Traycer's own inference and uses your credits. Pick another provider to move that cost onto your own subscription - on a provider Traycer cannot run tool-lessly the judge runs as a full agent session of that provider, with its own system prompt and read-only tools, in an empty scratch directory."
      hint={
        query.isError
          ? "Couldn't read this machine's judge. Reopen Settings to try again."
          : undefined
      }
      control={
        <AutoJudgePicker
          hostId={props.hostId}
          selection={selection}
          // Disabled while the record is still loading so a click cannot
          // commit against - and overwrite - a selection this window has not
          // seen yet.
          disabled={query.data === undefined}
          onCommit={commit}
        />
      }
    />
  );
}

function AutoPolicyRow(): ReactNode {
  const query = useAutoPolicyQuery();
  const setPolicy = useAutoPolicySetMutation();
  // `updatedAt` as it read when the editor opened. Held here rather than in the
  // dialog so it survives the dialog's own re-renders, and captured at OPEN
  // rather than at first load so a stale-edit warning describes this editing
  // session.
  const [editing, setEditing] = useState<{
    readonly loadedUpdatedAt: string | null;
  } | null>(null);
  const data = query.data;

  return (
    <>
      <SettingsRow
        label="Auto mode policy"
        description="Extra rules for the judge: what this machine is, what to approve without asking, and what to never approve. Stored on your account, so every machine's judge follows it. A repository with a .traycer/auto-policy.md file uses that file instead."
        hint={
          query.isError
            ? "Couldn't read your policy. Reopen Settings to try again."
            : undefined
        }
        control={
          <div className="flex min-w-0 items-center gap-3">
            {data === undefined ? null : (
              <AutoPolicySummary body={data.body} updatedAt={data.updatedAt} />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="auto-policy-edit"
              disabled={data === undefined}
              onClick={() => {
                setEditing({ loadedUpdatedAt: data?.updatedAt ?? null });
              }}
            >
              {data !== undefined && data.body !== null && data.body.length > 0
                ? "Edit policy"
                : "Write a policy"}
            </Button>
          </div>
        }
      />
      {editing !== null && data !== undefined ? (
        <AutoPolicyEditorDialog
          initialBody={data.body}
          loadedUpdatedAt={editing.loadedUpdatedAt}
          currentUpdatedAt={data.updatedAt}
          saving={setPolicy.isPending}
          onCancel={() => setEditing(null)}
          onSave={(body) => {
            setPolicy.mutate({ body }, { onSuccess: () => setEditing(null) });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * What the row says about the stored policy without opening it.
 *
 * `updatedAt: null` with a body present is not "never saved" - it is the host
 * serving a cached copy it could not refresh - so the summary says the policy
 * is set and stops there rather than inventing a date.
 */
function AutoPolicySummary(props: {
  readonly body: string | null;
  readonly updatedAt: string | null;
}): ReactNode {
  const { body, updatedAt } = props;
  if (body === null || body.length === 0) {
    return <span className="text-ui-xs text-muted-foreground">Not set</span>;
  }
  // Parsed HERE, and the unparseable case answered here too, so the component
  // below is only ever mounted with a real instant. `Date.parse` is pure - it
  // is `Date.now()` that may not be called during a render, and reaching for it
  // as a stand-in for "no date" would have been an impure read in the one
  // branch that has nothing to show.
  const savedAt = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  if (Number.isNaN(savedAt)) {
    return <span className="text-ui-xs text-muted-foreground">Set</span>;
  }
  return <AutoPolicySavedAt savedAt={savedAt} />;
}

function AutoPolicySavedAt(props: { readonly savedAt: number }): ReactNode {
  // Subscribes this row to the shared 60s tick, so "Saved 2 minutes ago" ages
  // without the panel re-fetching anything.
  const relative = useRelativeTimestamp(props.savedAt);
  return (
    <span className="text-ui-xs text-muted-foreground">Saved {relative}</span>
  );
}
