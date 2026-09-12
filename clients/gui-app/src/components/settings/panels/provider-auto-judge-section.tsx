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
import { useProvidersSetAutoJudge } from "@/hooks/providers/use-providers-set-auto-judge-mutation";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { providerAutoJudgeFor } from "@/lib/providers/provider-auto-judge";
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
 * commands, and "nothing to choose" is still an answer. The flag is also why
 * the switch needs no separate method gate: it rides the same catalog minor as
 * `providers.setAutoJudge` itself, so a host old enough to lack the write is a
 * host that reports the flag `false` (its default) and never draws the select.
 * Nothing renders until the catalog has answered, so the tab never flashes the
 * read-only line at a provider that is about to get the switch.
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
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  const setAutoJudge = useProvidersSetAutoJudge();
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
  const [echo, setEcho] = useState<{
    readonly chosen: AutoJudgeKind;
    readonly against: AutoJudgeKind;
  } | null>(null);
  const value = echo !== null && echo.against === stored ? echo.chosen : stored;

  const harnessId = providerIdToGuiHarnessId(providerId);
  const harnesses = harnessesQuery.data?.harnesses;
  if (harnesses === undefined) return null;
  const hasNativeJudge = harnesses.some(
    (harness) => harness.id === harnessId && harness.nativeAutoJudge,
  );

  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

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
          onValueChange={(next) => {
            // Radix hands back a plain string; only the two members this
            // control renders may reach the wire.
            if (next !== "traycer" && next !== "provider") return;
            if (next === value) return;
            setEcho({ chosen: next, against: stored });
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
        {setAutoJudge.isPending ? <MutedAgentSpinner /> : null}
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
