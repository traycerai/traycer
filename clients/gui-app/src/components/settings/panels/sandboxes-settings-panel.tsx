import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { Bot, Clock, ListFilter, Search, Server, Workflow } from "lucide-react";
import type {
  SandboxAutomationResponse,
  SandboxCatalogue,
  SandboxListResponse,
  SandboxCost,
  SandboxSummary,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SANDBOXES } from "@/components/settings/environment/sandboxes-page.definitions";
import { SandboxDestroyAllIdleDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxSessionPillBadge } from "@/components/hosts/sandbox-reported-sessions";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import { useOpenAutomationTerminal } from "@/components/settings/panels/use-open-automation-terminal";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSandboxAutomation } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  useSandboxConfigurations,
  useSandboxWakeString,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  useApplyRequestedSandboxesConfiguration,
  useSettlePendingSandboxReveal,
} from "@/hooks/sandboxes/use-open-sandboxes-page";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";
import { useSandboxRowUnreachable } from "@/hooks/sandboxes/use-sandbox-row-unreachable";
import { useOpenLink } from "@/lib/links/open-link";
import { useSampledNow } from "@/lib/relative-time";
import {
  AUTOMATIONS_RELEASED_LINE,
  SANDBOX_KIND_FILTER_LABEL,
  SANDBOX_PUBLIC_STATE_LABEL,
  SANDBOX_ROW_FILTER_NONE,
  SANDBOX_STARTER_FILTER_LABEL,
  SANDBOX_STATE_FILTER_LABEL,
  automationsShapeLine,
  rowInConfiguration,
  sandboxClockLine,
  sandboxDestroyAllIdleOffered,
  sandboxFilterCount,
  sandboxFilterSummary,
  sandboxFrozenNeedsOwnCredits,
  sandboxKeptByLabel,
  sandboxListHeader,
  sandboxPaidByLabel,
  sandboxPublicState,
  sandboxRowKind,
  sandboxRowMatches,
  sandboxSessionPills,
  sandboxSessionsLine,
  sandboxShapeAndCostLine,
  sandboxStartedByLabel,
  sandboxTeamUsageUrl,
  sortSandboxRows,
  unstartedAutomationsMatches,
  type SandboxKindFilter,
  type SandboxPageConfiguration,
  type SandboxPublicState,
  type SandboxRowFilter,
  type SandboxStarterFilter,
  type SandboxStateFilter,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  SANDBOX_LIST_FAILED,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";
import {
  configurationStageShape,
  stageProviderFor,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useComposerSurfaceHostKey } from "@/hooks/host/use-composer-surface-host-pin";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useSandboxShapeMemoryStore } from "@/stores/composer/sandbox-shape-memory-store";
import { useConfigurationSandboxDefaults } from "@/hooks/sandboxes/use-sandbox-defaults";
import { SandboxDefaultsSection } from "@/components/settings/panels/sandbox-defaults-section";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  clearSandboxReveal,
  useSandboxesPageStore,
} from "@/stores/sandboxes/sandboxes-page-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * Settings › Sandboxes for one configuration (Flow 6): every sandbox on its
 * settings, whoever started it, with its cost, under the configuration's
 * defaults. It manages and never creates: a sandbox starts from a task's host
 * picker, and the empty page's `New task` goes there.
 */
export function SandboxesSettingsPanel(): ReactNode {
  const { configurations, teamEnvironmentIds, complete } =
    useSandboxConfigurations();
  // The configuration is the Environment group's pick; a caller that opens
  // the page on one moves that pick.
  const pick = useEnvironmentPick();
  useApplyRequestedSandboxesConfiguration();
  useSettlePendingSandboxReveal();
  // A held reveal waits for its configuration, or the wrong page consumes it.
  const revealSandboxId = useSandboxesPageStore((s) =>
    s.revealConfigurationPending || s.requestedConfiguration !== null
      ? null
      : s.revealSandboxId,
  );
  const configuration = configurationForPick(configurations, pick);
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  const team = configuration.kind === "team";
  return (
    <SettingsPanelShell
      title={SANDBOXES.page.label}
      description={
        team
          ? `Every sandbox running on ${configuration.teamName}'s settings, whoever started it, and what each one costs. Start one from a task's host picker.`
          : "Every sandbox running on your settings and what each one costs. Start one from a task's host picker."
      }
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {configuration.kind === "team" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              data-testid="sandboxes-team-usage"
              onClick={() =>
                void openLink(
                  sandboxTeamUsageUrl(
                    runnerHost.signInUrl,
                    configuration.teamName,
                  ),
                  "account",
                  null,
                )
              }
            >
              Team usage and credits ↗
            </Button>
          ) : null}
        </div>
      }
    >
      <SandboxDefaultsSection
        // A configuration's form and save outcome are its own: two can share a
        // revision, so the form's own key does not tell them apart.
        key={`defaults:${configurationKey(configuration)}`}
        configuration={configuration}
      />
      <SandboxListSection
        // A configuration's filter and search are its own.
        key={configurationKey(configuration)}
        configuration={configuration}
        teamEnvironmentIds={teamEnvironmentIds}
        teamsComplete={complete}
        revealSandboxId={revealSandboxId}
      />
    </SettingsPanelShell>
  );
}

