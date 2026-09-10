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
 * mode.
 *
 * Rendered ONLY for a provider whose catalog row reports
 * `nativeAutoJudge: true` - a switch with one option is not a switch, and every
 * other provider runs Traycer's judge with nothing to choose. That flag is also
 * why this needs no separate method gate: it rides the same catalog minor as
 * `providers.setAutoJudge` itself, so a host old enough to lack the write is a
 * host that reports the flag `false` (its default) and never draws this row.
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
  const hasNativeJudge =
    harnessesQuery.data?.harnesses.some(
      (harness) => harness.id === harnessId && harness.nativeAutoJudge,
    ) ?? false;
  if (!hasNativeJudge) return null;

  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <label
        htmlFor={selectId}
        className="text-ui-sm font-medium text-foreground"
      >
        Auto mode judge
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
      <p className="text-ui-xs text-muted-foreground">
        Who reviews commands while a conversation runs in Auto mode.
        Traycer&apos;s judge works the same way on every provider and follows
        your Auto mode policy; {providerName}&apos;s own classifier decides
        inside the agent, so it is faster and costs nothing extra, and its
        refusals still come to you as an approval.
      </p>
    </div>
  );
}
