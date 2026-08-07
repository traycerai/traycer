import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Delete,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getTerminalKeyBarModifiers,
  subscribeTerminalKeyBarModifiers,
  consumeTerminalKeyBarModifiers,
  toggleTerminalKeyBarModifier,
} from "@/lib/terminals/terminal-key-bar-latch";
import { getTerminalKeyInput } from "@/lib/terminals/terminal-key-input-registry";
import {
  encodeTerminalKeyBarKey,
  type TerminalKeyBarActionKey,
} from "@/lib/terminals/terminal-key-sequences";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface MobileTerminalKeyBarProps {
  readonly instanceId: string;
  /**
   * True while the soft keyboard covers the bottom of the layout viewport
   * (the view is already padding the bar above it). The bar then drops its
   * safe-area bottom padding: the keyboard covers the home indicator, so
   * keeping `env(safe-area-inset-bottom)` would leave a dead gap between the
   * keys and the keyboard.
   */
  readonly keyboardOpen: boolean;
}

/**
 * On-screen terminal key bar for phones: the keys TUIs need that soft
 * keyboards don't have (Esc/Tab/arrows/Enter plus sticky Ctrl/Alt/Shift).
 * The layout is the two-row arrangement proven by Termux / Blink / Happy.
 *
 * Bar taps inject escape sequences into the tile's xterm engine via
 * `terminal-key-input-registry`; the engine is looked up per press, so the bar
 * tolerates the engine still lazy-bootstrapping (taps no-op until it mounts).
 * Modifier taps latch one-shot state in `terminal-key-bar-latch`, which also
 * combines a latched Ctrl/Alt with the next character typed on the phone
 * keyboard.
 */
