import { create } from "zustand";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";

/** A configuration the Sandboxes page is opened on: Personal, or one team. */
export type SandboxesPageConfigurationId = SandboxCreateBelongsTo;

interface SandboxesPageStore {
  /**
   * The configuration a caller opened the page on, until the page moves the
   * Environment group's pick to it (the pick is what the page shows). `null`
   * when nothing is waiting.
   */
  readonly requestedConfiguration: SandboxesPageConfigurationId | null;
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

const INITIAL: SandboxesPageStore = {
  requestedConfiguration: null,
  revealSandboxId: null,
  revealConfigurationPending: false,
};

export const useSandboxesPageStore = create<SandboxesPageStore>(() => INITIAL);

/** Nothing requested or to reveal: the account changed. */
export function resetSandboxesPage(): void {
  useSandboxesPageStore.setState(INITIAL);
}

/** Opens the page on a configuration: the page moves the group's pick to it. */
export function requestSandboxesPageConfiguration(
  configuration: SandboxesPageConfigurationId,
): void {
  useSandboxesPageStore.setState({ requestedConfiguration: configuration });
}

export function clearRequestedSandboxesConfiguration(): void {
  useSandboxesPageStore.setState({ requestedConfiguration: null });
}

/** Points the page at a configuration with one row to reveal on arrival. */
export function revealSandboxOnPage(
  configuration: SandboxesPageConfigurationId,
  sandboxId: string,
): void {
  useSandboxesPageStore.setState({
    requestedConfiguration: configuration,
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
