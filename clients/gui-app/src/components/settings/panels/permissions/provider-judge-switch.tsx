/**
 * Docs: see ../../SETTINGS.md (Providers ▸ Permissions).
 * Update that file whenever this settings surface changes.
 */
import { useState, type ReactNode } from "react";
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

const LINE_CLASSNAME = "text-ui-sm text-muted-foreground";

/**
 * Who reviews one provider's commands in Auto mode: Traycer's judge, or the
 * provider's own built-in classifier. Providers ▸ {provider} ▸ Permissions is
 * its only home; Settings ▸ Permissions ▸ Judge carries a pointer line to it
 * (`BuiltInReviewerPointer`) and no switch of its own.
 *
 * A SWITCH only for a provider whose catalog row reports `nativeAutoJudge`; a
 * switch with one option is not a switch, so every other provider gets one
 * line naming Traycer's judge. Under the switch, one line says what choosing
 * the classifier costs: your rules don't apply to it, and it replaces
 * Traycer's judge for the provider's conversations.
 *
 * **Two gates, and the second is the write's own.** `nativeAutoJudge` rides
 * the catalog's minor, and `providers.setAutoJudge` is registered `degrade:
 * unsupported`, so a host can answer the catalog and not the write; the cost
 * of inferring one from the other is a live-looking selector whose every write
 * fails. The READ half is a third fact: `providers.list` older than the line
 * that reports `autoJudge` answers `"traycer"` for every provider whatever is
 * stored, and printing that would state a guess as the current setting. Each
 * of those is one line of its own. Every gate holds its render until it can
 * answer, so the control never flashes a read-only line at a provider about to
 * get the switch.
 *
 * Reads through the SURFACE's host - the re-provided binding of whichever
 * Settings page renders it - so the catalog it gates on and the host it writes
 * to are the same machine.
 */
export function ProviderJudgeSwitch(props: {
  readonly state: ProviderCliState;
}): ReactNode {
  const providerId = props.state.providerId;
  const hostId = useAddressableHostId();
  const setAutoJudgeSupported = useHostMethodSupport(
    hostId,
    "providers.setAutoJudge",
  );
  const judgeReadable = providersListReportsAutoJudge(
    useHostMethodSchemaVersion(hostId, "providers.list"),
  );
  const harnessesQuery = useGuiHarnessesQuery({
    enabled: true,
    subscribed: true,
  });
  // Resolved before the mutation: the write's scope is keyed by it and fixed
  // for the life of the observer.
  const harnessId = providerIdToGuiHarnessId(providerId);
  const setAutoJudge = useProvidersSetAutoJudge(harnessId);
  const stored = providerAutoJudgeFor(props.state);
  // The choice this window just made, held until the host's own echo of it
  // comes back through `providers.list` (the mutation invalidates that read).
  // It expires by DERIVATION, not by an effect: the moment `stored` moves off
  // the value it was echoing against, or the authoritative read completes a
  // fetch (`dataUpdatedAt` advances even on identical data), the host wins.
  const [echo, setEcho] = useState<{
    readonly chosen: AutoJudgeKind;
    readonly against: AutoJudgeKind;
    readonly seenAt: number;
  } | null>(null);
  // SUBSCRIBED: what this reads is `isFetching` and `dataUpdatedAt` - the
  // LANDING itself - and an unsubscribed observer is never told of it.
  const providersQuery = useProvidersList({
    enabled: true,
    subscribed: true,
  });
  const providersUpdatedAt = providersQuery.dataUpdatedAt;
  // Locked through the authoritative REFRESH, not just the write: the mutation
  // reports success while the `providers.list` refetch it triggered is still
  // in flight, and a second pick in that window lets the first write's read
  // retire the second's echo and present the superseded choice as current.
  // This is a two-value switch whose value is moving, unlike the Judge tab's
  // model controls, which hold no echo and never lock.
  const settling = setAutoJudge.isPending || providersQuery.isFetching;
  const value =
    echo !== null &&
    echo.against === stored &&
    echo.seenAt === providersUpdatedAt
      ? echo.chosen
      : stored;

  const harnesses = harnessesQuery.data?.harnesses;
  if (harnesses === undefined) return null;
  if (setAutoJudgeSupported === null) return null;
  const hasNativeJudge = harnesses.some(
    (harness) => harness.id === harnessId && harness.nativeAutoJudge,
  );
  const providerName = PROVIDER_DISPLAY_NAMES[providerId];

  if (!hasNativeJudge) {
    return (
      <p className={LINE_CLASSNAME} data-testid="provider-auto-judge-readonly">
        Reviewed by Traycer&apos;s judge. Change it under Permissions.
      </p>
    );
  }
  if (!judgeReadable) {
    return (
      <p
        className={LINE_CLASSNAME}
        data-testid="provider-auto-judge-unreadable"
      >
        This machine&apos;s host can&apos;t report who reviews {providerName}
        &apos;s commands. Update it to see and change this.
      </p>
    );
  }
  const current =
    value === "provider" ? `${providerName}'s classifier` : "Traycer's judge";
  if (!setAutoJudgeSupported) {
    return (
      <p
        className={LINE_CLASSNAME}
        data-testid="provider-auto-judge-unsupported"
      >
        {current}. This machine&apos;s host can&apos;t change it; update it to
        choose.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={value}
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
              // A refused write leaves the stored value where it was; the
              // toast says what happened and this puts the control back.
              { onError: () => setEcho(null) },
            );
          }}
        >
          <SelectTrigger
            aria-label={`Who reviews ${providerName}'s commands`}
            className="w-full min-w-0"
            data-testid="provider-auto-judge-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="traycer">Traycer&apos;s judge</SelectItem>
            <SelectItem value="provider">
              {providerName}&apos;s classifier
            </SelectItem>
          </SelectContent>
        </Select>
        {settling ? <MutedAgentSpinner /> : null}
      </div>
      {/* What choosing the classifier costs. Said here because this is the
          switch's only home; the Judge tab only points to it. */}
      <p className={LINE_CLASSNAME} data-testid="provider-auto-judge-warning">
        Faster and free, but your rules don&apos;t apply to it, and it replaces
        Traycer&apos;s judge for this provider&apos;s conversations.
      </p>
    </div>
  );
}
