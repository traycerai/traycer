import type { TerminalCursorKeyMode } from "@/lib/terminals/terminal-key-sequences";

/**
 * Imperative input bridge for mounted xterm hosts, keyed by tile instance id.
 * Mirrors `terminal-focus-registry`: the mobile key bar lives outside the tile
 * tree, so it reaches the engine through this registry instead of threading
 * callbacks through props. Injection uses `term.input(data, true)` - the same
 * primitive as the desktop line-edit chords - so bar keys flow through the
 * ordinary `onData -> writeInput` path.
 *
 * Unlike the focus registry there is no parked-request handling: a tap while
 * the engine is still bootstrapping has no meaningful later fulfilment
 * (replaying a stale keypress would be wrong), so it simply no-ops.
 */
export interface TerminalKeyInputTarget {
  readonly input: (data: string) => void;
  readonly getCursorKeyMode: () => TerminalCursorKeyMode;
}

const targets = new Map<string, TerminalKeyInputTarget>();

export function registerTerminalKeyInput(
  instanceId: string,
  target: TerminalKeyInputTarget,
): () => void {
  targets.set(instanceId, target);
  return () => {
    if (targets.get(instanceId) === target) {
      targets.delete(instanceId);
    }
  };
}

export function getTerminalKeyInput(
  instanceId: string,
): TerminalKeyInputTarget | null {
  return targets.get(instanceId) ?? null;
}

export function resetTerminalKeyInputRegistryForTests(): void {
  targets.clear();
}
