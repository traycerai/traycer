import {
  cancelPrimaryFocusIntent,
  hasPrimaryFocusIntent,
  registerPrimaryFocusEndpoint,
  requestPrimaryFocus,
} from "@/lib/focus/primary-focus-coordinator";

type TerminalFocusCallback = () => void;
type TerminalContainsActiveElement = (activeElement: Element | null) => boolean;
type TerminalFocusEligibility = () => boolean;

interface TerminalFocusRegistration {
  readonly containsActiveElement: TerminalContainsActiveElement;
  readonly unregister: () => void;
}

const registrations = new Map<string, TerminalFocusRegistration>();

/** Registers the mounted xterm endpoint for a semantic terminal instance. */
export function registerTerminalFocus(
  instanceId: string,
  focus: TerminalFocusCallback,
  containsActiveElement: TerminalContainsActiveElement,
  isEligible: TerminalFocusEligibility,
): () => void {
  registrations.get(instanceId)?.unregister();
  const unregister = registerPrimaryFocusEndpoint(
    { kind: "terminal", instanceId },
    {
      focus,
      containsActiveElement,
      isEligible,
    },
  );
  const registration: TerminalFocusRegistration = {
    containsActiveElement,
    unregister,
  };
  registrations.set(instanceId, registration);
  return () => {
    if (registrations.get(instanceId) !== registration) return;
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

export function terminalFocusOwnsInstance(instanceId: string): boolean {
  if (
    hasPrimaryFocusIntent(
      (target) =>
        target.kind === "terminal" && target.instanceId === instanceId,
    )
  ) {
    return true;
  }
  const registration = registrations.get(instanceId);
  return (
    registration !== undefined &&
    registration.containsActiveElement(
      document.activeElement instanceof Element ? document.activeElement : null,
    )
  );
}

export function resetTerminalFocusRegistryForTests(): void {
  registrations.forEach(({ unregister }) => unregister());
  registrations.clear();
  clearPendingTerminalFocus(null);
}
