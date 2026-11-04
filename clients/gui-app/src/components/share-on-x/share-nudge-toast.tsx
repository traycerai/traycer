import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { XLogo } from "@/components/share-on-x/x-logo";

/** How long the toast waits on "Remind me later" before it goes by itself. */
const SHARE_NUDGE_COUNTDOWN_MS = 10_000;
const TICK_MS = 200;

export type ShareNudgeChoice = "share" | "remind_later" | "opt_out" | "timeout";

/**
 * The body of the "share Traycer on X" toast. "Remind me later" carries the
 * countdown: its seconds and a fill that empties behind its label. Both stop
 * while the pointer is over the toast or focus is inside it, so a person who
 * is reading or tabbing through it is never cut off. At zero the toast
 * chooses "Remind me later" on the person's behalf, as a timeout.
 */
export function ShareNudgeToastContent(props: {
  readonly onChoose: (choice: ShareNudgeChoice) => void;
}): ReactNode {
  const [remainingMs, setRemainingMs] = useState(SHARE_NUDGE_COUNTDOWN_MS);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const chosenRef = useRef(false);

  function choose(choice: ShareNudgeChoice): void {
    if (chosenRef.current) return;
    chosenRef.current = true;
    props.onChoose(choice);
  }
  const chooseTimeout = useEffectEvent(() => {
    choose("timeout");
  });

  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      if (pointerInsideRef.current || focusInsideRef.current) return;
      setRemainingMs((current) => Math.max(0, current - elapsed));
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (remainingMs === 0) chooseTimeout();
  }, [remainingMs]);

  const seconds = Math.ceil(remainingMs / 1_000);
  const fill = remainingMs / SHARE_NUDGE_COUNTDOWN_MS;

  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="share-nudge-toast"
      onPointerEnter={() => {
        pointerInsideRef.current = true;
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
      }}
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusInsideRef.current = false;
        }
      }}
    >
      <div className="flex flex-col gap-1">
        {/* The opt-out rides the title row, quieter than the two choices,
            so those two keep one row to themselves. */}
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium">Glad that worked out</div>
          <Button
            type="button"
            size="xs"
            variant="muted"
            className="-my-1 -mr-2 shrink-0"
            onClick={() => choose("opt_out")}
          >
            Don't ask again
          </Button>
        </div>
        <div className="text-muted-foreground">
          If Traycer saved you some time, a post on X helps other people find
          it.
        </div>
      </div>
      {/* Wraps rather than clips when large text outgrows the toast. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          onClick={(event) => {
            // Out of the picture before the window is captured: the toast's
            // own exit animation would still be on screen two frames later.
            const toastNode = event.currentTarget.closest<HTMLElement>(
              "[data-sonner-toast]",
            );
            if (toastNode !== null) toastNode.style.visibility = "hidden";
            choose("share");
          }}
        >
          <XLogo className="size-3.5" />
          Share on X
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="relative overflow-hidden"
          onClick={() => choose("remind_later")}
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-foreground/10 transition-[width] duration-200 ease-linear motion-reduce:hidden"
            style={{ width: `${String(fill * 100)}%` }}
          />
          <span className="relative flex items-center gap-1.5">
            Remind me later
            {/* Seen, not spoken: the toast sits in a live region, which would
                read every tick aloud. Focus pauses the countdown anyway. */}
            <span
              aria-hidden="true"
              className="min-w-[2.5ch] text-right text-muted-foreground tabular-nums"
            >
              {String(seconds)}s
            </span>
          </span>
        </Button>
      </div>
    </div>
  );
}