export function MobileTerminalKeyBar(props: MobileTerminalKeyBarProps) {
  const { instanceId, keyboardOpen } = props;
  const latchedModifiers = useSyncExternalStore(
    subscribeTerminalKeyBarModifiers,
    getTerminalKeyBarModifiers,
  );

  // iOS decides "tap outside the focused field -> blur it and dismiss the
  // keyboard" from the TOUCH sequence, so the pointerdown preventDefault on
  // each button (sufficient on desktop) doesn't stop it. React registers
  // root touch listeners as passive, so this must be a native non-passive
  // listener. Canceling touchstart suppresses the focus change and the
  // compatibility mouse/click events; pointer events still fire, which is
  // where all bar behavior lives.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;
    const cancelTouch = (event: TouchEvent): void => {
      event.preventDefault();
    };
    bar.addEventListener("touchstart", cancelTouch, { passive: false });
    return () => bar.removeEventListener("touchstart", cancelTouch);
  }, []);

  const sendActionKey = useCallback(
    (key: TerminalKeyBarActionKey): void => {
      const target = getTerminalKeyInput(instanceId);
      if (target === null) return;
      // Consume even when the encoder ignores the latch (e.g. Esc), so a
      // stale modifier can never leak onto a later key.
      const modifiers = consumeTerminalKeyBarModifiers();
      target.input(
        encodeTerminalKeyBarKey(key, modifiers, target.getCursorKeyMode()),
      );
    },
    [instanceId],
  );

  // Long-press auto-repeat for arrows/backspace, like a physical key. The
  // latch is one-shot, so only the initial press carries latched modifiers;
  // repeats send the plain key. One repeat runs at a time, scoped to the
  // pointer that started it: without the pointer-id check, lifting a first
  // finger would kill the repeat a second finger is still holding.
  const repeatDelayRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);
  const repeatPointerIdRef = useRef<number | null>(null);
  const stopRepeat = useCallback((): void => {
    repeatPointerIdRef.current = null;
    if (repeatDelayRef.current !== null) {
      window.clearTimeout(repeatDelayRef.current);
      repeatDelayRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      stopRepeat();
      // The latch module is global and its only indicator is this bar; a
      // modifier left armed at unmount would invisibly transform the next
      // character typed into ANY terminal.
      consumeTerminalKeyBarModifiers();
    },
    [stopRepeat],
  );

  const handleActionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, def: ActionKeyDef): void => {
      // Secondary buttons get the browser default (e.g. context menu on a
      // desktop right-click at phone width), not a keypress.
      if (event.button !== 0) return;
      // Focus must stay on xterm's hidden textarea - the default would move it
      // to the button and dismiss the phone's soft keyboard on every tap.
      event.preventDefault();
      sendActionKey(def.key);
      if (!def.repeatable) return;
      stopRepeat();
      repeatPointerIdRef.current = event.pointerId;
      repeatDelayRef.current = window.setTimeout(() => {
        repeatDelayRef.current = null;
        repeatIntervalRef.current = window.setInterval(() => {
          sendActionKey(def.key);
        }, KEY_REPEAT_INTERVAL_MS);
      }, KEY_REPEAT_DELAY_MS);
    },
    [sendActionKey, stopRepeat],
  );

  const handleActionPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.pointerId !== repeatPointerIdRef.current) return;
      stopRepeat();
    },
    [stopRepeat],
  );

  return (
    <div
      ref={barRef}
      data-mobile-shell-touch-scope=""
      data-testid="mobile-terminal-key-bar"
      className={cn(
        "shrink-0 border-t border-canvas-border/70 bg-canvas px-1 pt-1",
        keyboardOpen ? "pb-1" : "pb-[max(0.25rem,env(safe-area-inset-bottom))]",
      )}
    >
      <div className="grid grid-cols-6 gap-1">
        {KEY_ROWS.flat().map((def) =>
          def.kind === "action" ? (
            <Button
              key={def.testId}
              type="button"
              variant="secondary"
              aria-label={def.ariaLabel}
              data-testid={`terminal-key-${def.testId}`}
              className={KEY_BUTTON_CLASS}
              onPointerDown={(event) => handleActionPointerDown(event, def)}
              onPointerUp={def.repeatable ? handleActionPointerEnd : undefined}
              onPointerLeave={
                def.repeatable ? handleActionPointerEnd : undefined
              }
              onPointerCancel={
                def.repeatable ? handleActionPointerEnd : undefined
              }
              onClick={(event) => {
                // Pointer taps already sent on pointerdown; `detail === 0`
                // identifies keyboard/AT activation, which only fires click.
                if (event.detail !== 0) return;
                sendActionKey(def.key);
              }}
            >
              {def.label}
            </Button>
          ) : (
            <Button
              key={def.testId}
              type="button"
              variant="secondary"
              aria-label={def.ariaLabel}
              aria-pressed={latchedModifiers[def.key]}
              data-testid={`terminal-key-${def.testId}`}
              className={cn(
                KEY_BUTTON_CLASS,
                latchedModifiers[def.key] &&
                  "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
              // Latch on pointerdown, like action keys: iOS suppresses the
              // synthesized click after a canceled touch start, so an
              // onClick-only toggle can never latch on a phone.
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                toggleTerminalKeyBarModifier(def.key);
              }}
              onClick={(event) => {
                // detail === 0 identifies keyboard/AT activation, which fires
                // click without a preceding pointerdown.
                if (event.detail !== 0) return;
                toggleTerminalKeyBarModifier(def.key);
              }}
            >
              {def.label}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

const KEY_BUTTON_CLASS =
  "min-h-11 w-full rounded-md px-0 text-ui-sm font-medium";

const KEY_REPEAT_DELAY_MS = 350;
const KEY_REPEAT_INTERVAL_MS = 60;

interface ActionKeyDef {
  readonly kind: "action";
  readonly key: TerminalKeyBarActionKey;
  readonly label: ReactNode;
  readonly ariaLabel: string;
  readonly repeatable: boolean;
  readonly testId: string;
}

interface ModifierKeyDef {
  readonly kind: "modifier";
  readonly key: "ctrl" | "alt" | "shift";
  readonly label: string;
  readonly ariaLabel: string;
  readonly testId: string;
}

type KeyDef = ActionKeyDef | ModifierKeyDef;

const KEY_ROWS: readonly (readonly KeyDef[])[] = [
  [
    {
      kind: "action",
      key: "escape",
      label: "Esc",
      ariaLabel: "Escape",
      repeatable: false,
      testId: "esc",
    },
    {
      kind: "action",
      key: "tab",
      label: "Tab",
      ariaLabel: "Tab",
      repeatable: false,
      testId: "tab",
    },
    {
      kind: "modifier",
      key: "ctrl",
      label: "Ctrl",
      ariaLabel: "Control modifier",
      testId: "ctrl",
    },
    {
      kind: "action",
      key: "arrow-up",
      label: <ArrowUp aria-hidden className="size-4" />,
      ariaLabel: "Arrow up",
      repeatable: true,
      testId: "arrow-up",
    },
    {
      kind: "modifier",
      key: "shift",
      label: "Shift",
      ariaLabel: "Shift modifier",
      testId: "shift",
    },
    {
      kind: "action",
      key: "backspace",
      label: <Delete aria-hidden className="size-4" />,
      ariaLabel: "Backspace",
      repeatable: true,
      testId: "backspace",
    },
  ],
  [
    {
      kind: "modifier",
      key: "alt",
      label: "Alt",
      ariaLabel: "Alt modifier",
      testId: "alt",
    },
    {
      kind: "action",
      key: "space",
      label: "Space",
      ariaLabel: "Space",
      repeatable: false,
      testId: "space",
    },
    {
      kind: "action",
      key: "arrow-left",
      label: <ArrowLeft aria-hidden className="size-4" />,
      ariaLabel: "Arrow left",
      repeatable: true,
      testId: "arrow-left",
    },
    {
      kind: "action",
      key: "arrow-down",
      label: <ArrowDown aria-hidden className="size-4" />,
      ariaLabel: "Arrow down",
      repeatable: true,
      testId: "arrow-down",
    },
    {
      kind: "action",
      key: "arrow-right",
      label: <ArrowRight aria-hidden className="size-4" />,
      ariaLabel: "Arrow right",
      repeatable: true,
      testId: "arrow-right",
    },
    {
      kind: "action",
      key: "enter",
      label: "Enter",
      ariaLabel: "Enter",
      repeatable: false,
      testId: "enter",
    },
  ],
];
