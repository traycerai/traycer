import { useId, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeKind } from "@traycer/protocol/host/auto-mode/contracts";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useProvidersSetAutoJudge } from "@/hooks/providers/use-providers-set-auto-judge-mutation";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  providerAutoJudgeFor,
  providersListReportsAutoJudge,
} from "@/lib/providers/provider-auto-judge";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/**
 * Which classifier reviews this provider's actions in the `auto` permission
 * mode - the body of the provider's Permissions tab.
 *
 * A SWITCH only for a provider whose catalog row reports
 * `nativeAutoJudge: true`; a switch with one option is not a switch, so every
 * other provider gets a read-only line instead, naming Traycer's judge and
 * pointing at where that judge is chosen. The line is there because the tab
 * is: a user who opens a provider's Permissions tab is asking who reviews its
 * commands, and "nothing to choose" is still an answer.
 *
 * **TWO gates, not one, and the second is the write's own.** This used to
 * argue that the catalog flag alone was enough - that `nativeAutoJudge` rides
 * the same catalog minor as `providers.setAutoJudge`, so a host lacking the
 * write reports the flag `false` and never draws the select. That is an
 * inference from ONE method's version to ANOTHER's presence, which is exactly
 * what per-method negotiation does not support (root `AGENTS.md`): the setter
 * is registered `degrade: { kind: "unsupported" }`, so the registry itself
 * contemplates a host that answers the catalog and not the write, and the
 * catalog response is not evidence either way. The cost of being wrong is a
 * live-looking selector whose every write fails.
 *
 * Both gates hold their render until they can answer. The catalog answers with
 * `undefined` while loading and the method support with `null` ("no handshake
 * yet", which `useHostMethodSupport` keeps distinct from "absent" for this
 * reason) - so the tab never flashes a read-only line at a provider that is
 * about to get the switch, in either dimension.
 *
 * Reads through the SURFACE's host, like its neighbour
 * `TerminalAgentArgsSection`: this section renders inside the Providers panel's
 * re-provided binding, so the catalog it gates on and the host it writes to are
 * the same machine.
 */
