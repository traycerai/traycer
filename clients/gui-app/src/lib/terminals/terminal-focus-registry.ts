import {
  cancelPrimaryFocusIntent,
  registerPrimaryFocusEndpoint,
  requestPrimaryFocus,
} from "@/lib/focus/primary-focus-coordinator";

type TerminalFocusCallback = () => void;
type TerminalContainsActiveElement = (activeElement: Element | null) => boolean;
type TerminalFocusEligibility = () => boolean;

const registrations = new Map<string, () => void>();

/** Registers the mounted xterm endpoint for a semantic terminal instance. */
export function registerTerminalFocus(
  instanceId: string,
  focus: TerminalFocusCallback,
  containsActiveElement: TerminalContainsActiveElement,
  isEligible: TerminalFocusEligibility,
): () => void {
  registrations.get(instanceId)?.();
  const unregister = registerPrimaryFocusEndpoint(
    { kind: "terminal", instanceId },
    {
      focus,
      containsActiveElement,
      isEligible,
    },
  );
  registrations.set(instanceId, unregister);
  return () => {
    if (registrations.get(instanceId) !== unregister) return;
    registrations.delete(instanceId);
    unregister();
  };
}

/** Last-wins request; fulfilment parks until the matching xterm is ready. */
export function focusTerminalInstance(instanceId: string): void {
  requestPrimaryFocus({ kind: "terminal", instanceId });
}

export function clearPendingTerminalFocus(instanceId: string | null): void {
  cancelPrimaryFocusIntent(
    (target) =>
      target.kind === "terminal" &&
      (instanceId === null || target.instanceId === instanceId),
  );
}

export function resetTerminalFocusRegistryForTests(): void {
  registrations.forEach((unregister) => unregister());
  registrations.clear();
  clearPendingTerminalFocus(null);
}
