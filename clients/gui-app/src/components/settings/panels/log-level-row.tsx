import { LOG_LEVELS, isLogLevel } from "@traycer/protocol/config/log-level";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LogLevelControl } from "@/components/settings/panels/log-level-controls";

const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info (default)",
  warn: "Warn",
  error: "Error",
};

interface LogLevelRowProps {
  readonly control: LogLevelControl;
  // Externally-driven disable, e.g. a caller-coordinated bulk reset across
  // several `LogLevelRow`s - so the row can't fire a conflicting per-scope
  // mutation while that coordinated operation is in flight.
  readonly disabled: boolean;
}

/**
 * One Settings dropdown for a log threshold. Purely presentational: the control
 * arrives with its own transport already resolved (local bridge for `desktop`,
 * the selected host's config RPC for `cli`/`host` - see `LogLevelControl`), so
 * this row is identical whichever machine is answering.
 */
export function LogLevelRow(props: LogLevelRowProps) {
  const { control, disabled } = props;

  return (
    <SettingsRow
      label={control.label}
      description={control.description}
      control={
        <Select
          value={control.level}
          disabled={disabled || control.busy}
          onValueChange={(next) => {
            if (isLogLevel(next)) {
              void control.set(next).catch(() => {
                // The control's own transport toasts; a rejection here is the
                // already-reported failure travelling back out of `set`.
              });
            }
          }}
        >
          <SelectTrigger
            className="w-[min(40vw,9rem)]"
            aria-label={control.label}
            data-testid={`settings-log-level-${control.scope}`}
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