function configurationKey(configuration: SandboxPageConfiguration): string {
  return configuration.kind === "personal"
    ? "personal"
    : `team:${configuration.teamId}`;
}

/**
 * The Environment group's pick as this page's configuration: Personal, or the
 * team whose environment it names. Personal while that team is unresolved;
 * its list waits for the teams there.
 */
function configurationForPick(
  configurations: readonly SandboxPageConfiguration[],
  pick: EnvironmentPick,
): SandboxPageConfiguration {
  const team =
    pick.kind === "team"
      ? configurations.find(
          (candidate) =>
            candidate.kind === "team" &&
            candidate.environmentId === pick.environmentId,
        )
      : undefined;
  return team ?? configurations[0];
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** The id a configuration's remembered picks and defaults are kept under. */
function configurationMemoryKey(
  configuration: SandboxPageConfiguration,
): string {
  return configuration.kind === "team" ? configuration.teamId : "personal";
}

/**
 * The shape a configuration's New row stages when nobody opens its gear: the
 * configuration's defaults, else the spec's; `null` before the catalogue
 * answers. The person's remembered gear pick seeds only their gear.
 */
function useConfigurationStageShape(configuration: SandboxPageConfiguration): {
  readonly catalogue: SandboxCatalogue | null;
  readonly memoryHostId: string | null;
  readonly shape: StageShape | null;
} {
  const catalogue = useSandboxCatalogue(true).data ?? null;
  const memoryHostId = useEffectiveHostId();
  const { read } = useConfigurationSandboxDefaults(
    configurationMemoryKey(configuration),
  );
  const defaults =
    read !== null && read.kind === "ready" ? read.value.defaults : null;
  return {
    catalogue,
    memoryHostId,
    shape:
      catalogue === null ? null : configurationStageShape(catalogue, defaults),
  };
}

// ── The list ────────────────────────────────────────────────────────────────

/**
 * Today's total for the configuration, and the viewer's share of it, as the
 * server totals each configuration's day: sandboxes destroyed today count,
 * which the listed rows no longer carry. Personal is every environment that
 * is none of the viewer's teams'.
 *
 * A server before those totals: the configuration's rows summed. Personal's
 * rows are all the viewer's; a team's share is the viewer's whole share less
 * their Personal rows, which holds while they are in one team.
 */
function todayFigures(input: {
  readonly configuration: SandboxPageConfiguration;
  readonly rows: readonly SandboxSummary[];
  readonly costs: UserSandboxCost | null;
  readonly personalTodayMc: number;
  readonly teamEnvironmentIds: ReadonlySet<string>;
}): { readonly todayMc: number | null; readonly yoursMc: number | null } {
  if (input.costs === null) return { todayMc: null, yoursMc: null };
  const days = input.costs.todayByEnvironment;
  if (days.length > 0) {
    const { configuration } = input;
    const ours = days.filter((day) =>
      configuration.kind === "team"
        ? day.environmentId === configuration.environmentId
        : !input.teamEnvironmentIds.has(day.environmentId),
    );
    return {
      todayMc: ours.reduce((sum, day) => sum + day.todayMillicredits, 0),
      yoursMc: ours.reduce((sum, day) => sum + day.todayYoursMillicredits, 0),
    };
  }
  const ids = new Set(input.rows.map((row) => row.id));
  const todayMc = input.costs.sandboxes
    .filter((cost) => ids.has(cost.sandboxId))
    .reduce((sum, cost) => sum + cost.todayMillicredits, 0);
  if (input.configuration.kind === "personal") {
    return { todayMc, yoursMc: todayMc };
  }
  if (input.teamEnvironmentIds.size !== 1) {
    return { todayMc, yoursMc: null };
  }
  return {
    todayMc,
    yoursMc: Math.max(
      0,
      input.costs.todayYoursMillicredits - input.personalTodayMc,
    ),
  };
}

/**
 * Scrolls the revealed row into view when it first shows, and on each later
 * reveal (`reveals` counts them), not again on each refetch while the reader
 * scrolls elsewhere.
 */
function useScrollRevealedRow(
  highlighted: string | null,
  shown: readonly SandboxSummary[],
  reveals: number,
): void {
  const highlightedShown =
    highlighted !== null && shown.some((row) => row.id === highlighted);
  useEffect(() => {
    if (highlighted === null || !highlightedShown) return;
    const row = document.querySelector(
      `[data-sandbox-row="${CSS.escape(highlighted)}"]`,
    );
    row?.scrollIntoView({ block: "center" });
  }, [highlighted, highlightedShown, reveals]);
}

/**
 * The list's filter and highlighted row. A notification's row is revealed
 * despite any filter: the filter clears, the row scrolls into view and is
 * highlighted. Adjusted while rendering (not in an effect), then the request
 * is consumed so the same row can be asked for again. `reveals` counts them:
 * one scroll per reveal, even of the row revealed last time.
 */
function useRevealedSandboxFilter(reveal: string | null): {
  readonly filter: SandboxRowFilter;
  readonly setFilter: (filter: SandboxRowFilter) => void;
  readonly highlighted: string | null;
  readonly reveals: number;
} {
  const [filter, setFilter] = useState<SandboxRowFilter>(
    SANDBOX_ROW_FILTER_NONE,
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [reveals, setReveals] = useState(0);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal !== null) {
      setFilter(SANDBOX_ROW_FILTER_NONE);
      setHighlighted(reveal);
      setReveals((count) => count + 1);
    }
  }
  useEffect(() => {
    if (reveal !== null) clearSandboxReveal();
  }, [reveal]);
  return { filter, setFilter, highlighted, reveals };
}

