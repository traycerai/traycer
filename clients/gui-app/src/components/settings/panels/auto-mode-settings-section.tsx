/**
 * Docs: see ../SETTINGS.md (Permissions → Auto mode).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  AutoJudgeSelection,
  AutoPolicyGetResponse,
  AutoPolicyReadState,
} from "@traycer/protocol/host/auto-mode/contracts";
import { SettingsGroup } from "@/components/settings/settings-group";
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
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import { AutoJudgePicker } from "@/components/settings/panels/auto-judge-picker";
import { AutoPolicyEditorDialog } from "@/components/settings/panels/auto-policy-editor-dialog";
import { AutoPolicyShippedDialog } from "@/components/settings/panels/auto-policy-shipped-dialog";
import { autoPolicyReadStateFor } from "@/components/settings/panels/auto-policy-document";
import {
  hasShippedAutoPolicySections,
  parseShippedAutoPolicy,
} from "@/components/settings/panels/auto-policy-shipped-document";
import { useRelativeTimestamp } from "@/lib/relative-time";

/**
 * The two settings the `auto` permission mode depends on: WHICH agent runs
 * Traycer's judge on this machine, and WHAT policy that judge follows. The
 * policy row is followed by a read-only view of the rules the judge applies
 * before anyone writes a policy at all, rendered from the shipped document the
 * host sends alongside the account policy.
 *
 * Both are host RPCs, so this section is host-scoped. The Permissions panel
 * wraps it in `HostScopeGate`, which owns the copy for a scope that is
 * connecting, unreachable or vanished; this section still checks
 * `isHostScopeUsable` itself so that the rows are not MOUNTED under a dead
 * scope (the gate hides them in an `<Activity>`, and the hook's doc spells out
 * why a hidden-but-mounted query is still the wrong host's query).
 *
 * A host that predates auto mode advertises neither method (they are optional
 * capabilities with an `unsupported` degrade), and a row for a setting the
 * machine has no notion of would be a control that silently does nothing. The
 * section is the whole page, so it cannot render nothing there - an empty page
 * reads as a broken one - and says so in a sentence instead.
 *
 * The cost of unmounting under a dead scope rather than hiding is that a
 * transient same-host disconnect closes an open policy dialog and drops its
 * draft. That is accepted here and not elsewhere: the judge row holds no draft
 * at all, and the policy dialog is a deliberate, explicitly-saved editing
 * session rather than the always-open editor the guide's Activity was
 * introduced for.
 */
