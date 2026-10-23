import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Bot, Clock, ListFilter, Search, Server, Workflow } from "lucide-react";
import type {
  SandboxCatalogue,
  SandboxCost,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SandboxDestroyAllIdleDialog } from "@/components/hosts/sandbox-confirm-dialogs";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  useSandboxConfigurations,
  useSandboxWakeString,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useSandboxSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";
import { useOpenLink } from "@/lib/links/open-link";
import { useSampledNow } from "@/lib/relative-time";
import {
  SANDBOX_DEFAULT_IDLE_MINUTES,
  SANDBOX_DEFAULT_RESTING_MINUTES,
  SANDBOX_KIND_FILTER_LABEL,
  SANDBOX_PUBLIC_STATE_LABEL,
  SANDBOX_ROW_FILTER_NONE,
  SANDBOX_STARTER_FILTER_LABEL,
  SANDBOX_STATE_FILTER_LABEL,
  rowInConfiguration,
  sandboxClockLine,
  sandboxDestroyAllIdleOffered,
  sandboxFilterCount,
  sandboxFilterSummary,
  sandboxFrozenNeedsOwnCredits,
  sandboxKeptByLabel,
  sandboxListHeader,
  sandboxPaidByLabel,
  sandboxPeriodLabel,
  sandboxPublicState,
  sandboxRowKind,
  sandboxRowMatches,
  sandboxSessionsLine,
  sandboxShapeAndCostLine,
  sandboxStartedByLabel,
  sandboxTeamUsageUrl,
  sortSandboxRows,
  type SandboxKindFilter,
  type SandboxPageConfiguration,
  type SandboxPublicState,
  type SandboxRowFilter,
  type SandboxStarterFilter,
  type SandboxStateFilter,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  KEPT_UNTIL_YOU_DESTROY_IT,
  sandboxShapeLabel,
  shortPriceLabel,
  wakeString,
} from "@/lib/sandboxes/sandbox-strings";
import {
  rememberedOrDefaultStageShape,
  stagePrice,
  stageProviderFor,
  type StageShape,
} from "@/lib/sandboxes/sandbox-stage-model";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  rememberedSandboxShape,
  useSandboxShapeMemoryStore,
} from "@/stores/composer/sandbox-shape-memory-store";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  clearSandboxReveal,
  setSandboxesPageConfiguration,
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
  const selectedId = useSandboxesPageStore((s) => s.configurationId);
  const revealSandboxId = useSandboxesPageStore((s) => s.revealSandboxId);
  const configuration =
    configurations.find(
      (candidate) =>
        candidate.kind === selectedId.kind &&
        (candidate.kind === "personal" ||
          (selectedId.kind === "team" &&
            candidate.teamId === selectedId.teamId)),
    ) ?? configurations[0];
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  const team = configuration.kind === "team";
  return (
    <SettingsPanelShell
      title="Sandboxes"
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
          <ConfigurationPicker
            configurations={configurations}
            selected={configuration}
          />
        </div>
      }
    >
      <SandboxDefaultsSection configuration={configuration} />
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
 * The configuration choice at the top of the page: Personal and each team.
 * The configuration is never a filter of the list.
 */
