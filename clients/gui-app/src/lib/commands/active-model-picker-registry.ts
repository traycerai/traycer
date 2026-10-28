/**
 * Stack registry for the active composer's model-picker toggle. Each enabled
 * composer picker (surface-active, not disabled, `registerActivation`) pushes a
 * controller while mounted and pops on unmount / deactivation; the TOP entry is
 * the active target. The `composer.model-picker.toggle` keybinding and the
 * palette's "Change model…" command call `toggleActiveModelPicker`; the palette
 * reads `getActiveModelPicker` for the current-selection subtitle.
 *
 * A stack (not a single slot like `composer-controls-registry`) so an overlay
 * picker layering on top - e.g. the new-chat modal over a chat composer - pops
 * cleanly and hands the target back to the composer beneath, instead of leaving
 * the shortcut dead after the overlay closes. See `useRegisterActiveModelPicker`
 * for the React entry point.
 */
import type { GuiHarnessId } from "@traycer/protocol/host/index";

export interface ActiveModelPickerController {
  /** Open the picker if closed, close it if open. */
  readonly toggle: () => void;
  /**
   * Open on a harness's models without changing the composer's selection.
   * `offeredAgents` is a sandbox refusal's remedy: the rail lists only those
   * agents, as the cloud catalogue names them, whether or not this picker's
   * host has them on. `null` lists the host's own rail.
   */
  readonly openForHarness?: (
    harnessId: GuiHarnessId,
    offeredAgents: ReadonlyArray<string> | null,
  ) => void;
  readonly getSurfaceKey?: () => string | null;
  /** Short current-selection summary for palette copy, or null when unknown. */
  readonly getSelectionSummary: () => string | null;
}

const stack: ActiveModelPickerController[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function top(): ActiveModelPickerController | null {
  return stack.length === 0 ? null : stack[stack.length - 1];
}

export function registerActiveModelPicker(
  controller: ActiveModelPickerController,
): () => void {
  stack.push(controller);
  notify();
  return () => {
    const index = stack.indexOf(controller);
    if (index === -1) return;
    stack.splice(index, 1);
    notify();
  };
}

export function getActiveModelPicker(): ActiveModelPickerController | null {
  return top();
}

/** The top picker's current selection summary, read fresh on every call. */
export function getActiveModelPickerSummary(): string | null {
  return top()?.getSelectionSummary() ?? null;
}

/** Tell subscribers the top picker's summary may have moved. */
export function notifyActiveModelPickerChanged(): void {
  notify();
}

export function subscribeActiveModelPicker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Toggle the active composer's picker. Returns false when none is registered. */
export function toggleActiveModelPicker(): boolean {
  const controller = top();
  if (controller === null) return false;
  controller.toggle();
  return true;
}

/** Browse a harness in the active composer's picker, preserving its current pick. */
export function openActiveModelPickerForHarness(
  harnessId: GuiHarnessId,
  surfaceKey: string | null,
  offeredAgents: ReadonlyArray<string> | null,
): boolean {
  const controller =
    surfaceKey === null
      ? top()
      : stack.findLast((entry) => entry.getSurfaceKey?.() === surfaceKey);
  const open = controller?.openForHarness;
  if (open === undefined) return false;
  open(harnessId, offeredAgents);
  return true;
}

/**
 * Test-only: wipe the registry so tests don't leak state between each other.
 * Call from `beforeEach` / `afterEach`.
 */
export function resetActiveModelPickerForTests(): void {
  stack.length = 0;
  // Wipe subscribers too, so a test that subscribed without disposing can't
  // keep firing into the next test. Clearing the set makes `notify()` a no-op,
  // so there is nothing left to notify.
  listeners.clear();
}
