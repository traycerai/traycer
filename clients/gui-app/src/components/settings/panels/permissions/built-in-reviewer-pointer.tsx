/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { Fragment, type ReactNode } from "react";
import { Info } from "lucide-react";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useGuiHarnessesQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providerForHarness } from "@/components/settings/panels/auto-judge-selection";
import {
  providerAutoJudgeFor,
  providersListReportsAutoJudge,
} from "@/lib/providers/provider-auto-judge";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * The line under the judge card naming each provider that reviews its own
 * commands, so this judge does not check its conversations, with a link to
 * the one place that changes it: Providers ▸ {provider} ▸ Permissions.
 *
 * Read the way `ProviderJudgeSwitch` reads it: catalog rows with
 * `nativeAutoJudge` whose `providers.list` state is `"provider"` through
 * `providerAutoJudgeFor`. It never states a guess, so it renders nothing while
 * either list is loading, and nothing on a `providers.list` line too old to
 * report `autoJudge`, where every provider would read `"traycer"` whatever is
 * stored.
 */
export function BuiltInReviewerPointer(props: {
  readonly hostId: string | null;
}): ReactNode {
  const judgeReadable = providersListReportsAutoJudge(
    useHostMethodSchemaVersion(props.hostId, "providers.list"),
  );
  const harnesses = useGuiHarnessesQuery({ enabled: true, subscribed: true })
    .data?.harnesses;
  const providers = useProvidersList({ enabled: true, subscribed: true }).data
    ?.providers;
  const openProviderPermissions = useOpenProviderPermissions();
  if (!judgeReadable || harnesses === undefined || providers === undefined) {
    return null;
  }
  const rows = selfReviewingRows(harnesses, providers);
  if (rows.length === 0) return null;
  return (
    <p
      className="flex min-w-0 items-start gap-2 px-1 text-ui-sm text-muted-foreground"
      data-testid="auto-judge-reviewer-pointer"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 text-pretty">
        {pointerSentence(rows)}{" "}
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            {index === 0 ? null : " · "}
            <Button
              type="button"
              variant="link"
              size="inline"
              data-testid={`auto-judge-reviewer-pointer-${row.id}`}
              onClick={() => openProviderPermissions(row)}
            >
              Change in Providers ▸ {row.label}
            </Button>
          </Fragment>
        ))}
      </span>
    </p>
  );
}

/** Catalog rows, in catalog order, whose provider is set to its own reviewer. */
function selfReviewingRows(
  harnesses: ReadonlyArray<GuiHarnessOption>,
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyArray<GuiHarnessOption> {
  return harnesses.filter((row) => {
    if (!row.nativeAutoJudge) return false;
    const state = providerForHarness(providers, row.id);
    return state !== undefined && providerAutoJudgeFor(state) === "provider";
  });
}

function pointerSentence(rows: ReadonlyArray<GuiHarnessOption>): string {
  if (rows.length === 1) {
    const row = rows[0];
    return `${row.label} conversations are checked by ${reviewerOwner(row)}'s own reviewer, not this judge.`;
  }
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
    rows.map((row) => row.label),
  );
  return `${names} conversations are checked by their own reviewers, not this judge.`;
}

/**
 * Whose reviewer a provider's own is, as the spec says it: Claude Code's is
 * Claude's; any other provider's is its own.
 */
function reviewerOwner(row: GuiHarnessOption): string {
  return row.id === providerIdToGuiHarnessId("claude-code")
    ? "Claude"
    : row.label;
}

/**
 * Providers ▸ {provider} ▸ Permissions, where the switch lives. The panel
 * consumes both focus fields once on mount, and opens the tab only when that
 * provider has it, which it does whenever this line can render.
 */
function useOpenProviderPermissions(): (row: GuiHarnessOption) => void {
  const { openSettings } = useSystemTabModalActions();
  return (row) => {
    const focus = useProvidersFocusStore.getState();
    focus.setFocusHarnessId(row.id);
    focus.setFocusTab("permissions");
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      // Settings is already scoped to this machine.
      hostId: null,
    });
  };
}
