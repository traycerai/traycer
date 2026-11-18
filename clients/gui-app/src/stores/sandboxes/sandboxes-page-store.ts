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
}

const INITIAL: SandboxesPageStore = {
  requestedConfiguration: null,
};

export const useSandboxesPageStore = create<SandboxesPageStore>(() => INITIAL);

/** Nothing requested: the account changed. */
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
