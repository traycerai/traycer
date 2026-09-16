/**
 * Docs: see ../SETTINGS.md (Permissions → Auto mode).
 * Update that file whenever this settings surface changes.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  useHostMethodSupport,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useAutoJudgeQuery } from "@/hooks/auto-mode/use-auto-judge-query";
import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import { PERMISSIONS } from "@/components/settings/panels/permissions-settings.definitions";
import { AutoJudgePicker } from "@/components/settings/panels/auto-judge-picker";
import { AutoPolicyEditorDialog } from "@/components/settings/panels/auto-policy-editor-dialog";
import { AutoPolicyShippedDialog } from "@/components/settings/panels/auto-policy-shipped-dialog";
import {
  autoPolicyReadStateFor,
  type AutoPolicyOpeningRead,
} from "@/components/settings/panels/auto-policy-document";
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
  // TRI-STATE, deliberately. The boolean form collapses `null` ("no handshake
  // with this host yet") into `false` ("this host handshook and lacks the
  // method"), and those are opposite facts here: the unsupported verdict below
  // parks every RPC this page owns, and this page's own RPCs are what would
  // produce the handshake that overturns it. A scoped remote host nobody has
  // contacted - or one upgraded in place - would therefore read "predates Auto
  // mode" indefinitely, until some unrelated surface happened to dial it.
  const judgeSupport = useHostMethodSupport(scope.hostId, "autoJudge.get");
  const policySupport = useHostMethodSupport(scope.hostId, "autoPolicy.get");
  const judgeSupported = judgeSupport === true;
  const policySupported = policySupport === true;
  // The probe is what keeps the verdict REFUTABLE: one bounded read of a
  // released-floor method, re-asked when the host's reported version or
  // dialability changes, issued exactly while this page is parked on a `false`.
  // `scope.client`, never the ambient one, so it asks the host this page is
  // showing. Same shape as `ShellSettingsPanel` / `DiagnosticsSettingsPanel`,
  // and it must sit above the branch because hooks may not be conditional.
  const supportUnknown = judgeSupport === null && policySupport === null;
  // The account this window is signed in as, for the rows' key below. Read
  // through the same seam every viewer-scoped surface uses, so the key and
  // `useAutoPolicyQuery`'s `cacheKeyIdentity` can never name different people.
  const viewerUserId = useCloudChatViewerId();
  useHostCapabilityProbe({
    client: scope.client,
    stale: !judgeSupported && !policySupported,
    incarnation: [
      scope.host?.version ?? null,
      scope.host?.connectable ?? false,
    ],
  });

  if (!isHostScopeUsable(scope.status)) return null;
  const binding = scopedBinding ?? realBinding;
  // "Not known yet" is not "predates Auto mode". While the probe is still
  // producing the first handshake the page says nothing rather than accusing a
  // host it has not spoken to - the same fail-toward-silence the composer's
  // disclosure takes, and the reason `useHostMethodSupport` keeps `null`
  // distinct at all.
  if (supportUnknown && binding !== null) return null;
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
        {/* Keyed by VIEWER and host, and both halves are load-bearing.

            The host half is the older one: both rows read one machine's
            settings, and a draft or an in-flight pick must never carry across
            a host switch. A `null` host is a key in its own right - no
            `?? ""` fallback, since the transition to and from a real id
            remounts on its own.

            The VIEWER half closes the case the query partition cannot reach.
            `useAutoPolicyQuery` is keyed by viewer, so B never READS A's
            policy - but partitioning the cache does nothing about a dialog
            already mounted. Switch from A to B directly, on a host that stays
            usable, with B's policy already cached: the query answers from B's
            partition immediately, `data !== undefined` never goes false, the
            editor never hits its unmount branch, and it goes on showing A's
            frozen `body`/`openedWith` while `onSave` now closes over B's
            mutation. The stale-stamp warning cannot help - it compares
            timestamps, which say nothing about WHOSE account this is.

            A remount is the whole fix: it discards the draft, the open state,
            the opening-read generation, the shipped-rules view and the judge
            picker's pending pick together, which is what "discard the outgoing
            viewer's state" means in practice. `""` (no context metadata yet)
            is its own key for the same reason the query's `cacheKeyIdentity`
            treats it as its own bucket.

            `JSON.stringify` rather than a joined string: neither id is
            guaranteed free of whatever separator we would pick (host ids carry
            `:`, which is why `worktreeStagingKeyString` percent-encodes them),
            and a two-element array leaves nothing to reason about. */}
        <AutoModeRows
          key={JSON.stringify([viewerUserId, scope.hostId])}
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
      {props.policySupported ? <AutoPolicyRow hostId={props.hostId} /> : null}
    </>
  );
}