export function ProviderAutoJudgeSection({
  state,
}: {
  readonly state: ProviderCliState;
}) {
  const providerId = state.providerId;
  const selectId = useId();
  // The SURFACE's host, which inside a re-provided binding is the panel's
  // machine rather than the app-wide one - the same host the catalog below is
  // read from and the write would be sent to.
  const hostId = useAddressableHostId();
  const setAutoJudgeSupported = useHostMethodSupport(
    hostId,
    "providers.setAutoJudge",
  );
  // The READ half, which is a different method's version. A host can advertise
  // the setter while negotiating `providers.list@9.0`, and on that line the
  // response never carries `autoJudge` - so the write lands, the invalidated
  // refetch comes back without it, `providerAutoJudgeFor`'s `?? "traycer"`
  // answers, and the control snaps to the opposite of what the host just
  // stored. Writable-but-unreadable is its own state, not a variant of either
  // neighbour.
  const judgeReadable = providersListReportsAutoJudge(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  // Resolved before the mutation rather than inside `onValueChange`, because
  // the write's `MutationScope` is keyed by it and a scope is fixed for the
  // life of the observer. It is a pure projection of the prop either way.
  const harnessId = providerIdToGuiHarnessId(providerId);
  const setAutoJudge = useProvidersSetAutoJudge(harnessId);
  const stored = providerAutoJudgeFor(state);
  // The choice this window just made, held until the host's own echo of it
  // comes back through `providers.list` (the mutation invalidates that read, so
  // it is a round-trip, not forever). Without it the control would snap back to
  // the stored value for the width of that round-trip - and on a host too old
  // to report `autoJudge` at all it would snap back permanently, which is the
  // one case where this is doing more than smoothing a refetch.
  //
  // It carries the value it was echoing AGAINST, which is what lets it expire
  // by DERIVATION instead of by an effect that clears it (`setState` inside an
  // effect is a cascading render, and the linter is right to refuse it). The
  // moment `stored` differs from that baseline the host has spoken since the
  // pick - whether it landed our write or another window's - and the host wins.
  //
  // It also carries WHEN it was made, as the authoritative read's own
  // `dataUpdatedAt`, because expiring by value alone has a hole: if another
  // window sets this provider back to the value we were echoing against before
  // our invalidated refetch lands, `stored` equals `echo.against` again and the
  // echo would mask the host's real answer for the life of the panel. A
  // completed refetch is the round trip ending whether or not the value moved,
  // and `dataUpdatedAt` advances on every successful fetch - including one that
  // returns identical data - which is exactly the fetch counter that fact needs.
  // Both conditions are kept: whichever evidence arrives first retires the echo.
  const [echo, setEcho] = useState<{
    readonly chosen: AutoJudgeKind;
    readonly against: AutoJudgeKind;
    readonly seenAt: number;
  } | null>(null);
  // A second observer on the key the Providers panel already holds, so this
  // costs a subscription and no request.
  //
  // SUBSCRIBED, and the reason is the whole point of this observer. This used
  // to pass `subscribed: false` on the theory that "the panel above owns the
  // refresh, this only needs to read when it lands" - but what this component
  // reads is `isFetching` and `dataUpdatedAt`, which is exactly the LANDING
  // itself, and an unsubscribed observer is never notified of it. The only
  // subscribed ancestor (`ProvidersScopedContent`) reads `isPending` and
  // `isError`, and an identical-data refetch moves neither while structural
  // sharing preserves `data`, so nothing above re-rendered this section when a
  // refresh finished. `ProvidersGlobalStatus` does read `isFetching`, but it is
  // a sibling, so its re-render never reaches here. The observable cost was a
  // control stuck disabled on a stale `isFetching: true` after the refetch had
  // already completed.
  const providersQuery = useProvidersList({
    enabled: true,
    subscribed: true,
  });
  const providersUpdatedAt = providersQuery.dataUpdatedAt;
  // LOCKED THROUGH THE AUTHORITATIVE REFRESH, not just through the write.
  //
  // `useHostScopedMutation` fires its invalidations as `void
  // queryClient.invalidateQueries(...)`, so the mutation reports success while
  // the `providers.list` refetch it triggered is still in flight. Unlocking
  // there opens a window with a specific, reproducible failure: pick B in it,
  // and the read belonging to write A lands first, advances `dataUpdatedAt`,
  // retires B's echo by the rule below, and the control presents the SUPERSEDED
  // A choice while B is still saving. (Measured on the real QueryClient:
  // `mutation.status=success` with `query.fetchStatus=fetching`.)
  //
  // Holding the lock across the refresh removes the window rather than trying
  // to date-order two reads against two writes - a second pick simply cannot be
  // made until the value under the control has settled. The cost is that an
  // unrelated `providers.list` refresh also disables it briefly, which is the
  // honest reading of the same state: the value this control presents is moving.
  const settling = setAutoJudge.isPending || providersQuery.isFetching;
  const value =
    echo !== null &&
    echo.against === stored &&
    echo.seenAt === providersUpdatedAt
      ? echo.chosen
      : stored;

  const harnesses = harnessesQuery.data?.harnesses;
  if (harnesses === undefined) return null;
  // `null` is "no handshake with this host yet", not "absent" - see the header.
  if (setAutoJudgeSupported === null) return null;
  const hasNativeJudge = harnesses.some(
    (harness) => harness.id === harnessId && harness.nativeAutoJudge,
  );

  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  // A host that can store the choice but cannot report it back. NO VALUE LINE
  // here, unlike the branch below: on this line `providerAutoJudgeFor` answers
  // `"traycer"` for every provider whatever is stored, so printing it would be
  // stating a guess as the current setting - the same guess that made the
  // selector snap back after a successful write.
  if (hasNativeJudge && !judgeReadable) {
    return (
      <div
        className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        data-testid="provider-auto-judge-unreadable"
      >
        <p className="text-ui-sm font-medium text-foreground">
          Who reviews {providerName}&apos;s commands
        </p>
        <p className="text-ui-xs text-muted-foreground">
          This machine&apos;s host can&apos;t report which classifier is
          selected for {providerName}, so Traycer won&apos;t guess. Update the
          host to see and change this.
        </p>
      </div>
    );
  }

  // A host that answers the catalog and not the write. The provider DOES have
  // a classifier of its own here, so the "nothing to choose" line below would
  // be false - what is missing is this machine's ability to record the choice,
  // which is a different sentence and a different remedy. The stored value is
  // still shown: it is what the judge will use, and a row that hid it would
  // leave the tab's own question unanswered.
  if (hasNativeJudge && !setAutoJudgeSupported) {
    return (
      <div
        className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        data-testid="provider-auto-judge-unsupported"
      >
        <p className="text-ui-sm font-medium text-foreground">
          Who reviews {providerName}&apos;s commands
        </p>
        <p className="text-ui-sm text-foreground">
          {value === "provider"
            ? `${providerName}'s classifier`
            : "Traycer's judge"}
        </p>
        <p className="text-ui-xs text-muted-foreground">
          This machine&apos;s host can&apos;t change who reviews {providerName}
          &apos;s commands. Update it to choose between {providerName}&apos;s
          own classifier and Traycer&apos;s judge.
        </p>
      </div>
    );
  }

  if (!hasNativeJudge) {
    return (
      <div
        className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        data-testid="provider-auto-judge-readonly"
      >
        <p className="text-ui-sm font-medium text-foreground">
          Who reviews {providerName}&apos;s commands
        </p>
        <p className="text-ui-sm text-foreground">Traycer&apos;s judge</p>
        <p className="text-ui-xs text-muted-foreground">
          {providerName} has no classifier of its own, so Traycer&apos;s judge
          reviews every command while a conversation runs in Auto mode. Which
          agent runs that judge, and the policy it follows, are set under
          Settings ▸ Permissions and apply to every provider alike.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      {/* Not "Auto mode judge": the row under Settings ▸ Permissions carries
          that name too, and THIS is the one that wins - `isProviderJudgedExecution`
          reads the provider's own `autoJudge` alone. Interpolated rather than
          hardcoded to "Claude Code" because the row draws for any provider
          whose catalog entry reports `nativeAutoJudge`; today that is Claude
          Code alone, so it renders exactly that. */}
      <label
        htmlFor={selectId}
        className="text-ui-sm font-medium text-foreground"
      >
        Who reviews {providerName}&apos;s commands
      </label>
      <div className="flex items-center gap-2">
        <Select
          value={value}
          // The repo's pending-mutation rule (gui-app AGENTS.md): `disabled`
          // while in flight, the label untouched, a spinner beside it. The
          // scope below it makes two rapid picks ARRIVE in order; this is what
          // stops the second pick from being made at all while the first is
          // still out, and the two are not interchangeable. Without it,
          // provider → Traycer in quick succession lets the first write's
          // `providers.list` invalidation move `stored` to `provider` while the
          // second is still queued in the scope - which expires the optimistic
          // echo (it holds the value it was echoing AGAINST) and snaps the
          // control back to the SUPERSEDED choice until the second round trip
          // lands. A control presenting an older answer as current is the one
          // outcome this row cannot have.
          disabled={settling}
          onValueChange={(next) => {
            // Radix hands back a plain string; only the two members this
            // control renders may reach the wire.
            if (next !== "traycer" && next !== "provider") return;
            if (next === value) return;
            setEcho({
              chosen: next,
              against: stored,
              seenAt: providersUpdatedAt,
            });
            setAutoJudge.mutate(
              { harnessId, autoJudge: next },
              // A refused write leaves the stored value where it was, so the
              // echo would keep showing a choice that never took. The toast
              // says what happened; this puts the control back in agreement
              // with the host.
              { onError: () => setEcho(null) },
            );
          }}
        >
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="traycer">Traycer&apos;s judge</SelectItem>
            <SelectItem value="provider">
              {providerName}&apos;s classifier
            </SelectItem>
          </SelectContent>
        </Select>
        {/* The spinner follows the same `settling` flag as the lock: a control
            that is disabled with nothing beside it reads as broken, and the
            refresh half of the wait is exactly as real as the write half. */}
        {settling ? <MutedAgentSpinner /> : null}
      </div>
      {/* The appended sentence is the precedence one, and it is on THIS row
          because this is the switch that decides: a provider set to its own
          classifier is not "also using" Traycer's judge with a different
          model, it bypasses the judge and the policy entirely. Without it a
          user who has written an Auto mode policy under Permissions has no way
          to learn that this control turns it off for this provider. */}
      <p className="text-ui-xs text-muted-foreground">
        Who reviews commands while a conversation runs in Auto mode.
        Traycer&apos;s judge works the same way on every provider and follows
        your Auto mode policy; {providerName}&apos;s own classifier decides
        inside the agent, so it is faster and costs nothing extra, and its
        refusals still come to you as an approval. Choosing {providerName}
        &apos;s classifier means Auto mode chats on this provider skip
        Traycer&apos;s judge entirely — the judge and the policy you set under
        Permissions don&apos;t apply here.
      </p>
    </div>
  );
}
