import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { appLogger } from "@/lib/logger";

// Keep values unencoded until the flush; debouncing a StateStorage.setItem
// would still let Zustand's createJSONStorage stringify on every mutation.
const pendingWrites = new Map<string, () => void>();
let timer: Parameters<typeof clearTimeout>[0] | null = null;
let maxWaitTimer: Parameters<typeof clearTimeout>[0] | null = null;

function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

function clearTimers(): void {
  clearTimer();
  if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
  maxWaitTimer = null;
}

function flushPendingWrites(): void {
  clearTimers();
  for (const key of [...pendingWrites.keys()]) flushDeferredJsonWrite(key);
}

export function deferJsonWrite(key: string, write: () => void): void {
  pendingWrites.set(key, write);
  clearTimer();
  timer = setTimeout(flushPendingWrites, 100);
  if (maxWaitTimer === null) {
    maxWaitTimer = setTimeout(flushPendingWrites, 1000);
  }
}

// Ownership transfers must save the destination before acknowledging or
// retiring the source. A failure leaves the latest write available to retry.
export function persistNowOrThrow(key: string): void {
  const write = pendingWrites.get(key);
  write?.();
  if (pendingWrites.get(key) === write) cancelDeferredJsonWrite(key);
}

export function flushDeferredJsonWrite(key: string): void {
  try {
    persistNowOrThrow(key);
  } catch {
    appLogger.warn("[persist] deferred local write failed", { key });
  }
}

export function hasDeferredJsonWrite(key: string): boolean {
  return pendingWrites.has(key);
}

export function cancelDeferredJsonWrite(key: string): void {
  pendingWrites.delete(key);
  if (pendingWrites.size === 0) clearTimers();
}

export function cancelDeferredJsonWrites(): void {
  pendingWrites.clear();
  clearTimers();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingWrites);
  window.addEventListener("beforeunload", flushPendingWrites);
  subscribeDocumentVisibility(() => {
    if (!isDocumentVisible()) flushPendingWrites();
  });
}