/**
 * Whether the configuration's Automations host is listed before its first
 * shell creates it: offered, with no sandbox or pod yet, and no Automations
 * row among the configuration's own.
 */
function automationsUnstarted(input: {
  readonly rows: readonly SandboxSummary[] | null;
  readonly automation: SandboxAutomationResponse | null;
  readonly configuration: SandboxPageConfiguration;
  readonly environmentId: string | null;
}): boolean {
  const { rows, automation } = input;
  if (rows === null || automation === null) return false;
  return (
    automation.available &&
    automation.sandbox === null &&
    automation.pods.length === 0 &&
    (input.configuration.kind === "personal" || input.environmentId !== null) &&
    !rows.some((row) => row.kind === "automation")
  );
}

/**
 * Keep positions until membership or a public state changes. Only ids and
 * states are retained: reports, costs and sessions still render fresh data.
 * The configuration-keyed list owns this order for as long as it is open.
 */
function useOrderedSandboxRows(
  rows: readonly SandboxSummary[] | null,
): readonly SandboxSummary[] {
  const [order, setOrder] = useState<
    readonly { readonly id: string; readonly state: SandboxPublicState }[]
  >([]);
  if (rows === null) return [];

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  if (
    order.length !== rows.length ||
    order.some((entry) => {
      const row = rowsById.get(entry.id);
      return row === undefined || sandboxPublicState(row) !== entry.state;
    })
  ) {
    const sorted = sortSandboxRows(rows);
    setOrder(
      sorted.map((row) => ({ id: row.id, state: sandboxPublicState(row) })),
    );
    return sorted;
  }

  return order.flatMap(({ id }) => {
    const row = rowsById.get(id);
    return row === undefined ? [] : [row];
  });
}

interface SandboxListSectionProps {
  readonly configuration: SandboxPageConfiguration;
  readonly teamEnvironmentIds: ReadonlySet<string>;
  readonly teamsComplete: boolean;
  readonly revealSandboxId: string | null;
}

