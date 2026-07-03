/**
 * Bespoke per-provider rate-limit views, shared by three surfaces: the
 * Settings > Providers card (`provider-rate-limit-section.tsx`), the
 * per-chat context-usage popover, and its pinned-strip compact row
 * (`context-usage-chip.tsx`). Kept host/query-free - each surface owns its
 * own host-scoped query + refresh wiring and hands this module plain data,
 * so these views render identically everywhere and stay easy to test.
 */
import type { ReactNode } from "react";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import { Badge } from "@/components/ui/badge";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { UsageBar } from "@/components/settings/panels/traycer-subscription-section";
import { contextUsageTone } from "@/components/chat/context-usage";
import { useResetCountdown } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** Shared read of a provider rate-limit query, independent of host scope. */
export interface ProviderRateLimitQueryState {
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly providerRateLimits: ProviderRateLimits | null | undefined;
}

type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;
type CodexRateLimits = Extract<ProviderRateLimits, { provider: "codex" }>;
type ClaudeRateLimits = Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
>;

function formatUsagePercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** `contextUsageTone` reads a LEFT/remaining percent; windows report used%. */
function windowTone(usedPercent: number): string {
  return contextUsageTone(100 - usedPercent);
}

/**
 * `snake_case`/lowercase-token → Title Case, for any enum value that isn't in
 * one of the display-name maps below (a forward-compat fallback for values
 * the host adds before this map is updated).
 */
function titleCaseFromToken(value: string): string {
  return value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function ResetLine({
  resetsAt,
  tone,
}: {
  readonly resetsAt: number | null;
  readonly tone: string;
}): ReactNode {
  const countdown = useResetCountdown(resetsAt);
  if (countdown === null) return null;
  return <span className={cn("text-ui-xs", tone)}>Resets in {countdown}</span>;
}

function RateLimitWindowRow({
  label,
  window,
}: {
  readonly label: string;
  readonly window: ProviderRateLimitWindow | null;
}): ReactNode {
  if (window === null) return null;
  return (
    <div className="flex flex-col gap-1">
      <UsageBar
        label={label}
        consumed={window.usedPercent}
        total={100}
        formatValue={formatUsagePercent}
      />
      <div className="flex justify-end">
        <ResetLine
          resetsAt={window.resetsAt}
          tone={windowTone(window.usedPercent)}
        />
      </div>
    </div>
  );
}

const CODEX_WINDOW_LABELS = { primary: "5-hour", secondary: "Weekly" } as const;
const CLAUDE_WINDOW_LABELS = {
  fiveHour: "5-hour",
  sevenDay: "Weekly",
  sevenDayOpus: "Weekly (Opus)",
  sevenDaySonnet: "Weekly (Sonnet)",
} as const;

// Codex's `PlanType` enum (host `harnesses/codex/protocol`) - lowercase
// tokens on the wire, so the badge needs a display map rather than showing
// the raw value. Falls back to `titleCaseFromToken` for any value not listed
// here (forward-compat with a new plan type before this map is updated).
const CODEX_PLAN_TYPE_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business (usage-based)",
  business: "Business",
  enterprise_cbp_usage_based: "Enterprise (usage-based)",
  enterprise: "Enterprise",
  edu: "Education",
  unknown: "Unknown plan",
};

function formatCodexPlanType(planType: string): string {
  return CODEX_PLAN_TYPE_LABELS[planType] ?? titleCaseFromToken(planType);
}

// Codex's `RateLimitReachedType` enum - same raw-token issue as `planType`.
const CODEX_RATE_LIMIT_REACHED_LABELS: Record<string, string> = {
  rate_limit_reached: "Rate limit reached",
  workspace_owner_credits_depleted: "Workspace credits depleted",
  workspace_member_credits_depleted: "Workspace credits depleted",
  workspace_owner_usage_limit_reached: "Workspace usage limit reached",
  workspace_member_usage_limit_reached: "Workspace usage limit reached",
};

function formatRateLimitReachedType(value: string): string {
  return CODEX_RATE_LIMIT_REACHED_LABELS[value] ?? titleCaseFromToken(value);
}

