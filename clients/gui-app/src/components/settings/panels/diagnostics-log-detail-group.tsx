import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup } from "@/components/settings/settings-group";
import { LogLevelRow } from "@/components/settings/panels/log-level-row";
import type { LogLevelControl } from "@/components/settings/panels/log-level-controls";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";

/** A titled "Log detail" card with an empty body is a promise the page cannot keep. */
export function LogDetailGroup(props: {
  readonly controls: readonly LogLevelControl[];
  /** The caller owns this because the two pages fail for unrelated reasons: the app page has no rows only outside
   * the desktop shell, while the host page has none when the host predates the config RPC. */
  readonly emptyState: ReactNode;
}): ReactNode {
  const { controls } = props;
  const [resetPending, setResetPending] = useState(false);
  // Focus-restoration target for when the reminder row (and the "Reset all to Info" button a
  // keyboard/screen-reader user just activated) unmounts - without this, focus silently drops to `<body>`.
  const groupContentRef = useRef<HTMLDivElement>(null);
  const reminderWasVisibleRef = useRef(false);
  const reminderHadFocusRef = useRef(false);

  const nonDefaultControls = useMemo(
    () =>
      controls.filter(
        (control) => control.level !== undefined && control.level !== "info",
      ),
    [controls],
  );

  useEffect(() => {
    const isVisible = nonDefaultControls.length > 0;
    if (
      reminderWasVisibleRef.current &&
      !isVisible &&
      reminderHadFocusRef.current
    ) {
      groupContentRef.current?.focus();
    }
    if (!isVisible) {
      reminderHadFocusRef.current = false;
    }
    reminderWasVisibleRef.current = isVisible;
  }, [nonDefaultControls.length]);

  const handleResetAll = async (): Promise<void> => {
    const pending = nonDefaultControls;
    setResetPending(true);
    let failedCount = 0;
    for (const control of pending) {
      try {
        await control.set("info");
      } catch {
        // The control's own transport already toasted this scope - keep going so one failure doesn't strand the
        // remaining scopes un-attempted and silently still elevated.
        failedCount += 1;
      }
    }
    setResetPending(false);
    // The plural is unconditional because this branch cannot be reached with fewer than two controls.
    if (failedCount > 0 && pending.length > 1) {
      toast.error(
        `Couldn't reset ${failedCount} of ${pending.length} log levels`,
      );
    }
  };

  if (controls.length === 0) {
    if (props.emptyState === null) return null;
    return (
      <SettingsGroup
        title="Log detail"
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        {props.emptyState}
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Log detail"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      <div
        ref={groupContentRef}
        tabIndex={-1}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {controls.map((control) => (
          <LogLevelRow
            key={control.scope}
            control={control}
            disabled={resetPending}
          />
        ))}
        {nonDefaultControls.length > 0 ? (
          <TemporaryDebugReminderRow
            pending={resetPending}
            onFocusChange={(focused) => {
              reminderHadFocusRef.current = focused;
            }}
            onReset={() => {
              void handleResetAll();
            }}
          />
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function TemporaryDebugReminderRow(props: {
  readonly pending: boolean;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onReset: () => void;
}): ReactNode {
  const { pending, onFocusChange, onReset } = props;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 bg-foreground/3 px-4 py-2.5 text-ui-xs text-muted-foreground"
      data-testid="diagnostics-log-detail-reminder"
      onFocusCapture={() => onFocusChange(true)}
      onBlurCapture={(event) => {
        const nextFocusedElement = event.relatedTarget;
        if (
          !(nextFocusedElement instanceof Node) ||
          !event.currentTarget.contains(nextFocusedElement)
        ) {
          onFocusChange(false);
        }
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Info className="size-3.5 shrink-0" aria-hidden />
        One or more levels differ from Info for troubleshooting. Reset when
        you&apos;re done.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={pending}
        onClick={onReset}
        data-testid="diagnostics-reset-log-levels"
      >
        {pending ? (
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Reset all to Info
      </Button>
    </div>
  );
}
