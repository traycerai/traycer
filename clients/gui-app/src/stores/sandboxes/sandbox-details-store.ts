import { create } from "zustand";

interface SandboxDetailsStore {
  /** The sandbox the Details drawer is open for, or `null` when closed. */
  readonly sandboxId: string | null;
}

export const useSandboxDetailsStore = create<SandboxDetailsStore>(() => ({
  sandboxId: null,
}));

/**
 * Opens the Details drawer for one sandbox (`SandboxDetailsDrawerHost`,
 * mounted once at the app root). Callable outside React: a Sandboxes row, the
 * hover card and a notification all open it the same way. Reading Details
 * never wakes or spends.
 */
export function openSandboxDetails(sandboxId: string): void {
  useSandboxDetailsStore.setState({ sandboxId });
}

export function closeSandboxDetails(): void {
  useSandboxDetailsStore.setState({ sandboxId: null });
}