/**
 * Whether this host advertised the WRITE half of an auto-mode setting.
 *
 * Each row is mounted on its `.get`, and the matching `.set` is a separate
 * optional method - all four are registered `degrade: { kind: "unsupported" }`,
 * and per-method negotiation means one is not evidence about the other. A host
 * answering the read and not the write would otherwise draw a live control
 * whose every write fails as unsupported.
 *
 * The BOOLEAN form is safe here where `useHostMethodSupport`'s tri-state is
 * needed above: a row only exists because its `.get` answered `true`, which
 * means a manifest for this host is already recorded, so the sibling lookup
 * cannot be the "no handshake yet" `null`.
 */
function AutoJudgeRow(props: { readonly hostId: string | null }): ReactNode {
  const query = useAutoJudgeQuery();
  const setJudge = useAutoJudgeSetMutation();
  const canWrite = useHostSupportsMethod(props.hostId, "autoJudge.set");
  // Flat rather than nested, and separate from the read failure because the two
  // are different sentences with different remedies: one asks the user to try
  // again, the other to update the machine.
  const writeBlockedHint = canWrite
    ? undefined
    : "This machine's host can't change the judge. Update it to pick a different one.";
  const selection = query.data?.selection ?? null;
  // `mutate` (not the whole result object) is the dependency: a
  // `UseMutationResult` is a fresh object every render, and this callback is
  // installed into the picker's store through an effect - churning its
  // identity would re-`set()` that store on every render.
  const mutateJudge = setJudge.mutate;
  // How many writes this row has had REFUSED. Not a count anyone reads - it is
  // a nonce the picker folds into its seed key so a rejected write rolls the
  // control back onto the record the host actually holds.
  //
  // It has to be a counter rather than a boolean, because two refusals in a row
  // must each roll back: a boolean would already be `true` on the second and
  // change no seed key. `setState` from `useState` is identity-stable, so
  // `commit` keeps its `[mutateJudge]` dependency and the store's setter guard
  // still holds.
  const [refusedWrites, setRefusedWrites] = useState(0);
  // `null` travels through untouched: it is the contract's CLEAR, and the
  // picker's "Use Traycer's default" is what sends it. Widening this callback
  // rather than adding a second one keeps the write on one path - the
  // mutation's host-scoped queue orders a clear against a pick exactly as it
  // orders two picks.
  //
  // The rollback is a per-`mutate` callback rather than the hook's own
  // `onError`, and that is the point: the hook toasts (a fact about the
  // request) while THIS surface owns the control that has to be put back. A
  // hook-level rollback would also have to know about a picker it does not
  // render.
  const commit = useCallback(
    (next: AutoJudgeSelection | null) => {
      mutateJudge(
        { selection: next },
        // The store adopted `next` the moment the user clicked - that is what
        // drove this callback. A refusal leaves the host on the previous
        // record and the cache unchanged, so without this the picker would go
        // on presenting a judge that was never saved until the surface
        // remounted or another write happened to succeed.
        { onError: () => setRefusedWrites((count) => count + 1) },
      );
    },
    [mutateJudge],
  );

  return (
    <SettingsRow
      row={PERMISSIONS.definitions.autoModeJudge}
      hint={
        query.isError
          ? "Couldn't read this machine's judge. Reopen Settings to try again."
          : writeBlockedHint
      }
      control={
        <AutoJudgePicker
          hostId={props.hostId}
          selection={selection}
          effective={query.data?.effective}
          blocked={query.data?.blocked}
          // Two reasons, and they are different failures. Still LOADING: a
          // click would commit against - and overwrite - a selection this
          // window has not seen yet. Still SAVING: the write's scope
          // serializes the requests but nothing stops a second pick, and A's
          // success reseeds the picker to A while B is still queued, so the
          // control would present the superseded judge as current. The repo's
          // pending rule asks for exactly this pair - disabled, label
          // untouched, inline spinner.
          disabled={query.data === undefined || setJudge.isPending || !canWrite}
          saving={setJudge.isPending}
          // SUCCESS, not "has data": a failed read leaves whatever an earlier
          // one cached, and the status line must not describe a stored judge
          // from a response this window never received.
          recordLoaded={query.isSuccess}
          resetNonce={refusedWrites}
          onCommit={commit}
        />
      }
    />
  );
}