export function AutoModeSettingsSection(): ReactNode {
  const scope = useHostScope();
  const realBinding = useHostBinding();
  const scopedBinding = useScopedHostBinding(scope);
  const judgeSupported = useHostSupportsMethod(scope.hostId, "autoJudge.get");
  const policySupported = useHostSupportsMethod(scope.hostId, "autoPolicy.get");

  if (!isHostScopeUsable(scope.status)) return null;
  const binding = scopedBinding ?? realBinding;
  if ((!judgeSupported && !policySupported) || binding === null) {
    return (
      <p
        className="px-1 text-ui-sm text-muted-foreground"
        data-testid="auto-mode-unsupported"
      >
        This machine&apos;s host predates Auto mode. Update it to choose a judge
        and write a policy.
      </p>
    );
  }

  return (
    <HostRuntimeContext.Provider value={binding}>
      <SettingsGroup
        group={PERMISSIONS.definitions.autoMode}
        showTitle
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        {/* Keyed by host: both rows read one machine's settings, and a draft
            or an in-flight pick must never carry across a host switch. A
            `null` host is a key in its own right - no `?? ""` fallback, since
            the transition to and from a real id remounts on its own. */}
        <AutoModeRows
          key={scope.hostId}
          hostId={scope.hostId}
          judgeSupported={judgeSupported}
          policySupported={policySupported}
        />
      </SettingsGroup>
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
      row={PERMISSIONS.definitions.autoModeJudge}
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
  const [viewingShipped, setViewingShipped] = useState(false);
  const data = query.data;
  // `null` is the fourth state - not loaded yet - and it is kept OUT of
  // `readState` rather than folded into it, for the same reason the wire keeps
  // availability out of `source`: a record that is not here yet has no read
  // state, and pretending it is "fresh" would put the loading spinner's silence
  // and a successful empty read on the same branch. Every consumer below
  // therefore narrows on the pair.
  const readState = data === undefined ? null : autoPolicyReadStateFor(data);
  const unreadable = readState === "unreadable";
  // The shipped rules are BUNDLED with the host, not fetched from the cloud, so
  // they are readable in exactly the state the account policy above is not.
  const shipped = useMemo(
    () => parseShippedAutoPolicy(data?.shippedDefaults ?? ""),
    [data?.shippedDefaults],
  );
  const openEditor = (): void => {
    setViewingShipped(false);
    setEditing({ loadedUpdatedAt: data?.updatedAt ?? null });
  };

  return (
    <>
      <SettingsRow
        row={PERMISSIONS.definitions.autoModePolicy}
        hint={
          query.isError
            ? "Couldn't read your policy. Reopen Settings to try again."
            : undefined
        }
        control={
          <AutoPolicyControl
            policy={data}
            readState={readState}
            onEdit={openEditor}
          />
        }
      />
      {hasShippedAutoPolicySections(shipped) ? (
        <SettingsRow
          row={PERMISSIONS.definitions.autoModeShippedRules}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="auto-policy-shipped-open"
              onClick={() => setViewingShipped(true)}
            >
              See the rules
            </Button>
          }
        />
      ) : null}
      {editing !== null && data !== undefined && readState !== null ? (
        <AutoPolicyEditorDialog
          initialBody={data.body}
          loadedUpdatedAt={editing.loadedUpdatedAt}
          currentUpdatedAt={data.updatedAt}
          readState={readState}
          saving={setPolicy.isPending}
          onCancel={() => setEditing(null)}
          onSave={(body) => {
            setPolicy.mutate({ body }, { onSuccess: () => setEditing(null) });
          }}
        />
      ) : null}
      {viewingShipped ? (
        <AutoPolicyShippedDialog
          sections={shipped}
          // Same gate as the row's own button: there is no editing a policy
          // this host could not read.
          onEditPolicy={data === undefined || unreadable ? null : openEditor}
          onClose={() => setViewingShipped(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The policy row's control: what is stored, and the one button that opens the
 * editor.
 *
 * Its own component rather than inline JSX because the two decisions it makes
 * answer to DIFFERENT questions and are easy to conflate. The button is
 * disabled when the record has not arrived or could not be read - both are
 * "this window does not know what is stored", and a save from either would be
 * blind. Its LABEL is about something else: whether there is a policy to edit,
 * which on an unreadable read is unknown, so it says "Edit policy" rather than
 * inviting a write over something it cannot see. The editor is the only route
 * to Save, which is what makes Save unreachable here rather than merely
 * warned about.
 */
function AutoPolicyControl(props: {
  readonly policy: AutoPolicyGetResponse | undefined;
  readonly readState: AutoPolicyReadState | null;
  readonly onEdit: () => void;
}): ReactNode {
  const { policy, readState } = props;
  const unreadable = readState === "unreadable";
  const hasBody =
    policy !== undefined && policy.body !== null && policy.body.length > 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
      {policy === undefined || readState === null ? null : (
        <AutoPolicySummary
          readState={readState}
          body={policy.body}
          updatedAt={policy.updatedAt}
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="auto-policy-edit"
        disabled={policy === undefined || unreadable}
        onClick={props.onEdit}
      >
        {hasBody || unreadable ? "Edit policy" : "Write a policy"}
      </Button>
    </div>
  );
}

/**
 * What the row says about the stored policy without opening it.
 *
 * `updatedAt: null` with a body present is not "never saved" - it is the host
 * serving a cached copy it could not refresh - so the summary says the policy
 * is set and stops there rather than inventing a date.
 *
 * `readState` is consulted BEFORE `body`, and that order is the whole point of
 * the field: on an unreadable read `body: null` is evidence of nothing, and
 * "Not set" would be this row asserting a policy does not exist because the
 * host could not go and look.
 */
function AutoPolicySummary(props: {
  readonly readState: AutoPolicyReadState;
  readonly body: string | null;
  readonly updatedAt: string | null;
}): ReactNode {
  const { body, updatedAt } = props;
  if (props.readState === "unreadable") {
    return (
      <span className="font-medium text-amber-700 text-ui-xs dark:text-amber-300">
        Couldn&apos;t read your policy
      </span>
    );
  }
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
