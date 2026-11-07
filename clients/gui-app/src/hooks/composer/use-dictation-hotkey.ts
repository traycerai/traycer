import { use, useEffect, useRef } from "react";
import { KeyboardOwnerContext } from "@/hooks/use-primary-action-shortcut";
import { normalizeCode, parseChordString } from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import type { VoiceDictationState } from "@/hooks/composer/use-voice-dictation";

// The dictation shortcut is a first-class, rebindable keybinding (see
// `ACTION_META`); default Control+Shift+M (the Control key dodges the
// Command-based conflicts on macOS). We read the live binding from the store at
// event time so rebinds apply immediately and Settings stays the source of truth.
//
// The same chord is the call's on a bot surface (Call Tracy, P15): a bot surface
// that owns the keyboard registers a call target instead of a composer, and the
// one owner on top of the stack takes the press. In an agent chat it dictates;
// on a bot's channel or thread it starts or ends a call; never both.
export const DICTATION_ACTION_ID = "composer.dictation.toggle" as const;

function boundChord(): string | null {
  // `?? null`: the store record could in principle lack the key (its index type
  // omits undefined); normalize so the `=== null` guards below actually catch it
  // instead of feeding undefined into parseChordString.
  return useKeybindingStore.getState().bindings[DICTATION_ACTION_ID] ?? null;
}

// Strict modifier match (the app's shared matching treats `mod` as Meta OR Ctrl,
// which would fire on both ⌘ and Ctrl). Each chord modifier maps to an exact
// physical key:
//   - `ctrl`: the Control key SPECIFICALLY (⌃), never Command - the dictation
//     default, so it dodges the Command-based conflicts.
//   - `mod`:  the platform-primary modifier - ⌘ on macOS, Ctrl elsewhere.
function chordMatchesStrict(chord: string, event: KeyboardEvent): boolean {
  const parts = parseChordString(chord);
  if (parts === null) return false;
  if (normalizeCode(event.code) !== parts.key) return false;
  if (event.shiftKey !== parts.shift) return false;
  if (event.altKey !== parts.alt) return false;
  if (parts.ctrl) return event.ctrlKey && !event.metaKey;
  if (parts.mod) {
    return isMac()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  }
  return !event.metaKey && !event.ctrlKey;
}

interface DictationHotkeyTarget {
  readonly state: VoiceDictationState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
}

type DictationTargetGetter = () => DictationHotkeyTarget;

/**
 * A bot surface's side of the chord: a press toggles a call. `thread` is
 * whether this target is a thread's, which wins over its channel's when both
 * are showing.
 */
interface CallHotkeyTarget {
  readonly thread: boolean;
  readonly toggle: () => void;
}

type HotkeyOwner =
  | { readonly kind: "dictation"; readonly get: DictationTargetGetter }
  | { readonly kind: "call"; readonly target: () => CallHotkeyTarget };

// Module-level singleton: the window listeners are installed once, and only the
// most-recently-enabled owner (top of stack) handles a keypress. This prevents
// two mounted composers (e.g. landing + an active chat tile) from each binding
// the window and firing two dictations on one shortcut. On unmount an owner pops
// and the previous owner resumes.
const targetStack: HotkeyOwner[] = [];
let listenersInstalled = false;
// A press is in progress. A hold (push-to-talk) is detected purely by OS
// key-repeat events the held key emits - `sawRepeat`. (A timer fallback was
// dropped: it misread a slow-but-deliberate tap as a hold. A genuine
// push-to-talk holds long enough to auto-repeat; a quick tap doesn't.)
// `wasActiveAtPress` records whether a session was already running when the
// press started (so the press toggles it off). `pressOwner` is the composer
// that owned the keydown, so the release acts on THAT composer even if the
// active one changed mid-press.
let keyHeld = false;
let sawRepeat = false;
let wasActiveAtPress = false;
let pressOwner: DictationTargetGetter | null = null;

function resetPressState(): void {
  keyHeld = false;
  sawRepeat = false;
  wasActiveAtPress = false;
  pressOwner = null;
}

function topOwner(): HotkeyOwner | null {
  return targetStack.length === 0 ? null : targetStack[targetStack.length - 1];
}

/** The call target a press on a bot surface toggles: its thread's over its channel's. */
function callTargetOf(): CallHotkeyTarget | null {
  let found: CallHotkeyTarget | null = null;
  for (const owner of targetStack) {
    if (owner.kind !== "call") continue;
    const target = owner.target();
    if (found === null || target.thread || !found.thread) found = target;
  }
  return found;
}

function isActiveState(state: VoiceDictationState): boolean {
  return state !== "idle" && state !== "error";
}

// Resolve a key release (or a blur that stands in for one). Shared by keyup and
// the blur handler so a hold interrupted by focus loss still finalizes instead
// of wedging `keyHeld`.
function resolveRelease(): void {
  if (!keyHeld) return;
  const held = sawRepeat;
  const wasActive = wasActiveAtPress;
  const owner = pressOwner;
  resetPressState();
  // Act on the composer that OWNED the press, not whichever is active now.
  const target = owner === null ? null : owner();
  if (target === null) return;
  if (wasActive) {
    target.stop(); // tap while a session was running → toggle off
    return;
  }
  // Started this session on the press: a hold is push-to-talk (stop on release);
  // a quick tap leaves it recording (toggle on, stopped by the next tap).
  if (held) target.stop();
}

