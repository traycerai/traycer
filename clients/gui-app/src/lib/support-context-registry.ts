import { create } from "zustand";
import type { SupportEnvironmentSection } from "@/lib/support-environment-section";

/**
 * Availability of one captured field. `known` is a fresh, currently-observed
 * value; `stale` is a prior value the write side no longer confirms live
 * (e.g. provider state read before the host went unreachable) - callers must
 * label it as such rather than silently reporting a possibly-outdated value
 * as current; `unavailable` means the field was never observed this session.
 */
export type CapturedField<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "stale"; readonly value: T }
  | { readonly status: "unavailable" };

const UNAVAILABLE: CapturedField<never> = { status: "unavailable" };

export function unavailableField<T>(): CapturedField<T> {
  return UNAVAILABLE;
}

export function knownField<T>(value: T): CapturedField<T> {
  return { status: "known", value };
}

export function staleField<T>(value: T): CapturedField<T> {
  return { status: "stale", value };
}

/**
 * Last-known session state for support-report capture. Every field mirrors
 * something a user is actively doing (route, host, epic/tab/artifact,
 * harness/model, provider) so a report opened after a crash can still say
 * what the user was doing right before it - the highest-value capture case,
 * per the redesign's critique (D5).
 */
export interface SupportContextSnapshot {
  /** Route template, e.g. `/epics/$epicId/$tabId` - never a full URL/path. */
  readonly routeTemplate: CapturedField<string>;
  /** The app-wide effective host - NOT the host a chat tab is bound to. */
  readonly hostId: CapturedField<string>;
  /**
   * The host the active chat / terminal-agent tab is bound to for life, or
   * `unavailable` outside such a tab. Differs from `hostId` whenever the tab
   * was opened on a host other than the app default.
   */
  readonly tabHostId: CapturedField<string>;
  readonly epicId: CapturedField<string>;
  readonly tabId: CapturedField<string>;
  readonly artifactId: CapturedField<string>;
  readonly chatId: CapturedField<string>;
  readonly agentId: CapturedField<string>;
  readonly harnessId: CapturedField<string>;
  readonly model: CapturedField<string>;
  /** `null` value = ambient/host login, distinct from `unavailable`. */
  readonly profileId: CapturedField<string | null>;
  readonly providerSelectionClass: CapturedField<"bundled" | "path" | "custom">;
  /** `null` value = version not yet probed, distinct from `unavailable`. */
  readonly providerVersion: CapturedField<string | null>;
}

export const EMPTY_SUPPORT_CONTEXT_SNAPSHOT: SupportContextSnapshot = {
  routeTemplate: UNAVAILABLE,
  hostId: UNAVAILABLE,
  tabHostId: UNAVAILABLE,
  epicId: UNAVAILABLE,
  tabId: UNAVAILABLE,
  artifactId: UNAVAILABLE,
  chatId: UNAVAILABLE,
  agentId: UNAVAILABLE,
  harnessId: UNAVAILABLE,
  model: UNAVAILABLE,
  profileId: UNAVAILABLE,
  providerSelectionClass: UNAVAILABLE,
  providerVersion: UNAVAILABLE,
};

interface SupportContextRegistryState {
  readonly snapshot: SupportContextSnapshot;
  readonly setSnapshot: (patch: Partial<SupportContextSnapshot>) => void;
  /**
   * The selected host's environment section, written by
   * `SupportEnvironmentBridge`. Kept beside the snapshot, not in it: the
   * snapshot is the registry's own closed key set.
   */
  readonly environment: CapturedField<SupportEnvironmentSection>;
  readonly setEnvironment: (
    environment: CapturedField<SupportEnvironmentSection>,
  ) => void;
}

/**
 * Module-level store (D5): deliberately NOT React context. A root crash
 * unmounts the authenticated runtime subtree that writes this registry, but
 * `ReportIssueDialogHost` stays mounted above the root error boundary (see
 * `traycer-app.tsx`) and must still be able to read the last-known session
 * state for the report it opens. A React context living inside the crashed
 * subtree would be torn down with it; a module-scoped Zustand store (same
 * shape as `desktop-dialog-store.ts`) lives independent of the React tree and
 * survives exactly that unmount.
 */
export const useSupportContextRegistry = create<SupportContextRegistryState>(
  (set) => ({
    snapshot: EMPTY_SUPPORT_CONTEXT_SNAPSHOT,
    setSnapshot: (patch) => {
      set((state) => ({ snapshot: { ...state.snapshot, ...patch } }));
    },
    environment: UNAVAILABLE,
    setEnvironment: (environment) => {
      set({ environment });
    },
  }),
);

/**
 * Plain (non-hook) reader for use outside React - at report-open time, and
 * after a root crash has unmounted every component that could call a hook.
 */
export function getSupportContextSnapshot(): SupportContextSnapshot {
  return useSupportContextRegistry.getState().snapshot;
}

export function setSupportContextSnapshot(
  patch: Partial<SupportContextSnapshot>,
): void {
  useSupportContextRegistry.getState().setSnapshot(patch);
}

/** The last environment section written, read at report-open like the snapshot. */
export function getSupportEnvironmentSection(): CapturedField<SupportEnvironmentSection> {
  return useSupportContextRegistry.getState().environment;
}

export function setSupportEnvironmentSection(
  environment: CapturedField<SupportEnvironmentSection>,
): void {
  useSupportContextRegistry.getState().setEnvironment(environment);
}

/** Test-only reset back to the all-`unavailable` initial state. */
export function __resetSupportContextRegistryForTests(): void {
  useSupportContextRegistry.setState({
    snapshot: EMPTY_SUPPORT_CONTEXT_SNAPSHOT,
    environment: UNAVAILABLE,
  });
}