function ConfigurationPicker(props: {
  readonly configurations: readonly SandboxPageConfiguration[];
  readonly selected: SandboxPageConfiguration;
}): ReactNode {
  if (props.configurations.length < 2) return null;
  return (
    <Select
      value={configurationKey(props.selected)}
      onValueChange={(value) => {
        const next = props.configurations.find(
          (candidate) => configurationKey(candidate) === value,
        );
        if (next === undefined) return;
        setSandboxesPageConfiguration(
          next.kind === "team"
            ? { kind: "team", teamId: next.teamId }
            : { kind: "personal" },
        );
      }}
    >
      <SelectTrigger
        className="w-48"
        aria-label="Configuration"
        data-testid="sandboxes-configuration"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.configurations.map((candidate) => (
          <SelectItem
            key={configurationKey(candidate)}
            value={configurationKey(candidate)}
          >
            {candidate.kind === "team" ? candidate.teamName : "Personal"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Defaults ────────────────────────────────────────────────────────────────

/**
 * A New row's shape as the catalogue offers it, with its class's wake string
 * and its price (`from` unless it is the region's smallest, the one shape the
 * catalogue prices), or `null` before the catalogue answers.
 */
function defaultShapeLine(
  catalogue: SandboxCatalogue | null,
  shape: StageShape | null,
): string | null {
  if (catalogue === null || shape === null) return null;
  const provider = stageProviderFor(catalogue, shape.os);
  const price = stagePrice(catalogue, shape);
  const priceLabel =
    price === null ? null : shortPriceLabel(price.awakeMcPerHour);
  return [
    `${shape.os === "linux" ? "Linux" : "Windows"} · ${sandboxShapeLabel(shape.cpus, shape.memoryMb)}`,
    price === null || price.exact ? priceLabel : `from ${priceLabel}`,
    provider === null ? null : wakeString(provider.suspendFidelity),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * The defaults a New row of this configuration offers: the default shape, a
 * 30-minute idle period and a 7-day resting period. Shown, not edited here:
 * a team's shared, editable defaults are a later change, and the gear on a
 * New row changes one sandbox only.
 */
function SandboxDefaultsSection(props: {
  readonly configuration: SandboxPageConfiguration;
}): ReactNode {
  const catalogue = useSandboxCatalogue(true).data ?? null;
  const { configuration } = props;
  // The person's own pick behind this configuration's gear, remembered
  // under the host their composer follows; the spec's defaults until then.
  const memoryHostId = useEffectiveHostId();
  const remembered = useSandboxShapeMemoryStore((s) =>
    rememberedSandboxShape(
      s.byHost,
      memoryHostId,
      configuration.kind === "team" ? configuration.teamId : "personal",
    ),
  );
  const stageShape =
    catalogue === null
      ? null
      : rememberedOrDefaultStageShape(catalogue, remembered);
  const shape = defaultShapeLine(catalogue, stageShape);
  const idleMinutes =
    stageShape === null ? SANDBOX_DEFAULT_IDLE_MINUTES : stageShape.idleMinutes;
  const restingMinutes =
    stageShape === null
      ? SANDBOX_DEFAULT_RESTING_MINUTES
      : stageShape.destroyAfterRestingMinutes;
  return (
    <section
      aria-label="Defaults for new sandboxes"
      className="flex flex-col gap-3 border-b border-border/60 px-5 py-4"
      data-testid="sandboxes-defaults"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-ui font-medium">
          {configuration.kind === "team"
            ? `${configuration.teamName}'s defaults for new sandboxes`
            : "Your defaults for new sandboxes"}
        </h2>
        <p className="text-ui-xs text-muted-foreground">
          {configuration.kind === "team"
            ? `Shared by ${configuration.teamName} · not a spending limit. The gear on a New row changes one sandbox only. Sandboxes you already have are kept until you set a period.`
            : "What a New Personal sandbox row offers. The gear on the row changes one sandbox only. Sandboxes you already have are kept until you set a period."}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-ui-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Shape</dt>
        <dd data-testid="sandboxes-defaults-shape">{shape ?? "…"}</dd>
        <dt className="text-muted-foreground">
          Suspend when idle for (at least 2 minutes)
        </dt>
        <dd data-testid="sandboxes-defaults-idle">
          {sandboxPeriodLabel(idleMinutes)}
        </dd>
        <dt className="text-muted-foreground">
          Destroy after resting for (empty: never)
        </dt>
        <dd data-testid="sandboxes-defaults-resting">
          {restingMinutes === null
            ? KEPT_UNTIL_YOU_DESTROY_IT
            : sandboxPeriodLabel(restingMinutes)}
        </dd>
      </dl>
    </section>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

/**
 * Today's total for the configuration's rows, and the viewer's share of it:
 * Personal's rows are all the viewer's; a team's share is the viewer's whole
 * share less their Personal rows, which holds while they are in one team.
 */
function todayFigures(input: {
  readonly configuration: SandboxPageConfiguration;
  readonly rows: readonly SandboxSummary[];
  readonly costs: readonly SandboxCost[] | null;
  readonly personalTodayMc: number;
  readonly yoursMc: number | null;
  readonly teamCount: number;
}): { readonly todayMc: number | null; readonly yoursMc: number | null } {
  if (input.costs === null) return { todayMc: null, yoursMc: null };
  const ids = new Set(input.rows.map((row) => row.id));
  const todayMc = input.costs
    .filter((cost) => ids.has(cost.sandboxId))
    .reduce((sum, cost) => sum + cost.todayMillicredits, 0);
  if (input.configuration.kind === "personal") {
    return { todayMc, yoursMc: todayMc };
  }
  if (input.yoursMc === null || input.teamCount !== 1) {
    return { todayMc, yoursMc: null };
  }
  return {
    todayMc,
    yoursMc: Math.max(0, input.yoursMc - input.personalTodayMc),
  };
}

function SandboxListSection(props: {
  readonly configuration: SandboxPageConfiguration;
  readonly teamEnvironmentIds: ReadonlySet<string>;
  readonly teamsComplete: boolean;
  readonly revealSandboxId: string | null;
}): ReactNode {
  const { configuration } = props;
  useRefreshSandboxCosts();
  const list = useSandboxList();
  const costs = useSandboxCosts();
  const unavailable = useSandboxControlUnavailableReason();
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const [filter, setFilter] = useState<SandboxRowFilter>(
    SANDBOX_ROW_FILTER_NONE,
  );
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [destroyAllOpen, setDestroyAllOpen] = useState(false);

  // A notification's row is revealed despite any filter: the filter clears,
  // the row scrolls into view and is highlighted.
  // Adjusted while rendering (not in an effect), then the request is
  // consumed so the same row can be asked for again.
  const reveal = props.revealSandboxId;
  const [revealed, setRevealed] = useState<string | null>(null);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal !== null) {
      setFilter(SANDBOX_ROW_FILTER_NONE);
      setHighlighted(reveal);
    }
  }
  useEffect(() => {
    if (reveal !== null) clearSandboxReveal();
  }, [reveal]);
  useEffect(() => {
    if (highlighted === null) return;
    const row = document.querySelector(
      `[data-sandbox-row="${CSS.escape(highlighted)}"]`,
    );
    row?.scrollIntoView({ block: "center" });
  }, [highlighted, list.data]);

  const allRows = list.data?.sandboxes ?? null;
  const configurationRows = useMemo(() => {
    if (allRows === null) return null;
    // Personal's rows are told apart from a team's only once every team's
    // environment is read.
    if (configuration.kind === "personal" && !props.teamsComplete) return null;
    return allRows.filter((row) =>
      rowInConfiguration(row, configuration, props.teamEnvironmentIds),
    );
  }, [allRows, configuration, props.teamEnvironmentIds, props.teamsComplete]);
  const shown = useMemo(
    () =>
      configurationRows === null
        ? []
        : sortSandboxRows(
            configurationRows.filter((row) =>
              sandboxRowMatches(row, filter, viewerUserId),
            ),
          ),
    [configurationRows, filter, viewerUserId],
  );
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
    />
  );
  if (configurationRows === null || configurationRows.length === 0) {
    return gate;
  }
  const figures = todayFigures({
    configuration,
    rows: configurationRows,
    costs: costs.data?.sandboxes ?? null,
    personalTodayMc,
    yoursMc: costs.data?.todayYoursMillicredits ?? null,
    teamCount: props.teamEnvironmentIds.size,
  });
  const summary = sandboxFilterSummary(
    filter,
    shown.length,
    configurationRows.length,
  );
  const destroyAllTargets = sandboxDestroyAllIdleOffered(filter)
    ? shown.map((row) => ({ sandboxId: row.id, name: row.displayName }))
    : [];
  return (
    <section aria-label="Sandboxes" data-testid="sandboxes-list">
      <div className="flex flex-col gap-3 border-b border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
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
            {summary ??
              `${sandboxListHeader({
                rows: configurationRows,
                todayMc: figures.todayMc,
                todayYoursMc: figures.yoursMc,
              })}.`}
          </p>
        </div>
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
            configuration={configuration}
            cost={
              costs.data?.sandboxes.find((cost) => cost.sandboxId === row.id) ??
              null
            }
            viewerUserId={viewerUserId}
            highlighted={row.id === highlighted}
          />
        ))}
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
          Couldn&apos;t load your sandboxes.
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
  return <SandboxesEmpty />;
}

function SandboxesEmpty(): ReactNode {
  const { close } = useSystemTabModalActions();
  const router = useRouter();
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
          close();
          void router.navigate({ to: "/" });
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

function SandboxListRow(props: {
  readonly summary: SandboxSummary;
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
  // The control plane says awake and the host does not answer: Stop is the
  // way to end its meter without the guest.
  const unreachable =
    awake &&
    summary.guestConfigured !== false &&
    sessions.failed &&
    sessions.report.kind !== "live";
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
