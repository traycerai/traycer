import {
  LOG_LEVELS,
  isLogLevel,
  type LogLevel,
} from "@traycer/protocol/config/log-level";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRunnerLogLevelsQuery } from "@/hooks/runner/use-runner-log-levels-query";
import { useRunnerLogLevelsSet } from "@/hooks/runner/use-runner-log-levels-set-mutation";
import {
  getLogLevelsBridge,
  selectScopeLevel,
  type LogLevelScope,
} from "@/lib/desktop-log-levels";

const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info (default)",
  warn: "Warn",
  error: "Error",
};

interface LogLevelRowProps {
  readonly scope: LogLevelScope;
  readonly label: string;
  readonly description: string;
  // Externally-driven disable, e.g. a caller-coordinated bulk reset across
  // several `LogLevelRow`s - so the row can't fire a conflicting per-scope
  // mutation while that coordinated operation is in flight.
  readonly disabled: boolean;
}

/**
 * One Settings dropdown for a log threshold (desktop / cli / host). Reads the
 * shared log-levels query (deduped across the rows) and writes through the set
 * mutation. Renders nothing outside the desktop shell, where the bridge — and
 * therefore the config — is absent.
 */
export function LogLevelRow(props: LogLevelRowProps) {
  const { scope, label, description, disabled } = props;
  const query = useRunnerLogLevelsQuery();
  const setMutation = useRunnerLogLevelsSet();

  if (getLogLevelsBridge() === null) return null;

  const value =
    query.data === undefined ? undefined : selectScopeLevel(query.data, scope);

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <Select
          value={value}
          disabled={
            disabled ||
            query.isPending ||
            query.isError ||
            setMutation.isPending
          }
          onValueChange={(next) => {
            if (isLogLevel(next)) {
              setMutation.mutate({ scope, level: next });
            }
          }}
        >
          <SelectTrigger
            className="w-[min(40vw,9rem)]"
            aria-label={label}
            data-testid={`settings-log-level-${scope}`}
          >
            <SelectValue placeholder="Loading…" />
          </SelectTrigger>
          <SelectContent>
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {LOG_LEVEL_LABEL[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}
