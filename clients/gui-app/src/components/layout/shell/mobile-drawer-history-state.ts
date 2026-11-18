import { createContext, use, useSyncExternalStore } from "react";

/** History remains eligible after either first content paint or drawer use. */
export class FirstTaskPaintGate {
  private painted = false;
  private drawerRequested = false;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): boolean => this.painted || this.drawerRequested;

  markPainted(): void {
    if (this.painted) return;
    this.painted = true;
    for (const listener of this.listeners) listener();
  }

  markDrawerRequested(): void {
    if (this.drawerRequested) return;
    this.drawerRequested = true;
    for (const listener of this.listeners) listener();
  }
}

export const GateContext = createContext<FirstTaskPaintGate | null>(null);
const noopSubscribe = (): (() => void) => () => undefined;
const notPainted = (): boolean => false;

export function useMobileDrawerTaskPainted(): boolean {
  const gate = use(GateContext);
  return useSyncExternalStore(
    gate?.subscribe ?? noopSubscribe,
    gate?.snapshot ?? notPainted,
    notPainted,
  );
}

export function useMobileDrawerTaskPaintGate(): FirstTaskPaintGate | null {
  return use(GateContext);
}
