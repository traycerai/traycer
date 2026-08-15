import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup } from "@/components/settings/settings-group";
import { LogLevelRow } from "@/components/settings/panels/log-level-row";
import type { LogLevelControl } from "@/components/settings/panels/log-level-controls";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";

/**
 * Verbosity controls plus the "you left a level raised" reminder, over whatever
 * set of controls its caller hands it.
 *
 * It used to be one group holding all three scopes, and the mixed scope was the
 * problem: `desktop` describes this app window wherever it points, while `cli`
 * and `host` are fields of the selected host's config store. Rendering them
 * together meant the app row was re-drawn under every host in the account,
 * offering the same single setting N times. Splitting the PAGES rather than the
 * group is what let this component stop caring — each caller passes the
 * controls it owns, and the reset sweep walks them without knowing which is
 * which (see `LogLevelControl`: the transport is already resolved).
 *
 * With no controls AND no `emptyState` it renders nothing at all. A titled
 * "Log detail" card with an empty body is a promise the page cannot keep — and
 * once the desktop row moved out, that is exactly what the host page would show
 * whenever the host is too old for `config.logLevels.get` and the logs region
 * below is already saying so.
 */
export function LogDetailGroup(props: {
  readonly controls: readonly LogLevelControl[];
  /**
   * Why there are no rows, in the caller's own words — or `null` to render
   * nothing when something else on the page already explains it.
   *
   * The caller owns this because the two pages fail for unrelated reasons: the
   * app page has no rows only outside the desktop shell, while the host page
   * has none when the host predates the config RPC. The old shared copy ("only
   * available on the desktop app") was wrong for the second case in the worst
   * way — it told someone to install an app they were already running.
   */
  readonly emptyState: ReactNode;
}): ReactNode {
  const { controls } = props;
  const [resetPending, setResetPending] = useState(false);
  // Focus-restoration target for when the reminder row (and the "Reset all to
  // Info" button a keyboard/screen-reader user just activated) unmounts -
  // without this, focus silently drops to `<body>`. Tracks the PRIOR
  // visibility so it only fires on the true->false transition, never on
  // initial mount (mirrors `host-settings-summary-card.tsx`'s
  // `wasEditingRef` pattern for the analogous "the focused control
  // disappears" case).
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
        // The control's own transport already toasted this scope - keep
        // going so one failure doesn't strand the remaining scopes
        // un-attempted and silently still elevated.
        failedCount += 1;
      }
    }
    setResetPending(false);
    // Only the MULTI-control case earns an aggregate line: with one control
    // its transport's own toast already said the same thing, and a second
    // would double-report a single failure. The plural is unconditional
    // because this branch cannot be reached with fewer than two controls.
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
      className="flex flex-wrap items-center justify-between gap-3 bg-muted/20 px-4 py-2.5 text-ui-xs text-muted-foreground"
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
