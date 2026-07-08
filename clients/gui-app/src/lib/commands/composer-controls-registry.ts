/**
 * Imperative registry for the currently-focused composer's control
 * setters. Mirrors the `registerDynamicActionHandler` pattern in
 * `../keybindings/dispatch.ts`: a composer that matches the focused
 * kind (landing / chat-tile active) registers its setters on mount,
 * disposes on unmount or when it loses focus. The palette reads the
 * registry to dispatch model / provider / permission / reasoning
 * updates against whichever composer the user is actually editing.
 *
 * Single slot - at most one composer holds focus at a time. Last
 * registration wins; disposing the winner clears the slot even if
 * a loser is still registered. See `useRegisterFocusedComposerControls`
 * for the React entry point that enforces these semantics correctly
 * under mount / unmount / focus-change sequences.
 */
import type {
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";
import type { FocusedComposerKind } from "@/lib/commands/types";

export interface ComposerControls {
  readonly setReasoning: (level: ReasoningLevel) => void;
  readonly setServiceTier: (tier: ServiceTier) => void;
  readonly setPermission: (mode: PermissionMode) => void;
  /**
   * Memory-aware harness SWITCH: restore that harness's last model + effort/tier
   * (or its defaults). The palette "Switch provider" leaf and the picker rail
   * funnel through this instead of `setSelection`.
   */
  readonly switchHarness: (harnessId: ProviderId) => void;
  /**
   * Memory-aware model PICK: keep the slug, restore that `(harness, model)`
   * pair's effort/tier (or its defaults). The palette "Switch model" leaf and
   * the picker's model rows funnel through this instead of `setSelection`.
   */
  readonly selectModel: (harnessId: ProviderId, modelSlug: string) => void;
}

export interface FocusedComposerEntry {
  readonly kind: FocusedComposerKind;
  readonly controls: ComposerControls;
}

let registered: FocusedComposerEntry | null = null;
const listeners = new Set<() => void>();

export function registerFocusedComposerControls(
  kind: FocusedComposerKind,
  controls: ComposerControls,
): () => void {
  const entry: FocusedComposerEntry = { kind, controls };
  registered = entry;
  notify();
  return () => {
    if (registered === entry) {
      registered = null;
      notify();
    }
  };
}

export function getFocusedComposerControls(): FocusedComposerEntry | null {
  return registered;
}

export function subscribeFocusedComposerControls(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Test-only: wipe the registry so tests don't leak state between
 * each other. Call from `beforeEach` / `afterEach`.
 */
export function resetFocusedComposerControlsForTests(): void {
  registered = null;
  notify();
}