function SandboxListSection(props: SandboxListSectionProps): ReactNode {
  const { configuration } = props;
  useRefreshSandboxCosts();
  const list = useSandboxList();
  const costs = useSandboxCosts();
  const unavailable = useSandboxControlUnavailableReason();
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const { filter, setFilter, highlighted, reveals } = useRevealedSandboxFilter(
    props.revealSandboxId,
  );
  const [destroyAllOpen, setDestroyAllOpen] = useState(false);

  const allRows = list.data?.sandboxes ?? null;
  // The configuration's Automations host before its first shell creates it:
  // listed all the same, released, so it can be opened from here.
  const automationEnvironmentId =
    configuration.kind === "team" ? configuration.environmentId : null;
  const automation = useSandboxAutomation(automationEnvironmentId).data ?? null;
  const configurationRows = useMemo(() => {
    if (allRows === null) return null;
    // Personal's rows are told apart from a team's only once every team's
    // environment is read.
    if (configuration.kind === "personal" && !props.teamsComplete) return null;
    return allRows.filter((row) =>
      rowInConfiguration(row, configuration, props.teamEnvironmentIds),
    );
  }, [allRows, configuration, props.teamEnvironmentIds, props.teamsComplete]);
  const orderedRows = useOrderedSandboxRows(configurationRows);
  const shown = orderedRows.filter((row) =>
    sandboxRowMatches(row, filter, viewerUserId),
  );
  const unstartedAutomations = automationsUnstarted({
    rows: configurationRows,
    automation,
    configuration,
    environmentId: automationEnvironmentId,
  });
  const unstartedShown =
    unstartedAutomations && unstartedAutomationsMatches(filter);
  useScrollRevealedRow(highlighted, shown, reveals);
  const personalTodayMc = useMemo(() => {
    const data = costs.data ?? null;
    if (allRows === null || data === null) return 0;
    const personal = new Set(
      allRows
        .filter((row) =>
          rowInConfiguration(
            row,
            { kind: "personal" },
            props.teamEnvironmentIds,
          ),
        )
        .map((row) => row.id),
    );
    return data.sandboxes
      .filter((cost) => personal.has(cost.sandboxId))
      .reduce((sum, cost) => sum + cost.todayMillicredits, 0);
  }, [allRows, costs.data, props.teamEnvironmentIds]);

  const gate = (
    <SandboxListGate
      unavailable={unavailable}
      failed={allRows === null ? list.isError : false}
      refetching={list.isFetching}
      onRetry={() => void list.refetch()}
      rows={configurationRows}
      configuration={configuration}
    />
  );
  if (
    configurationRows === null ||
    (configurationRows.length === 0 && !unstartedAutomations)
  ) {
    return gate;
  }
  const figures = todayFigures({
    configuration,
    rows: configurationRows,
    costs: costs.data ?? null,
    personalTodayMc,
    teamEnvironmentIds: props.teamEnvironmentIds,
  });
  const summary = sandboxFilterSummary(
    filter,
    shown.length + (unstartedShown ? 1 : 0),
    configurationRows.length + (unstartedAutomations ? 1 : 0),
  );
  const destroyAllTargets = sandboxDestroyAllIdleOffered(filter)
    ? shown.map((row) => ({ sandboxId: row.id, name: row.displayName }))
    : [];
  return (
    <section aria-label="Sandboxes" data-testid="sandboxes-list">
      <div className="flex flex-col gap-3 border-b border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <SandboxListHeading
          configuration={configuration}
          summary={summary}
          rows={configurationRows}
          unstartedAutomations={unstartedAutomations}
          figures={figures}
        />
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter.search}
              placeholder="Search by name or task"
              aria-label="Search by name or task"
              className="pl-7"
              data-testid="sandboxes-search"
              onChange={(event) =>
                setFilter({ ...filter, search: event.target.value })
              }
            />
          </div>
          <SandboxFilterMenu filter={filter} onChange={setFilter} />
          {destroyAllTargets.length === 0 ? null : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="sandboxes-destroy-all-idle"
              onClick={() => setDestroyAllOpen(true)}
            >
              Destroy all idle
            </Button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-border/60">
        {shown.map((row) => (
          <SandboxListRow
            key={row.id}
            summary={row}
            list={list}
            configuration={configuration}
            cost={
              costs.data?.sandboxes.find((cost) => cost.sandboxId === row.id) ??
              null
            }
            viewerUserId={viewerUserId}
            highlighted={row.id === highlighted}
          />
        ))}
        {unstartedShown ? (
          <UnstartedAutomationsRow
            configuration={configuration}
            teamEnvironmentId={automationEnvironmentId}
          />
        ) : null}
      </ul>
      <SandboxDestroyAllIdleDialog
        targets={destroyAllTargets}
        open={destroyAllOpen}
        onOpenChange={setDestroyAllOpen}
      />
    </section>
  );
}