function AutoPolicyRow(props: { readonly hostId: string | null }): ReactNode {
  const query = useAutoPolicyQuery();
  const setPolicy = useAutoPolicySetMutation();
  // See `AutoJudgeRow`: the row is mounted on `autoPolicy.get`, and
  // `autoPolicy.set` is its own optional method. Editing is the only route to
  // Save, so refusing to OPEN the editor is where this belongs - the dialog's
  // own gates are about what the record says, not about what this host can do
  // with it.
  const canWrite = useHostSupportsMethod(props.hostId, "autoPolicy.set");
  const writeBlockedHint = canWrite
    ? undefined
    : "This machine's host can't save a policy. Update it to write one.";
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
  const staleRead = readState === "stale";
  // The shipped rules are BUNDLED with the host, not fetched from the cloud, so
  // they are readable in exactly the state the account policy above is not.
  const shipped = useMemo(
    () => parseShippedAutoPolicy(data?.shippedDefaults ?? ""),
    [data?.shippedDefaults],
  );
  // Capture the baseline, THEN go and ask the server whether it still holds.
  //
  // Both halves are load-bearing and the refetch was the missing one. The
  // dialog's stale warning compares `loadedUpdatedAt` against the live
  // `currentUpdatedAt`, and both were read off the same `data` - so they were
  // equal by construction at open and nothing could ever move them apart:
  // `autoPolicy.get` sets `refetchOnWindowFocus: false`, the method policy
  // table gives it no poll, and `refetchOnMount: "always"` fires when the PANEL
  // mounts, not when the editor opens. A window left open while another device
  // saved therefore showed no warning and the save silently replaced that
  // version - the exact loss the warning exists to name.
  //
  // The refetch lands BEHIND the open dialog, which is safe by the dialog's own
  // construction: it freezes `body` and `openedWith` in `useState` initializers
  // at mount, so a newer body cannot overwrite what the user is typing. What
  // moves is `currentUpdatedAt`, which is exactly the signal.
  //
  // The editor still OPENS on the click - the read is not awaited before the
  // dialog appears - but SAVE now waits for it, which is the half an earlier
  // round got wrong. That round wrote off the gap as "a rare silent overwrite"
  // against "a permanent delay on every save", and the second figure was
  // simply not true: this gate covers one round trip immediately after opening,
  // and Save is unreachable until the user has typed an edit, which takes
  // longer than the read in almost every case. What it buys is the whole point
  // of the refetch - a save committed before the authoritative answer lands
  // compares `currentUpdatedAt` against the cached baseline it was seeded from,
  // finds them equal, shows no warning, and last-write-wins over the newer
  // policy.
  //
  // A FAILED opening read keeps Save disabled too, with its own sentence. The
  // alternative - allowing the save because we could not check - is exactly the
  // blind overwrite this exists to stop, and it is the same direction the row's
  // own `unreadable` and `stale` gates already take.
  const refetchPolicy = query.refetch;
  const [openingRead, setOpeningRead] =
    useState<AutoPolicyOpeningRead>("settled");
  // Which opening read the answer belongs to. Close-and-reopen is one gesture
  // away here (the shipped-rules dialog reopens the editor through this same
  // function), and without the generation the FIRST read's late `settled` would
  // unlock Save while the second is still in flight - re-opening the exact hole
  // this closes. Touched only from the handler and the promise arms, never
  // during render.
  const openingReadGeneration = useRef(0);
  const openEditor = (): void => {
    setViewingShipped(false);
    setEditing({ loadedUpdatedAt: data?.updatedAt ?? null });
    const generation = openingReadGeneration.current + 1;
    openingReadGeneration.current = generation;
    setOpeningRead("pending");
    // `refetch()` resolves with an error RESULT rather than rejecting unless
    // the query throws on error, so the first arm is the one that runs; the
    // rejection arm is there because that is a query option, not a contract.
    void refetchPolicy().then(
      (result) => {
        if (openingReadGeneration.current !== generation) return;
        setOpeningRead(result.isError ? "failed" : "settled");
      },
      () => {
        if (openingReadGeneration.current !== generation) return;
        setOpeningRead("failed");
      },
    );
  };

  return (
    <>
      <SettingsRow
        row={PERMISSIONS.definitions.autoModePolicy}
        hint={
          query.isError
            ? "Couldn't read your policy. Reopen Settings to try again."
            : writeBlockedHint
        }
        control={
          <AutoPolicyControl
            policy={data}
            readState={readState}
            canWrite={canWrite}
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
          openingRead={openingRead}
          // The SETTER support, live, not just at the moment the editor opened.
          // Both entry points are gated on it, and the comment on the Edit
          // button reasoned that opening is the only route to Save - true of
          // the ROUTE, and silent about the window AFTER: capability is a
          // property of the connection and is re-recorded on every unary ack,
          // so a host that loses `autoPolicy.set` while keeping `autoPolicy.get`
          // leaves an already-open editor able to issue a write the host will
          // refuse. A gate on an entry point expires when the entry is used.
          canWrite={canWrite}
          onCancel={() => setEditing(null)}
          onSave={(body) => {
            setPolicy.mutate({ body }, { onSuccess: () => setEditing(null) });
          }}
        />
      ) : null}
      {viewingShipped ? (
        <AutoPolicyShippedDialog
          sections={shipped}
          // The SAME gate as the row's own button, restated as one expression
          // because this is a second door into the same editor. It used to be
          // a SUBSET - it checked `unreadable` and not `stale`, so a stale read
          // that the row refused to open could still be opened from here, and
          // the dialog's own stale gate then presented an editor whose Save
          // could never fire. `canWrite` joins for the same reason: a host that
          // cannot save must not be reachable through either door.
          onEditPolicy={
            data === undefined || unreadable || staleRead || !canWrite
              ? null
              : openEditor
          }
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
  /** Whether this host advertised `autoPolicy.set` - see `AutoPolicyRow`. */
  readonly canWrite: boolean;
  readonly onEdit: () => void;
}): ReactNode {
  const { policy, readState } = props;
  const unreadable = readState === "unreadable";
  const stale = readState === "stale";
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
        // STALE is non-editable too, not just unreadable. A stale read is the
        // host serving a copy it could not refresh: the body may already be
        // behind another device AND `updatedAt` is withheld, so
        // `autoPolicyChangedSinceLoad` has nothing to compare and the stale
        // warning cannot fire. Editing from there is a last-write-wins save of
        // a body this window cannot vouch for, over a policy it cannot see -
        // the exact overwrite the warning exists to prevent, with the warning
        // structurally unable to appear. The open-time refetch does not rescue
        // it either: if that read is stale as well, nothing changes.
        // A host that cannot SAVE joins the same list. The editor is the only
        // route to Save, so a live button here would open a dialog whose one
        // action fails - the same shape as the unreadable case, arriving from
        // the write side rather than the read side.
        disabled={
          policy === undefined || unreadable || stale || !props.canWrite
        }
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
  // A STALE read cannot say "Not set". `readState: "stale"` is the host serving
  // a copy it could not refresh, so an empty body there is the ABSENCE IT
  // CACHED, not the account's current state - another device may have saved a
  // policy since. "Not set" is a confident claim about right now, and the row
  // pairs it with a disabled Edit button, so a user is told they have no policy
  // and given no way to look again. Naming the staleness is the honest version,
  // and the wording matches the editor's own stale-read banner.
  //
  // A stale read WITH a body keeps its ordinary rendering below: the body is
  // real, just possibly behind, and the stamp is withheld on that line anyway
  // (`updatedAt` is null on a stale response), so it already falls through to
  // the dateless "Set".
  if (body === null || body.length === 0) {
    return props.readState === "stale" ? (
      <span className="font-medium text-amber-700 text-ui-xs dark:text-amber-300">
        Couldn&apos;t check your policy
      </span>
    ) : (
      <span className="text-ui-xs text-muted-foreground">Not set</span>
    );
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