export function CodexRateLimitView({
  data,
}: {
  readonly data: CodexRateLimits;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {data.planType !== null ? (
          <Badge variant="secondary">
            {formatCodexPlanType(data.planType)}
          </Badge>
        ) : null}
        {data.rateLimitReachedType !== null ? (
          <Badge variant="destructive">
            {formatRateLimitReachedType(data.rateLimitReachedType)}
          </Badge>
        ) : null}
      </div>
      <RateLimitWindowRow
        label={CODEX_WINDOW_LABELS.primary}
        window={data.primary}
      />
      <RateLimitWindowRow
        label={CODEX_WINDOW_LABELS.secondary}
        window={data.secondary}
      />
      {data.credits !== null ? (
        <CodexCreditsRow credits={data.credits} />
      ) : null}
      {data.individualLimit !== null ? (
        <CodexSpendControlRow limit={data.individualLimit} />
      ) : null}
    </div>
  );
}

function CodexCreditsRow({
  credits,
}: {
  readonly credits: NonNullable<CodexRateLimits["credits"]>;
}): ReactNode {
  const label = credits.unlimited
    ? "Unlimited"
    : (credits.balance ?? (credits.hasCredits ? "Available" : "None"));
  return (
    <div className="flex items-center justify-between text-ui-sm">
      <span className="text-muted-foreground">Credits</span>
      <span className="font-mono text-ui-xs text-foreground">{label}</span>
    </div>
  );
}

function CodexSpendControlRow({
  limit,
}: {
  readonly limit: NonNullable<CodexRateLimits["individualLimit"]>;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-muted-foreground">Spend limit</span>
        <span className="font-mono text-ui-xs text-foreground">
          {limit.used} / {limit.limit}
        </span>
      </div>
      <div className="flex justify-end">
        <ResetLine
          resetsAt={limit.resetsAt}
          tone={contextUsageTone(limit.remainingPercent)}
        />
      </div>
    </div>
  );
}

export function ClaudeRateLimitView({
  data,
}: {
  readonly data: ClaudeRateLimits;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {data.subscriptionType !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {titleCaseFromToken(data.subscriptionType)}
          </Badge>
        </div>
      ) : null}
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.fiveHour}
        window={data.fiveHour}
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDay}
        window={data.sevenDay}
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDayOpus}
        window={data.sevenDayOpus}
      />
      <RateLimitWindowRow
        label={CLAUDE_WINDOW_LABELS.sevenDaySonnet}
        window={data.sevenDaySonnet}
      />
      {data.modelScoped.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            Per-model
          </span>
          {data.modelScoped.map((entry) => (
            <RateLimitWindowRow
              key={entry.displayName}
              label={entry.displayName}
              window={entry}
            />
          ))}
        </div>
      ) : null}
      {data.extraUsage !== null && data.extraUsage.isEnabled ? (
        <ClaudeExtraUsageRow extraUsage={data.extraUsage} />
      ) : null}
    </div>
  );
}

function ClaudeExtraUsageRow({
  extraUsage,
}: {
  readonly extraUsage: NonNullable<ClaudeRateLimits["extraUsage"]>;
}): ReactNode {
  // `monthlyLimit`/`usedCredits` give a ratio-based bar without depending on
  // the ambiguous 0-1-vs-0-100 scale of `utilization` (open item on the wire
  // contract - see the tech plan). `utilization` is only ever shown as raw
  // supplementary text.
  if (extraUsage.monthlyLimit !== null && extraUsage.usedCredits !== null) {
    return (
      <UsageBar
        label="Extra usage"
        consumed={extraUsage.usedCredits}
        total={extraUsage.monthlyLimit}
        formatValue={(value) => value.toFixed(2)}
      />
    );
  }
  if (extraUsage.utilization !== null) {
    return (
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-muted-foreground">Extra usage</span>
        <span className="font-mono text-ui-xs text-foreground">
          {extraUsage.utilization}
        </span>
      </div>
    );
  }
  return null;
}

// Exhaustive set of `reason` codes the host emits (`provider-rate-limits.ts`,
// `rate-limits/{codex,claude}.ts`, `rate-limits/common.ts`) - the wire field
// is a machine identifier, not display copy. Falls back to a lowercased,
// space-joined rendering of any code not listed here.
// `Record<RateLimitUnavailableReason, string>` (not `Record<string, string>`)
// makes this exhaustive at compile time: adding a reason to the protocol's
// closed enum without adding a label here fails the build instead of
// silently falling through to a raw, underscore-joined reason code.
const RATE_LIMIT_UNAVAILABLE_REASON_LABELS: Record<
  RateLimitUnavailableReason,
  string
