import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Globe, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export type LandingNewTabKind = "terminal" | "browser";

export interface LandingNewTabCardState {
  /** Why this kind cannot be picked right now, or `null` when it can. */
  readonly disabledReason: string | null;
}

export interface LandingNewTabChooserProps {
  readonly terminal: LandingNewTabCardState;
  readonly browser: LandingNewTabCardState;
  /**
   * Whether the chooser may take the keyboard.
   *
   * False while something is layered over it - picking Terminal raises the
   * directory picker ABOVE the still-mounted chooser, which is `aria-hidden`
   * underneath it. The focus effect below re-runs whenever a card's gate moves,
   * so without this a device answering its tab count mid-picker would pull
   * focus out of the picker and into a hidden control.
   */
  readonly takeFocus: boolean;
  readonly onPick: (kind: LandingNewTabKind) => void;
  /** Escape, and the placeholder's own close. */
  readonly onDismiss: () => void;
}

/**
 * The placeholder tab's body: pick Terminal or Browser, in place.
 *
 * Each card carries its own reason for being unavailable rather than the whole
 * chooser going dead, because the two kinds fail for unrelated reasons - a
 * device with no attached folder can still open a browser, and a device at the
 * browser tab cap can still open a terminal. That is also why the strip's "+"
 * no longer gates on the terminal create reason: it opens THIS, and this is
 * where a refusal can name which half it applies to.
 */
export function LandingNewTabChooser(
  props: LandingNewTabChooserProps,
): ReactNode {
  const { onDismiss, onPick, takeFocus } = props;
  const terminalRef = useRef<HTMLButtonElement | null>(null);
  const browserRef = useRef<HTMLButtonElement | null>(null);
  const terminalEnabled = props.terminal.disabledReason === null;
  const browserEnabled = props.browser.disabledReason === null;

  // Placement is a ONE-SHOT: on mount, and again on the false -> true edge of
  // `takeFocus`. It deliberately does not re-place when a card's gate moves,
  // because those gates settle during the interaction - a device publishing its
  // inventory flips `browserEnabled` seconds after the panel opens - and
  // re-placing there takes the keyboard back from wherever the user put it. The
  // next keystroke then performs the other action, so this is a correctness
  // rule and not a focus nicety.
  const placedRef = useRef(false);
  useEffect(() => {
    if (!takeFocus) {
      placedRef.current = false;
      return;
    }
    if (!placedRef.current) {
      placedRef.current = true;
      // Terminal takes focus, per the core flows - unless it is the one that
      // cannot be picked, in which case parking focus on a dead control would
      // make Enter do nothing with no explanation of why.
      const initial =
        terminalEnabled || !browserEnabled ? terminalRef : browserRef;
      initial.current?.focus();
      return;
    }
    // The one thing that moves focus after placement: the card HOLDING it goes
    // dead. Leaving it there would make Enter silently do nothing, and the
    // other card is the only thing left to offer.
    const active = document.activeElement;
    if (active === terminalRef.current && !terminalEnabled && browserEnabled) {
      browserRef.current?.focus();
      return;
    }
    if (active === browserRef.current && !browserEnabled && terminalEnabled) {
      terminalRef.current?.focus();
    }
  }, [browserEnabled, takeFocus, terminalEnabled]);

  // Escape lives on the CONTAINER, which is focusable for exactly that reason:
  // a click on the chooser's padding takes focus off the cards, and without a
  // `tabIndex` it would land on `<body>`, where no handler of ours ever sees
  // the key. It is attached natively rather than as an `onKeyDown` prop because
  // `group` is a non-interactive role and the a11y rule forbids the prop there;
  // the role is correct for two cards, so the listener moves instead.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  // Arrow keys stay on the CARDS: they are about moving between the two, both
  // are focusable, and each one knows where "the other" is. Escape bubbles from
  // here to the container listener above, so it needs no branch of its own.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();
    // Two cards, so either direction is "the other one". Focus moves onto a
    // disabled card as well: `aria-disabled` keeps it reachable precisely so
    // the reader can land on it and read why it cannot be picked.
    const next =
      document.activeElement === terminalRef.current
        ? browserRef.current
        : terminalRef.current;
    next?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="New tab"
      // Programmatically focusable only - never a tab stop, since the two cards
      // are what the keyboard should reach.
      tabIndex={-1}
      data-testid="landing-new-tab-chooser"
      className="flex h-full w-full flex-col items-center justify-center gap-6 p-6 outline-hidden"
    >
      <div className="flex w-full max-w-md flex-wrap items-stretch justify-center gap-3">
        <LandingNewTabCard
          cardRef={terminalRef}
          kind="terminal"
          title="Terminal"
          description="Shell in the selected folder"
          icon={<TerminalSquare className="size-5" aria-hidden="true" />}
          disabledReason={props.terminal.disabledReason}
          onPick={onPick}
          onKeyDown={handleKeyDown}
        />
        <LandingNewTabCard
          cardRef={browserRef}
          kind="browser"
          title="Browser"
          description="Signed-in browser on this device"
          icon={<Globe className="size-5" aria-hidden="true" />}
          disabledReason={props.browser.disabledReason}
          onPick={onPick}
          onKeyDown={handleKeyDown}
        />
      </div>
      <p className="text-center text-ui-xs text-muted-foreground">
        Enter opens Terminal · ⇧⌘J terminal · ⇧⌘B browser
      </p>
    </div>
  );
}

/**
 * The ref is named `cardRef` rather than `ref` deliberately: a `ref` inside a
 * props OBJECT makes the compiler's ref analysis treat every other `props.x`
 * read in the component as a ref access during render.
 */
function LandingNewTabCard({
  cardRef,
  kind,
  title,
  description,
  icon,
  disabledReason,
  onPick,
  onKeyDown,
}: {
  readonly cardRef: RefObject<HTMLButtonElement | null>;
  readonly kind: LandingNewTabKind;
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly disabledReason: string | null;
  readonly onPick: (kind: LandingNewTabKind) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const disabled = disabledReason !== null;
  return (
    <button
      ref={cardRef}
      type="button"
      // `aria-disabled` rather than a native `disabled`: a natively disabled
      // button is unfocusable, and the reason below it is the whole point of
      // leaving the card on screen. Same convention as the strip's controls.
      aria-disabled={disabled || undefined}
      data-testid={`landing-new-tab-card-${kind}`}
      className={cn(
        "flex min-w-0 flex-1 basis-40 flex-col items-center gap-2 rounded-xl border border-border bg-foreground/5 p-4 text-center outline-hidden transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "hover:border-primary/40 hover:bg-foreground/8",
      )}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (disabled) return;
        onPick(kind);
      }}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-foreground/8 text-foreground">
        {icon}
      </span>
      <span className="text-ui-sm font-medium text-foreground">{title}</span>
      <span className="text-ui-xs text-muted-foreground">{description}</span>
      {disabledReason === null ? null : (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid={`landing-new-tab-card-${kind}-reason`}
        >
          {disabledReason}
        </span>
      )}
    </button>
  );
}
