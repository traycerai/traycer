/**
 * Human formatters for the agent-facing provider-profile family
 * (`agent.listProviderProfiles`, `agent.getProviderProfileRateLimits`,
 * `agent.configure` - see `host/agent/profiles.ts`), alongside the existing
 * agent-list and harness-model formatters.
 *
 * Two rules shape every line here:
 *
 *   - **Reusable selections.** A profile is always rendered as the exact
 *     `--profile <value>` token the next command takes (`ambient`, or the
 *     managed profile id), so an agent can copy a row straight into
 *     `traycer agent create` / `profile-rate-limits` / `configure` without
 *     transcribing an id out of prose.
 *   - **Never invent availability.** The unavailable rate-limit arm renders
 *     its reason; a `null` window or an uncaptured `usageUpdatedAt` renders
 *     as unknown rather than as a zero reading.
 *
 * `--json` bypasses all of this and emits the RPC DTO unchanged.
 */
import type {
  AgentConfigureResponse,
  AgentGetProviderProfileRateLimitsResponse,
  AgentListProviderProfilesResponse,
  AgentProviderProfileSummary,
  ConcreteProfileSelection,
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host";

/**
 * The `--profile` token that reselects this profile in a later command: the
 * literal `ambient` for the provider's ambient CLI login, or the managed
 * profile's stable id. The single place the wire selection becomes a
 * user-facing value, so every formatter below (and the CLI's own parser)
 * agrees on the round-trip.
 */
export function formatProfileSelection(
  selection: ConcreteProfileSelection,
): string {
  return selection.kind === "ambient" ? "ambient" : selection.profileId;
}

export function formatAgentProviderProfilesResponse(
  response: AgentListProviderProfilesResponse,
): string {
  const legend = `Each line is: --profile <value> - label [auth: status] [limits: status, captured <time>] [last-used]
Pass the --profile value to 'traycer agent create', 'traycer agent profile-rate-limits', or 'traycer agent configure'.
Limit status is the cached reading from the profile's last use - run 'traycer agent profile-rate-limits' for a fresh, detailed read.`;
  if (response.profiles.length === 0) {
    return `${legend}

No provider profiles found for provider '${response.providerId}'.`;
  }
  return `Provider profiles for '${response.providerId}':
${legend}

${response.profiles.map(formatProviderProfileSummary).join("\n")}`;
}

function formatProviderProfileSummary(
  profile: AgentProviderProfileSummary,
): string {
  const lastUsed = profile.isEffectiveLastUsed ? " [last-used]" : "";
  return `--profile ${formatProfileSelection(profile.selection)} - ${profile.label} [auth: ${profile.authStatus}] [limits: ${profile.rateLimitStatus}, captured ${formatTimestamp(profile.usageUpdatedAt)}]${lastUsed}`;
}

/**
 * The requested selection is a formatter argument rather than a response
 * field: `agent.getProviderProfileRateLimits` deliberately answers with the
 * provider-tagged `rateLimits` union alone (its `provider` is the single
 * source of provider identity), so the caller supplies the profile it asked
 * about to label the read.
 */
export function formatAgentProviderProfileRateLimitsResponse(
  selection: ConcreteProfileSelection,
  response: AgentGetProviderProfileRateLimitsResponse,
): string {
  const header = `Rate limits for provider '${response.rateLimits.provider}' [--profile ${formatProfileSelection(selection)}], captured ${formatTimestamp(response.usageUpdatedAt)}:`;
  return `${header}
${formatProviderRateLimits(response.rateLimits)}`;
}

function formatProviderRateLimits(rateLimits: ProviderRateLimits): string {
  if (!rateLimits.available) {
    return `unavailable (${rateLimits.reason})`;
  }
  if (rateLimits.provider === "codex") {
    return [
      `plan: ${rateLimits.planType ?? "unknown"}`,
      formatWindowLine("primary", rateLimits.primary),
      formatWindowLine("secondary", rateLimits.secondary),
      ...rateLimits.extraWindows.flatMap((window) => [
        formatWindowLine(
          `${window.limitName ?? window.limitId} primary`,
          window.primary,
        ),
        formatWindowLine(
          `${window.limitName ?? window.limitId} secondary`,
          window.secondary,
        ),
      ]),
      rateLimits.credits === null
        ? "credits: unknown"
        : `credits: ${rateLimits.credits.unlimited ? "unlimited" : (rateLimits.credits.balance ?? "unknown")}`,
      rateLimits.individualLimit === null
        ? null
        : `individual limit: ${rateLimits.individualLimit.used}/${rateLimits.individualLimit.limit} used, ${rateLimits.individualLimit.remainingPercent}% remaining, resets ${formatTimestamp(rateLimits.individualLimit.resetsAt)}`,
      rateLimits.resetCredits === null
        ? null
        : `reset credits: ${rateLimits.resetCredits.availableCount}`,
      rateLimits.rateLimitReachedType === null
        ? null
        : `limit reached: ${rateLimits.rateLimitReachedType}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }
  if (rateLimits.provider === "claude-code") {
    return [
      `plan: ${rateLimits.subscriptionType ?? "unknown"}`,
      formatWindowLine("5-hour", rateLimits.fiveHour),
      formatWindowLine("7-day", rateLimits.sevenDay),
      formatWindowLine("7-day (Opus)", rateLimits.sevenDayOpus),
      formatWindowLine("7-day (Sonnet)", rateLimits.sevenDaySonnet),
      ...rateLimits.modelScoped.map((window) =>
        formatWindowLine(window.displayName, window),
      ),
      rateLimits.extraUsage === null
        ? null
        : `extra usage: ${rateLimits.extraUsage.isEnabled ? "enabled" : "disabled"}, ${rateLimits.extraUsage.usedCredits ?? "unknown"}/${rateLimits.extraUsage.monthlyLimit ?? "unknown"} credits used`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }
  if (rateLimits.provider === "openrouter") {
    return [
      `balance: ${formatNumber(rateLimits.balance)}`,
      `credits: ${formatNumber(rateLimits.totalUsage)}/${formatNumber(rateLimits.totalCredits)} used`,
      `key limit: ${formatNumber(rateLimits.limitRemaining)}/${formatNumber(rateLimits.limit)} remaining`,
      `spend: ${formatNumber(rateLimits.dailySpend)} today, ${formatNumber(rateLimits.weeklySpend)} this week, ${formatNumber(rateLimits.monthlySpend)} this month`,
    ].join("\n");
  }
  return [
    `credit balance: ${formatNumber(rateLimits.creditBalance)}`,
    `pass: ${rateLimits.passState ?? "unknown"}`,
  ].join("\n");
}

/**
 * A `null` window is a window this provider did not report - rendered as
 * unknown, never as `0% used`, so a formatted read can't imply headroom the
 * provider never claimed.
 */
function formatWindowLine(
  label: string,
  window: ProviderRateLimitWindow | null,
): string {
  if (window === null) return `${label}: unknown`;
  const resets =
    window.resetsAt === null
      ? ""
      : `, resets ${formatTimestamp(window.resetsAt)}`;
  const duration =
    window.durationMinutes === null
      ? ""
      : `, ${window.durationMinutes}m window`;
  return `${label}: ${window.usedPercent}% used${resets}${duration}`;
}

/**
 * The target agent id is a formatter argument for the same reason the
 * selection is above: `agent.configure` answers with the committed run tuple
 * and its warnings, and the caller already knows which agent it configured.
 */
export function formatAgentConfigureResponse(
  agentId: string,
  response: AgentConfigureResponse,
): string {
  const settings = response.settings;
  const lines = [
    `Agent ${agentId} configured for future turns:`,
    `harness: ${settings.harnessId}`,
    `model: ${settings.model}`,
    `profile: --profile ${formatProfileSelection(settings.profileSelection)}`,
    `reasoningEffort: ${settings.reasoningEffort ?? "-"}`,
    `fastMode: ${settings.fastMode ? "on" : "off"}`,
    `permissionMode: ${settings.permissionMode}`,
    `agentMode: ${settings.agentMode}`,
  ];
  if (response.warnings.length === 0) return lines.join("\n");
  return `${lines.join("\n")}
Warnings:
${response.warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

// Epoch-ms → ISO 8601. `null` means no reading has ever been captured for
// this profile (never ran a turn, no probe) - reported as such rather than
// as an epoch-zero timestamp.
function formatTimestamp(epochMs: number | null): string {
  if (epochMs === null) return "never";
  return new Date(epochMs).toISOString();
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : `${value}`;
}