/**
 * The list's title, and the line under it: the filter's summary while one
 * applies, else the configuration's rows and today's spend.
 */
function SandboxListHeading(props: {
  readonly configuration: SandboxPageConfiguration;
  readonly summary: string | null;
  readonly rows: readonly SandboxSummary[];
  readonly unstartedAutomations: boolean;
  readonly figures: {
    readonly todayMc: number | null;
    readonly yoursMc: number | null;
  };
}): ReactNode {
  const { configuration, figures } = props;
  return (
    <div className="min-w-0 space-y-1">
      <h2 className="text-ui font-medium">
        {configuration.kind === "team"
          ? `${configuration.teamName}'s sandboxes`
          : "Your sandboxes"}
      </h2>
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="sandboxes-list-header"
      >
        {props.summary ??
          `${sandboxListHeader({
            rows: props.rows,
            unstartedAutomations: props.unstartedAutomations,
            todayMc: figures.todayMc,
            todayYoursMc: figures.yoursMc,
          })}.`}
      </p>
    </div>
  );
}

/**
 * What the list says before it has rows to show: the control plane is not
 * reachable from this build, the read failed, it is still loading, or the
 * configuration has none.
 */
function SandboxListGate(props: {
  readonly unavailable: string | null;
  readonly failed: boolean;
  readonly refetching: boolean;
  readonly onRetry: () => void;
  readonly rows: readonly SandboxSummary[] | null;
  readonly configuration: SandboxPageConfiguration;
}): ReactNode {
  if (props.unavailable !== null) {
    return (
      <p className="px-5 py-6 text-ui-sm text-muted-foreground">
        {props.unavailable}
      </p>
    );
  }
  if (props.failed) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-5 py-6">
        <p className="text-ui-sm text-muted-foreground">
          {SANDBOX_LIST_FAILED}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.refetching}
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (props.rows === null) {
    return (
      <div className="space-y-3 px-5 py-5" data-testid="sandboxes-loading">
        <Skeleton className="h-6 w-full max-w-96" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  return <SandboxesEmpty configuration={props.configuration} />;
}

/**
 * `New task`: the landing composer with this configuration's New sandbox row
 * staged in the configuration's default shape. Nothing is created until the
 * send.
 */
function SandboxesEmpty(props: {
  readonly configuration: SandboxPageConfiguration;
}): ReactNode {
  const { configuration } = props;
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const surfaceKey = useComposerSurfaceHostKey();
  const { catalogue, memoryHostId, shape } =
    useConfigurationStageShape(configuration);
  const stageNewRow = (): void => {
    if (catalogue === null || shape === null) return;
    const provider = stageProviderFor(catalogue, shape.os);
    useStagedSandboxStore.getState().stage(surfaceKey, {
      kind: "new",
      configuration:
        configuration.kind === "team"
          ? {
              kind: "team",
              teamId: configuration.teamId,
              teamName: configuration.teamName,
            }
          : { kind: "personal" },
      shape,
      name: "",
      wakeString:
        provider === null ? null : wakeString(provider.suspendFidelity),
    });
    useSandboxShapeMemoryStore
      .getState()
      .rememberConfiguration(
        memoryHostId,
        configurationMemoryKey(configuration),
      );
  };
  return (
    <div
      className="flex flex-col items-start gap-3 px-5 py-6"
      data-testid="sandboxes-empty"
    >
      <p className="text-ui-sm text-muted-foreground">No sandboxes yet.</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          stageNewRow();
          close();
          // A new task's tab, not only its route: Settings may be a tab of its own.
          activateTabIntent(navigate, openNewEpicIntent(), undefined);
        }}
      >
        New task
      </Button>
    </div>
  );
}

