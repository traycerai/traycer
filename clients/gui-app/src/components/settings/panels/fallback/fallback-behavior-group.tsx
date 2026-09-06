import type { ReactNode } from "react";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { withStoredNumber } from "@/components/settings/panels/fallback/fallback-behavior-range";
import { useSettingsRowDescriptionId } from "@/components/settings/settings-row-description";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { cn } from "@/lib/utils";

const TRIGGER_CLASS = "w-[min(60vw,12rem)]";

/**
 * The grace window the product offers, in seconds.
 *
 * The wire schema's range is much wider (5-300, and the host defaults to 15).
 * That width is for the engine and for a programmatic writer; the settings
 * surface offers the range the feature was designed around, because a
 * two-second window cannot be cancelled by a human and a five-minute one is
 * not a grace window. A stored value outside this list is still RENDERED (see
 * {@link withStoredNumber}) rather than clamped on load.
 */
const GRACE_WINDOW_SECONDS: readonly number[] = [10, 11, 12, 13, 14, 15];

/** Session-scale waits, plus the two longer ones a weekly limit needs. */
const MAX_WAIT_MINUTES: readonly number[] = [
  60, 180, 360, 720, 1440, 4320, 10_080,
];

function secondsLabel(seconds: number): string {
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function waitLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const RETURN_TO_PREFERRED_COPY: Record<
  FallbackPolicy["returnToPreferred"],
  { readonly label: string; readonly description: string | null }
> = {
  prompt: {
    label: "Ask me",
    description: null,
  },
  auto: {
    label: "Switch back automatically",
    // Both consequences, because each surprises someone: the fresh session is
    // what a provider switch always costs, and the queued messages moving back
    // is the half a user is most likely not to expect.
    description: "Starts a fresh session and moves queued messages back.",
  },
  stay: {
    label: "Stay on the fallback",
    description: null,
  },
};

export interface FallbackBehaviorGroupProps {
  readonly policy: FallbackPolicy;
  readonly onChange: (next: FallbackPolicy) => void;
  /**
   * The panel's save/error line, rendered inside this group's card.
   *
   * Passed in rather than derived here because the draft state lives one level
   * up: this group edits a policy, it does not own the outcome of saving one.
   */
  readonly status: ReactNode;
}

/**
 * Behavior: the three settings that shape HOW a fallback runs, as opposed to
 * which steps it may take.
 */
export function FallbackBehaviorGroup(
  props: FallbackBehaviorGroupProps,
): ReactNode {
  const { policy, onChange } = props;
  return (
    <SettingsGroup
      title="Behavior"
      tone="default"
      dataTestId="settings-fallback-behavior-group"
      fill={false}
    >
      <SettingsRow
        label="Time to cancel before switching"
        description="How long a chat shows the switch card before it goes ahead. Opening the destination menu pauses this."
        control={
          <NumberSelect
            ariaLabel="Time to cancel before switching"
            options={withStoredNumber(
              GRACE_WINDOW_SECONDS,
              policy.graceWindowSeconds,
            )}
            value={policy.graceWindowSeconds}
            format={secondsLabel}
            onValueChange={(seconds) => {
              onChange({ ...policy, graceWindowSeconds: seconds });
            }}
          />
        }
      />
      <SettingsRow
        label="Longest wait for a reset"
        description="The waiting step is skipped when a provider's limit resets later than this."
        control={
          <NumberSelect
            ariaLabel="Longest wait for a reset"
            options={withStoredNumber(MAX_WAIT_MINUTES, policy.maxWaitMinutes)}
            value={policy.maxWaitMinutes}
            format={waitLabel}
            onValueChange={(minutes) => {
              onChange({ ...policy, maxWaitMinutes: minutes });
            }}
          />
        }
      />
      <ReturnToPreferredRow policy={policy} onChange={onChange} />
      {props.status}
    </SettingsGroup>
  );
}

interface ReturnToPreferredRowProps {
  readonly policy: FallbackPolicy;
  readonly onChange: (next: FallbackPolicy) => void;
}

/**
 * A radio group rather than a select, unlike the two rows above it.
 *
 * Two of the three arms have a consequence that has to be readable BEFORE the
 * choice is made - `auto` starts a fresh session and moves queued messages -
 * and a select hides every option but the current one behind a click. Three
 * options with descriptions is exactly the case radios are for.
 */
function ReturnToPreferredRow(props: ReturnToPreferredRowProps): ReactNode {
  const { policy, onChange } = props;
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border/40 px-5 py-4 last:border-b-0",
        SETTINGS_ROW_STACK.container,
      )}
    >
      <div
        className={cn("min-w-[50%] flex-1 space-y-1", SETTINGS_ROW_STACK.label)}
      >
        <div className="font-medium text-foreground">
          When the original provider&apos;s limit resets
        </div>
        <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
          Switching back costs a fresh session too, so this is a choice rather
          than a default.
        </p>
      </div>
      <div className={cn("ml-auto", SETTINGS_ROW_STACK.control)}>
        <RadioGroup
          value={policy.returnToPreferred}
          onValueChange={(value) => {
            const next = returnToPreferredValue(value);
            if (next === null) return;
            onChange({ ...policy, returnToPreferred: next });
          }}
          className="gap-2"
        >
          {Object.entries(RETURN_TO_PREFERRED_COPY).map(([value, copy]) => (
            <div key={value} className="flex items-start gap-2">
              <RadioGroupItem
                value={value}
                id={`fallback-return-${value}`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label
                  htmlFor={`fallback-return-${value}`}
                  className="font-normal"
                >
                  {copy.label}
                </Label>
                {copy.description === null ? null : (
                  <p className="text-ui-sm text-muted-foreground">
                    {copy.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}

/**
 * Radix hands back a bare `string`. Narrowing through the copy map recovers the
 * union without a cast, and answers `null` for anything else - which cannot
 * happen from these items, but is the honest shape for a widened value.
 */
function returnToPreferredValue(
  value: string,
): FallbackPolicy["returnToPreferred"] | null {
  if (value === "prompt" || value === "auto" || value === "stay") return value;
  return null;
}

function NumberSelect(props: {
  readonly ariaLabel: string;
  readonly options: readonly number[];
  readonly value: number;
  readonly format: (value: number) => string;
  readonly onValueChange: (value: number) => void;
}): ReactNode {
  const describedById = useSettingsRowDescriptionId();
  return (
    <Select
      value={String(props.value)}
      onValueChange={(next) => {
        const parsed = Number(next);
        if (!Number.isInteger(parsed)) return;
        props.onValueChange(parsed);
      }}
    >
      <SelectTrigger
        aria-label={props.ariaLabel}
        aria-describedby={describedById}
        className={TRIGGER_CLASS}
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((option) => (
          <SelectItem key={option} value={String(option)}>
            {props.format(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
