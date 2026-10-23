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
  /**
   * The reveal is held until the sandbox list and the teams settle, which
   * name the configuration the row belongs to; the page shows no reveal
   * meanwhile.
   */
  readonly revealConfigurationPending: boolean;
}

export const useSandboxesPageStore = create<SandboxesPageStore>(() => ({
  configurationId: { kind: "personal" },
  revealSandboxId: null,
  revealConfigurationPending: false,
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
    revealConfigurationPending: false,
  });
}

/** One row to reveal once its configuration is known. */
export function holdSandboxReveal(sandboxId: string): void {
  useSandboxesPageStore.setState({
    revealSandboxId: sandboxId,
    revealConfigurationPending: true,
  });
}

export function clearSandboxReveal(): void {
  useSandboxesPageStore.setState({
    revealSandboxId: null,
    revealConfigurationPending: false,
  });
}