const KIND_FILTERS: readonly SandboxKindFilter[] = [
  "all",
  "sandbox",
  "agent",
  "automation",
];
const STATE_FILTERS: readonly SandboxStateFilter[] = [
  "all",
  "awake",
  "suspended",
  "stopped",
  "frozen",
  "failed",
];
const STARTER_FILTERS: readonly SandboxStarterFilter[] = [
  "anyone",
  "you",
  "agent",
  "others",
];

/** One filter button with a count, three radio groups behind it. */
function SandboxFilterMenu(props: {
  readonly filter: SandboxRowFilter;
  readonly onChange: (filter: SandboxRowFilter) => void;
}): ReactNode {
  const { filter } = props;
  const count = sandboxFilterCount(filter);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label="Filter sandboxes"
          data-testid="sandboxes-filter"
          className="relative shrink-0"
        >
          <ListFilter className="size-3.5" aria-hidden />
          {count === 0 ? null : (
            <span
              data-testid="sandboxes-filter-count"
              className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-ui-xs text-primary-foreground"
            >
              {count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        data-testid="sandboxes-filter-menu"
      >
        <DropdownMenuLabel>Kind</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.kind}
          onValueChange={(value) => {
            const kind = KIND_FILTERS.find((candidate) => candidate === value);
            if (kind !== undefined) props.onChange({ ...filter, kind });
          }}
        >
          {KIND_FILTERS.map((kind) => (
            <DropdownMenuRadioItem
              key={kind}
              value={kind}
              onSelect={(event) => event.preventDefault()}
              data-testid={`sandboxes-filter-kind-${kind}`}
            >
              {SANDBOX_KIND_FILTER_LABEL[kind]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>State</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.state}
          onValueChange={(value) => {
            const state = STATE_FILTERS.find(
              (candidate) => candidate === value,
            );
            if (state !== undefined) props.onChange({ ...filter, state });
          }}
        >
          {STATE_FILTERS.map((state) => (
            <DropdownMenuRadioItem
              key={state}
              value={state}
              onSelect={(event) => event.preventDefault()}
              data-testid={`sandboxes-filter-state-${state}`}
            >
              {SANDBOX_STATE_FILTER_LABEL[state]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Started by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter.startedBy}
          onValueChange={(value) => {
            const startedBy = STARTER_FILTERS.find(
              (candidate) => candidate === value,
            );
            if (startedBy !== undefined) {
              props.onChange({ ...filter, startedBy });
            }
          }}
        >
          {STARTER_FILTERS.map((starter) => (
            <DropdownMenuRadioItem
              key={starter}
              value={starter}
              onSelect={(event) => event.preventDefault()}
              data-testid={`sandboxes-filter-started-${starter}`}
            >
              {SANDBOX_STARTER_FILTER_LABEL[starter]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {count === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="sandboxes-filter-clear"
              onSelect={() =>
                props.onChange({
                  ...SANDBOX_ROW_FILTER_NONE,
                  search: filter.search,
                })
              }
            >
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── A row ───────────────────────────────────────────────────────────────────

const STATE_BADGE: Record<
  SandboxPublicState,
  "success" | "info" | "warning" | "destructive" | "muted"
> = {
  creating: "info",
  awake: "success",
  suspended: "muted",
  stopped: "muted",
  destroying: "info",
  frozen: "warning",
  failed: "destructive",
};

function KindTile(props: { readonly summary: SandboxSummary }): ReactNode {
  switch (sandboxRowKind(props.summary)) {
    case "agent":
      return <Bot className="size-4" aria-hidden />;
    case "automation":
      return <Workflow className="size-4" aria-hidden />;
    case "sandbox":
      return <Server className="size-4" aria-hidden />;
  }
}

/**
 * The configuration's Automations host before its first shell creates it:
 * a released row whose `Open terminal` creates and starts it. Rename and
 * Details come with the row once it exists.
 */
function UnstartedAutomationsRow(props: {
  readonly configuration: SandboxPageConfiguration;
  readonly teamEnvironmentId: string | null;
}): ReactNode {
  const open = useOpenAutomationTerminal({
    existing: null,
    teamEnvironmentId: props.teamEnvironmentId,
  });
  return (
    <li
      data-state="suspended"
      data-testid="sandboxes-row-automations-unstarted"
      className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/8 text-muted-foreground">
          <Workflow className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-ui-sm font-medium text-foreground wrap-anywhere"
              data-testid="sandboxes-row-name"
            >
              Automations
            </span>
            <Badge variant="muted" data-testid="sandboxes-row-state">
              {SANDBOX_PUBLIC_STATE_LABEL.suspended}
            </Badge>
            <Badge variant="muted">Automations</Badge>
          </div>
          <p className="text-ui-sm text-muted-foreground wrap-anywhere">
            {automationsShapeLine(props.configuration)}
          </p>
          <p
            className="flex items-start gap-1.5 text-ui-xs text-muted-foreground wrap-anywhere"
            data-testid="sandboxes-row-clock"
          >
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{AUTOMATIONS_RELEASED_LINE}</span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={open.starting}
          data-testid="sandbox-row-open-terminal"
          onClick={open.run}
        >
          {open.starting ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Open terminal
        </Button>
      </div>
    </li>
  );
}

function SandboxListRow(props: {
  readonly summary: SandboxSummary;
  readonly list: UseQueryResult<SandboxListResponse | null>;
  readonly configuration: SandboxPageConfiguration;
  readonly cost: SandboxCost | null;
  readonly viewerUserId: string | null;
  readonly highlighted: boolean;
}): ReactNode {
  const { summary, configuration, viewerUserId } = props;
  const state = sandboxPublicState(summary);
  const awake = state === "awake";
  const sessions = useSandboxSessionReport(summary.hostId, awake);
  const wake = useSandboxWakeString(summary);
  const now = useSampledNow();
  const unreachable = useSandboxRowUnreachable(
    summary,
    sessions.failed && sessions.report.kind !== "live",
    props.list,
  );
  const reachability = {
    unreachable,
    lastContactAt: summary.lastActivityAt,
  };
  const paidBy = sandboxPaidByLabel(summary, configuration, viewerUserId);
  const keptBy = sandboxKeptByLabel(summary, viewerUserId);
  return (
    <li
      data-sandbox-row={summary.id}
      data-state={state}
      data-testid="sandboxes-row"
      className={cn(
        "flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
        props.highlighted && "bg-info/10",
      )}
    >
      <div className="flex min-w-0 gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/8 text-muted-foreground">
          <KindTile summary={summary} />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-ui-sm font-medium text-foreground wrap-anywhere"
              data-testid="sandboxes-row-name"
            >
              {summary.displayName}
            </span>
            <Badge
              variant={STATE_BADGE[state]}
              data-testid="sandboxes-row-state"
            >
              {SANDBOX_PUBLIC_STATE_LABEL[state]}
            </Badge>
            <Badge variant="muted">
              {sandboxStartedByLabel(summary, viewerUserId)}
            </Badge>
            {paidBy === null ? null : <Badge variant="muted">{paidBy}</Badge>}
            {keptBy === null ? null : <Badge variant="muted">{keptBy}</Badge>}
          </div>
          <p className="text-ui-sm text-muted-foreground wrap-anywhere">
            {sandboxShapeAndCostLine(summary, configuration)}
          </p>
          <p
            className="flex items-start gap-1.5 text-ui-xs text-muted-foreground wrap-anywhere"
            data-testid="sandboxes-row-clock"
          >
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {sandboxClockLine({
                summary,
                configuration,
                cost: props.cost,
                wakeString: wake,
                viewerUserId,
                reachability,
                now,
              })}
            </span>
          </p>
          {awake && !unreachable ? (
            <p
              className="flex items-center gap-1.5 text-ui-xs text-muted-foreground"
              data-testid="sandboxes-row-sessions"
            >
              {sessions.report.kind === "live" && sessions.report.busy ? (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-success"
                />
              ) : null}
              {sandboxSessionsLine(sessions.report, now)}
              {sandboxSessionPills(sessions.report).map((pill) => (
                <SandboxSessionPillBadge
                  key={pill.key}
                  pill={pill}
                  testId="sandboxes-row-session-pill"
                />
              ))}
            </p>
          ) : null}
        </div>
      </div>
      <SandboxRowActions
        summary={summary}
        configuration={configuration}
        unreachable={unreachable}
        frozenNeedsOwnCredits={sandboxFrozenNeedsOwnCredits(
          summary,
          configuration,
          viewerUserId,
        )}
      />
    </li>
  );
}
