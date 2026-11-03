import { useState } from "react";
import { HOST_NOTIFICATIONS } from "@/components/settings/panels/notifications-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  LongTurnAlertQuery,
  SetLongTurnAlertMutation,
} from "@/hooks/host/use-host-notifications-long-turn-alert";

type DurationUnit = "minutes" | "hours" | "days";

const UNIT_MS: Readonly<Record<DurationUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** What the duration fields show the moment the switch goes on. */
const INITIAL_THRESHOLD_MS = 4 * UNIT_MS.hours;

function largestWholeUnit(thresholdMs: number): DurationUnit {
  if (thresholdMs % UNIT_MS.days === 0) return "days";
  if (thresholdMs % UNIT_MS.hours === 0) return "hours";
  return "minutes";
}

function isDurationUnit(value: string): value is DurationUnit {
  return value === "minutes" || value === "hours" || value === "days";
}

/** A host older than this setting does not serve it, so the row is not drawn. */
export function NotificationLongTurnAlertRow(props: {
  readonly query: LongTurnAlertQuery;
  readonly setAlert: SetLongTurnAlertMutation;
}) {
  const { data } = props.query;
  if (data === undefined) return null;
  const { thresholdMs } = data;
  return (
    <SettingsRow
      row={HOST_NOTIFICATIONS.definitions.longTurnAlert}
      control={
        <Switch
          checked={thresholdMs !== null}
          disabled={props.setAlert.isPending}
          aria-label={HOST_NOTIFICATIONS.definitions.longTurnAlert.label}
          data-testid="notifications-long-turn-alert"
          onCheckedChange={(checked) => {
            props.setAlert.mutate({
              thresholdMs: checked ? INITIAL_THRESHOLD_MS : null,
            });
          }}
        />
      }
      details={
        thresholdMs === null ? null : (
          // Keyed so a value the host answered replaces the draft in the fields.
          <LongTurnAlertDuration
            key={thresholdMs}
            thresholdMs={thresholdMs}
            setAlert={props.setAlert}
          />
        )
      }
    />
  );
}

function LongTurnAlertDuration(props: {
  readonly thresholdMs: number;
  readonly setAlert: SetLongTurnAlertMutation;
}) {
  const initialUnit = largestWholeUnit(props.thresholdMs);
  const [unit, setUnit] = useState<DurationUnit>(initialUnit);
  const [amount, setAmount] = useState(
    String(props.thresholdMs / UNIT_MS[initialUnit]),
  );
  const commit = (nextAmount: string, nextUnit: DurationUnit): void => {
    const thresholdMs = Number(nextAmount) * UNIT_MS[nextUnit];
    if (!Number.isSafeInteger(thresholdMs) || thresholdMs <= 0) {
      setUnit(initialUnit);
      setAmount(String(props.thresholdMs / UNIT_MS[initialUnit]));
      return;
    }
    if (thresholdMs === props.thresholdMs) return;
    props.setAlert.mutate({ thresholdMs });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={amount}
        aria-label="Turn alert duration"
        data-testid="notifications-long-turn-alert-amount"
        className="w-24"
        onChange={(event) => setAmount(event.target.value)}
        onBlur={() => commit(amount, unit)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(amount, unit);
        }}
      />
      <Select
        value={unit}
        onValueChange={(value) => {
          if (!isDurationUnit(value)) return;
          setUnit(value);
          commit(amount, value);
        }}
      >
        <SelectTrigger aria-label="Turn alert duration unit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minutes">minutes</SelectItem>
          <SelectItem value="hours">hours</SelectItem>
          <SelectItem value="days">days</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
