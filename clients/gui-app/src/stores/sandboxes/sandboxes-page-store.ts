import { create } from "zustand";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";

/** Which configuration's Sandboxes page shows: Personal, or one team. */
export type SandboxesPageConfigurationId = SandboxCreateBelongsTo;

interface SandboxesPageStore {
  readonly configurationId: SandboxesPageConfigurationId;
  /**
   * A row to reveal despite any filter (a notification's sandbox): the page
   * clears its filter, scrolls to the row and highlights it, then clears
   * this. `null` when nothing is waiting.
   */
  readonly revealSandboxId: string | null;
}

export const useSandboxesPageStore = create<SandboxesPageStore>(() => ({
  configurationId: { kind: "personal" },
  revealSandboxId: null,
}));

export function setSandboxesPageConfiguration(
  configurationId: SandboxesPageConfigurationId,
): void {
  useSandboxesPageStore.setState({ configurationId });
}

/** Points the page at a configuration with one row to reveal on arrival. */
export function revealSandboxOnPage(
  configurationId: SandboxesPageConfigurationId,
  sandboxId: string,
): void {
  useSandboxesPageStore.setState({
    configurationId,
    revealSandboxId: sandboxId,
  });
}

export function clearSandboxReveal(): void {
  useSandboxesPageStore.setState({ revealSandboxId: null });
}
