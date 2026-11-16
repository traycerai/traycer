import { useRef, useState } from "react";
import { HOST_OVERVIEW } from "./host-overview.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
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
  const { data, error, isFetching, refetch } = props.query;
  if (error?.code === "E_HOST_UNSUPPORTED") return null;
  if (error !== null) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.notificationLongTurnAlert}
        status="Couldn't load the turn alert."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (data === undefined) return null;
  const { thresholdMs } = data;
  return (
    <SettingsRow
      row={HOST_OVERVIEW.definitions.notificationLongTurnAlert}
      control={
        <Switch
          checked={thresholdMs !== null}
          disabled={props.setAlert.isPending}
          aria-label={HOST_OVERVIEW.definitions.notificationLongTurnAlert.label}
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
  const initialAmount = String(props.thresholdMs / UNIT_MS[initialUnit]);
  const [unit, setUnit] = useState<DurationUnit>(initialUnit);
  const [amount, setAmount] = useState(initialAmount);
  const [unitMenuOpen, setUnitMenuOpen] = useState(false);
  // The menu reports a pick and then its close in one handler, before a render.
  const pickedUnit = useRef(initialUnit);
  const restore = (): void => {
    pickedUnit.current = initialUnit;
    setUnit(initialUnit);
    setAmount(initialAmount);
  };
  const commit = (nextAmount: string, nextUnit: DurationUnit): void => {
    const wholeAmount = Number(nextAmount);
    const thresholdMs = wholeAmount * UNIT_MS[nextUnit];
    if (
      !Number.isInteger(wholeAmount) ||
      !Number.isSafeInteger(thresholdMs) ||
      thresholdMs <= 0
    ) {
      restore();
      return;
    }
    if (thresholdMs === props.thresholdMs) return;
    props.setAlert.mutate({ thresholdMs }, { onError: restore });
  };
  const unitSuffix = Number(amount) === 1 ? "" : "s";
  return (
    // The amount and the unit are one value: saving when focus moves between
    // them would save the new amount in the old unit, and a running turn already
    // past that value would spend its one alert on it.
    <div
      className="flex flex-wrap items-center gap-2"
      onBlur={(event) => {
        if (unitMenuOpen) return;
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        commit(amount, unit);
      }}
    >
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
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(amount, unit);
        }}
      />
      <Select
        value={unit}
        open={unitMenuOpen}
        onOpenChange={(open) => {
          setUnitMenuOpen(open);
          if (!open) commit(amount, pickedUnit.current);
        }}
        onValueChange={(value) => {
          if (!isDurationUnit(value)) return;
          pickedUnit.current = value;
          setUnit(value);
        }}
      >
        <SelectTrigger aria-label="Turn alert duration unit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minutes">{`minute${unitSuffix}`}</SelectItem>
          <SelectItem value="hours">{`hour${unitSuffix}`}</SelectItem>
          <SelectItem value="days">{`day${unitSuffix}`}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
