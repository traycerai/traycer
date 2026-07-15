import { useSyncExternalStore } from "react";

let shiftHeld = false;
const listeners = new Set<() => void>();

function setShiftKeyHeld(next: boolean): void {
  if (next === shiftHeld) return;
  shiftHeld = next;
  for (const listener of listeners) listener();
}

function handleModifierChange(event: globalThis.KeyboardEvent): void {
  setShiftKeyHeld(event.shiftKey);
}

function handleWindowBlur(): void {
  setShiftKeyHeld(false);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("keydown", handleModifierChange);
    window.addEventListener("keyup", handleModifierChange);
    window.addEventListener("blur", handleWindowBlur);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("keydown", handleModifierChange);
    window.removeEventListener("keyup", handleModifierChange);
    window.removeEventListener("blur", handleWindowBlur);
    shiftHeld = false;
  };
}

function getSnapshot(): boolean {
  return shiftHeld;
}

export function reportShiftKeyHeld(held: boolean): void {
  setShiftKeyHeld(held);
}

export function useShiftKeyHeld(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
