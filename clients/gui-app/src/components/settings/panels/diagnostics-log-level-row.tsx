import {
  DIAGNOSTIC_LOG_LEVELS,
  HOST_DIAGNOSTIC_LOG_LEVELS,
  isDiagnosticLogLevel,
  isHostDiagnosticLogLevel,
  type DiagnosticLogLevel,
  type HostDiagnosticLogLevel,
} from "@traycer/protocol/config/diagnostics-schema";
import type { TraycerDiagnosticsConfigSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "@/components/settings/settings-row";
import { useRunnerTraycerDiagnosticsConfigClearTemporaryMutation } from "@/hooks/runner/use-runner-traycer-diagnostics-config-clear-temporary-mutation";
import { useRunnerTraycerDiagnosticsConfigQuery } from "@/hooks/runner/use-runner-traycer-diagnostics-config-query";
import { useRunnerTraycerDiagnosticsConfigSetMutation } from "@/hooks/runner/use-runner-traycer-diagnostics-config-set-mutation";
import { useRunnerTraycerDiagnosticsConfigTemporaryMutation } from "@/hooks/runner/use-runner-traycer-diagnostics-config-temporary-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { isHostDiagnosticsApplied } from "@/lib/diagnostics-applied";

const UNSUPPORTED_SELECT_VALUE = "unsupported-configured-value";

type LogLevelSelectValue =
  | DiagnosticLogLevel
  | HostDiagnosticLogLevel
  | typeof UNSUPPORTED_SELECT_VALUE;

export function GeneralDiagnosticsLogLevelRow() {
  const runnerHost = useRunnerHost();
  const diagnosticsQuery = useRunnerTraycerDiagnosticsConfigQuery();
  const setMutation = useRunnerTraycerDiagnosticsConfigSetMutation();
  const temporaryMutation =
    useRunnerTraycerDiagnosticsConfigTemporaryMutation();
  const clearTemporaryMutation =
    useRunnerTraycerDiagnosticsConfigClearTemporaryMutation();

  if (runnerHost.traycerCli === null) return null;

  const snapshot = diagnosticsQuery.data;
  const permanentLevel = permanentGeneralLevel(snapshot?.raw.raw.logLevel);
  // Show "Clear" only when General has its OWN temporary override (active,
  // expired, or invalid), so the button always maps to an action that does
  // something.
  const temporaryActive = hasTemporaryField(
    snapshot?.raw.raw.temporaryLogLevel,
  );
  const pending =
    diagnosticsQuery.isPending ||
    setMutation.isPending ||
    temporaryMutation.isPending ||
    clearTemporaryMutation.isPending;

  return (
    <SettingsRow
      label="Diagnostic log level"
      description={generalDescription(snapshot, permanentLevel)}
      control={
        <LogLevelControls
          value={permanentLevel}
          levels={DIAGNOSTIC_LOG_LEVELS}
          pending={pending}
          debugPending={temporaryMutation.isPending}
          clearPending={clearTemporaryMutation.isPending}
          temporaryActive={temporaryActive}
          ariaLabel="Diagnostic log level"
          onChange={(level) => {
            if (!isDiagnosticLogLevel(level)) return;
            setMutation.mutate({ level, hostLevel: null });
          }}
          onDebug={() => {
            temporaryMutation.mutate({
              level: "debug",
              hostLevel: null,
              duration: "30m",
            });
          }}
          onClearTemporary={() => {
            clearTemporaryMutation.mutate("general");
          }}
        />
      }
    />
  );
}

export function HostDiagnosticsLogLevelRow() {
  const runnerHost = useRunnerHost();
  const diagnosticsQuery = useRunnerTraycerDiagnosticsConfigQuery();
  const setMutation = useRunnerTraycerDiagnosticsConfigSetMutation();
  const temporaryMutation =
    useRunnerTraycerDiagnosticsConfigTemporaryMutation();
  const clearTemporaryMutation =
    useRunnerTraycerDiagnosticsConfigClearTemporaryMutation();

  if (runnerHost.traycerCli === null) return null;

  const snapshot = diagnosticsQuery.data;
  const hostLevel = permanentHostLevel(snapshot?.effective.rawHostSetting);
  // Show "Clear" only when Host has its OWN temporary override. A purely
  // inherited General temporary surfaces as source "temporary-inherited" with
  // no host temporary, and clearing the (absent) host temporary would be a
  // no-op - that override is cleared from the General row instead.
  const temporaryActive = hasTemporaryField(
    snapshot?.raw.raw.temporaryHostLogLevel,
  );
  const pending =
    diagnosticsQuery.isPending ||
    setMutation.isPending ||
    temporaryMutation.isPending ||
    clearTemporaryMutation.isPending;

  return (
    <SettingsRow
      label="Host log level"
      description={hostDescription(snapshot)}
      control={
        <LogLevelControls
          value={hostLevel}
          levels={HOST_DIAGNOSTIC_LOG_LEVELS}
          pending={pending}
          debugPending={temporaryMutation.isPending}
          clearPending={clearTemporaryMutation.isPending}
          temporaryActive={temporaryActive}
          ariaLabel="Host log level"
          onChange={(level) => {
            if (!isHostDiagnosticLogLevel(level)) return;
            setMutation.mutate({ level: null, hostLevel: level });
          }}
          onDebug={() => {
            temporaryMutation.mutate({
              level: null,
              hostLevel: "debug",
              duration: "30m",
            });
          }}
          onClearTemporary={() => {
            clearTemporaryMutation.mutate("host");
          }}
        />
      }
    />
  );
}

function LogLevelControls(props: {
  readonly value: LogLevelSelectValue;
  readonly levels: readonly (DiagnosticLogLevel | HostDiagnosticLogLevel)[];
  readonly pending: boolean;
  readonly debugPending: boolean;
  readonly clearPending: boolean;
  readonly temporaryActive: boolean;
  readonly ariaLabel: string;
  readonly onChange: (level: string) => void;
  readonly onDebug: () => void;
  readonly onClearTemporary: () => void;
}) {
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      <Select
        value={props.value}
        disabled={props.pending}
        onValueChange={props.onChange}
      >
        <SelectTrigger
          size="sm"
          aria-label={props.ariaLabel}
          className="w-[min(52vw,11rem)]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.value === UNSUPPORTED_SELECT_VALUE ? (
            <SelectItem value={UNSUPPORTED_SELECT_VALUE} disabled>
              Unsupported value
            </SelectItem>
          ) : null}
          {props.levels.map((level) => (
            <SelectItem key={level} value={level}>
              {labelForLevel(level)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.pending}
        onClick={props.onDebug}
      >
        {props.debugPending ? (
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Debug 30m
      </Button>
      {props.temporaryActive ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.pending}
          onClick={props.onClearTemporary}
        >
          {props.clearPending ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Clear
        </Button>
      ) : null}
    </div>
  );
}

function generalDescription(
  snapshot: TraycerDiagnosticsConfigSnapshot | undefined,
  permanentLevel: LogLevelSelectValue,
): string {
  if (snapshot === undefined) {
    return "Controls desktop and CLI diagnostics. Host inherits this unless overridden.";
  }
  const scope = snapshot.effective.general;
  if (scope.source === "temporary" && scope.expiresAt !== null) {
    return `Temporary ${labelForLevel(scope.level)} until ${formatExpiry(scope.expiresAt)}. Permanent level is ${permanentLabel(permanentLevel)}.`;
  }
  if (scope.source === "unsupported-raw" || scope.source === "invalid-raw") {
    return `Configured value is unsupported. Effective level is ${labelForLevel(scope.level)}.`;
  }
  return `Effective level is ${labelForLevel(scope.level)}. Host inherits this unless overridden.`;
}

function hostDescription(
  snapshot: TraycerDiagnosticsConfigSnapshot | undefined,
): string {
  if (snapshot === undefined) {
    return "Use the General setting by default, or override only host logs.";
  }
  const scope = snapshot.effective.host;
  const temporary =
    scope.expiresAt === null
      ? ""
      : ` Temporary until ${formatExpiry(scope.expiresAt)}.`;
  const hostStatus = snapshot.hostStatus;
  if (scope.source === "unsupported-raw" || scope.source === "invalid-raw") {
    return `Configured host value is unsupported. Effective level is ${labelForLevel(scope.level)}.${temporary}`;
  }
  if (!hostStatus.supported) {
    return `Effective level is ${labelForLevel(scope.level)}. Running host has not confirmed support.${temporary}`;
  }
  const applied = hostAppliedDescription(snapshot);
  return `Effective level is ${labelForLevel(scope.level)}. ${applied}${temporary}`;
}

function hostAppliedDescription(
  snapshot: TraycerDiagnosticsConfigSnapshot,
): string {
  if (isHostDiagnosticsApplied(snapshot)) {
    return "Running host has applied it.";
  }
  if (snapshot.hostStatus.restartRequired) {
    return "Restart the host to apply this level.";
  }
  return "Waiting for running host to confirm this level.";
}

function permanentGeneralLevel(value: unknown): LogLevelSelectValue {
  if (value === undefined) return "info";
  return isDiagnosticLogLevel(value) ? value : UNSUPPORTED_SELECT_VALUE;
}

function permanentHostLevel(
  value: HostDiagnosticLogLevel | "unsupported" | "invalid" | undefined,
): LogLevelSelectValue {
  if (value === undefined) return "inherit";
  return isHostDiagnosticLogLevel(value) ? value : UNSUPPORTED_SELECT_VALUE;
}

function permanentLabel(value: LogLevelSelectValue): string {
  if (value === UNSUPPORTED_SELECT_VALUE) return "unsupported";
  return labelForLevel(value);
}

function hasTemporaryField(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function labelForLevel(
  level: DiagnosticLogLevel | HostDiagnosticLogLevel,
): string {
  switch (level) {
    case "inherit":
      return "Use General";
    case "trace":
      return "Trace";
    case "debug":
      return "Debug";
    case "info":
      return "Info";
    case "warn":
      return "Warn";
    case "error":
      return "Error";
    case "off":
      return "Off";
  }
}

function formatExpiry(expiresAt: string): string {
  return new Date(expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