> = {
  cli_not_found: "the CLI isn't installed",
  unsupported_provider: "this provider isn't supported",
  invalid_response: "the CLI returned an unexpected response",
  timeout: "the request timed out",
  connection_failed: "couldn't connect to the CLI",
  sdk_incompatible: "this SDK version doesn't support rate limits",
  rate_limits_not_available: "not available for this account",
};

function formatUnavailableReason(reason: RateLimitUnavailableReason): string {
  return RATE_LIMIT_UNAVAILABLE_REASON_LABELS[reason];
}

export function ProviderRateLimitBody(
  props: ProviderRateLimitQueryState,
): ReactNode {
  // `isPending` alone stays `true` forever for a disabled query (e.g. a chat
  // tab bound to an unreachable host, where `useHostQuery` never enables) -
  // gate on `isFetching` too so that case renders nothing (falls through to
  // the `data === null` branch below) instead of an eternal spinner.
  if (props.isPending && props.isFetching) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading rate limits
      </div>
    );
  }
  if (props.isError) {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn't load rate limits. Try refreshing.
      </div>
    );
  }
  const data = props.providerRateLimits ?? null;
  if (data === null) return null;
  if (!data.available) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        Rate limits unavailable — {formatUnavailableReason(data.reason)}
      </p>
    );
  }
  return <ProviderRateLimitDetail data={data} />;
}

function ProviderRateLimitDetail({
  data,
}: {
  readonly data: AvailableProviderRateLimits;
}): ReactNode {
  if (data.provider === "codex") return <CodexRateLimitView data={data} />;
  return <ClaudeRateLimitView data={data} />;
}

interface LabeledWindow {
  readonly label: string;
  readonly window: ProviderRateLimitWindow;
}

function windowsFor(
  data: AvailableProviderRateLimits,
): readonly LabeledWindow[] {
  if (data.provider === "codex") {
    const candidates: readonly (LabeledWindow | null)[] = [
      data.primary !== null
        ? { label: CODEX_WINDOW_LABELS.primary, window: data.primary }
        : null,
      data.secondary !== null
        ? { label: CODEX_WINDOW_LABELS.secondary, window: data.secondary }
        : null,
    ];
    return candidates.filter((entry): entry is LabeledWindow => entry !== null);
  }
  const candidates: readonly (LabeledWindow | null)[] = [
    data.fiveHour !== null
      ? { label: CLAUDE_WINDOW_LABELS.fiveHour, window: data.fiveHour }
      : null,
    data.sevenDay !== null
      ? { label: CLAUDE_WINDOW_LABELS.sevenDay, window: data.sevenDay }
      : null,
    data.sevenDayOpus !== null
      ? { label: CLAUDE_WINDOW_LABELS.sevenDayOpus, window: data.sevenDayOpus }
      : null,
    data.sevenDaySonnet !== null
      ? {
          label: CLAUDE_WINDOW_LABELS.sevenDaySonnet,
          window: data.sevenDaySonnet,
        }
      : null,
  ];
  return candidates.filter((entry): entry is LabeledWindow => entry !== null);
}

function mostUtilizedWindow(
  data: AvailableProviderRateLimits,
): LabeledWindow | null {
  const windows = windowsFor(data);
  if (windows.length === 0) return null;
  return windows.reduce((max, entry) =>
    entry.window.usedPercent > max.window.usedPercent ? entry : max,
  );
}

/**
 * Terse pinned-strip summary: the single most-utilized window's percent + a
 * short label, mirroring `PinnedUsageRow`'s compact styling. Renders nothing
 * while pending/errored/unavailable/dataless - the pinned strip stays silent
 * rather than noisy for a surface this secondary.
 */
export function ProviderRateLimitCompactRow(
  props: ProviderRateLimitQueryState,
): ReactNode {
  if (props.isPending || props.isError) return null;
  const data = props.providerRateLimits ?? null;
  if (data === null || !data.available) return null;
  const summary = mostUtilizedWindow(data);
  if (summary === null) return null;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-muted-foreground">
      <span>{summary.label}</span>
      <span
        className={cn(
          "font-mono tabular-nums",
          windowTone(summary.window.usedPercent),
        )}
      >
        {formatUsagePercent(summary.window.usedPercent)}
      </span>
    </span>
  );
}