function onKeyDown(event: KeyboardEvent): void {
  const owner = topOwner();
  if (owner === null) return;
  if (owner.kind === "call") {
    onCallKeyDown(event);
    return;
  }
  const getter = owner.get;
  const target = getter();
  if (event.code === "Escape" && isActiveState(target.state)) {
    // Consume Escape so cancelling dictation doesn't also close a dialog/popover.
    event.preventDefault();
    event.stopPropagation();
    target.cancel();
    resetPressState();
    return;
  }
  const chord = boundChord();
  if (chord === null || !chordMatchesStrict(chord, event)) return;
  event.preventDefault();
  // Ignore presses while a flush is settling - don't double-stop or start anew.
  if (target.state === "transcribing") return;
  if (keyHeld) {
    // Auto-repeat while the chord is held → this press is a hold (push-to-talk).
    sawRepeat = true;
    return;
  }
  keyHeld = true;
  // `event.repeat` true on the first matching keydown also means a hold.
  sawRepeat = event.repeat;
  wasActiveAtPress = isActiveState(target.state);
  pressOwner = getter;
  if (!wasActiveAtPress) target.start();
}

// A tap toggles the call: there is no hold, and a held chord's repeats do
// nothing, so it never starts and ends a call once per repeat.
function onCallKeyDown(event: KeyboardEvent): void {
  const chord = boundChord();
  if (chord === null || !chordMatchesStrict(chord, event)) return;
  event.preventDefault();
  if (event.repeat) return;
  callTargetOf()?.toggle();
}

function onKeyUp(event: KeyboardEvent): void {
  if (!keyHeld) return;
  // Release is detected by the chord's primary key lifting; modifiers may lift
  // first. The primary key comes from the live binding.
  const chord = boundChord();
  const primaryKey = chord === null ? null : parseChordString(chord)?.key;
  if (primaryKey === undefined || primaryKey === null) return;
  if (normalizeCode(event.code) !== primaryKey) return;
  resolveRelease();
}

function onWindowBlur(): void {
  resolveRelease();
}

// Capture phase: the central KeybindingProvider listens on window in capture and
// `stopPropagation()`s any bound chord (and dictation is now a bound action).
// A same-target capture listener still fires after a sibling's stopPropagation,
// and this hook's effect (a composer descendant) registers before the provider's
// (effects run child→parent), so this runs first and owns the dual tap/hold
// gesture the tap-only central dispatcher can't express.
function installListeners(): void {
  if (listenersInstalled) return;
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("keyup", onKeyUp, { capture: true });
  window.addEventListener("blur", onWindowBlur);
  listenersInstalled = true;
}

function removeListeners(): void {
  if (!listenersInstalled) return;
  window.removeEventListener("keydown", onKeyDown, { capture: true });
  window.removeEventListener("keyup", onKeyUp, { capture: true });
  window.removeEventListener("blur", onWindowBlur);
  listenersInstalled = false;
  resetPressState();
}

interface UseDictationHotkeyArgs {
  /** Only the focused/active composer should bind the shortcut. */
  readonly enabled: boolean;
  readonly state: VoiceDictationState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
}

/**
 * Binds the dual tap/hold dictation shortcut (window-scoped via a shared
 * singleton, active only when `enabled`):
 *   - quick tap  → toggle recording on/off
 *   - hold       → push-to-talk; transcribe on release (or on focus loss)
 *   - Esc        → cancel an in-progress recording/transcription (discard)
 *
 * Hold vs tap is detected from OS key-repeat events, not a timer, so releasing
 * the multi-key chord at a natural pace still reads as a tap.
 */
export function useDictationHotkey(args: UseDictationHotkeyArgs): void {
  // A surface kept mounted while not shown owns no hotkey.
  const enabled = use(KeyboardOwnerContext) && args.enabled;
  // Latest-value ref so the singleton reads live state/handlers without
  // re-subscribing on every render.
  const argsRef = useRef(args);
  useEffect(() => {
    argsRef.current = args;
  });

  useEffect(() => {
    if (!enabled) return;
    const getter: DictationTargetGetter = () => argsRef.current;
    const owner: HotkeyOwner = { kind: "dictation", get: getter };
    targetStack.push(owner);
    installListeners();
    // Note: do NOT reset press state on mount - a sibling composer mounting
    // must not wipe an in-progress hold owned by another composer.
    return () => {
      const index = targetStack.indexOf(owner);
      if (index >= 0) targetStack.splice(index, 1);
      // Only clear press state if THIS composer owned the in-flight press (it's
      // unmounting/disabling), so a dangling keyup/blur can't act on it.
      if (pressOwner === getter) resetPressState();
      if (targetStack.length === 0) removeListeners();
    };
  }, [enabled]);
}

/**
 * Binds the dictation chord to a call on a bot surface (Call Tracy, P15): a
 * tap starts the call with `toggle`'s target, and ends a live one. Only while
 * `enabled` and the surface owns the keyboard; a thread's target wins over its
 * channel's. While it owns the chord, no composer dictates on it.
 */
export function useCallHotkey(args: {
  readonly enabled: boolean;
  readonly thread: boolean;
  readonly toggle: () => void;
}): void {
  const enabled = use(KeyboardOwnerContext) && args.enabled;
  const argsRef = useRef(args);
  useEffect(() => {
    argsRef.current = args;
  });
  useEffect(() => {
    if (!enabled) return;
    const owner: HotkeyOwner = {
      kind: "call",
      target: () => ({
        thread: argsRef.current.thread,
        toggle: argsRef.current.toggle,
      }),
    };
    targetStack.push(owner);
    installListeners();
    return () => {
      const index = targetStack.indexOf(owner);
      if (index >= 0) targetStack.splice(index, 1);
      if (targetStack.length === 0) removeListeners();
    };
  }, [enabled]);
}
