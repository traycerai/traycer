import { createContext, useContext } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type {
  EnvironmentNotice,
  EnvironmentReviewEntry,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import {
  pendingUploadKeys,
  type PersonalHostState,
  type PersonalPageStatusLine,
} from "@/components/settings/personal/personal-page-status";
import type { HostRpcRegistry } from "@/lib/host";

export interface PersonalPageContextValue {
  readonly state: PersonalHostState;
  readonly line: PersonalPageStatusLine | null;
  readonly hostName: string;
  /** This host's machine facts: values that apply on it only. */
  readonly localOverrides: readonly LocalOverride[];
  /** The window's host and the client that reaches it. */
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** This page's convergence notices and "needs you" rows. */
  readonly notices: readonly EnvironmentNotice[];
  readonly review: readonly EnvironmentReviewEntry[];
}

export const NO_OVERRIDES: readonly LocalOverride[] = [];
export const NO_NOTICES: readonly EnvironmentNotice[] = [];
export const NO_REVIEW: readonly EnvironmentReviewEntry[] = [];

export const PersonalPageContext =
  createContext<PersonalPageContextValue | null>(null);

/**
 * The window host's state as the Personal page around this component read
 * it, or `null` outside a Personal page. Rows read it for their own marks
 * ("pending").
 */
export function usePersonalHostState(): PersonalHostState | null {
  return useContext(PersonalPageContext)?.state ?? null;
}

/** The window host's name, or `null` outside a Personal page. */
export function usePersonalHostName(): string | null {
  return useContext(PersonalPageContext)?.hostName ?? null;
}

/**
 * What a row of `kind` says beside its name, keyed by the row's key: "Pending"
 * while an edit made offline waits for its receipt, "Overridden on <host>"
 * where this host keeps a value of its own. Empty outside a Personal page.
 */
export function usePersonalRowNotes(
  kind: "variable",
): ReadonlyMap<string, string> {
  const value = useContext(PersonalPageContext);
  if (value === null) return EMPTY_NOTES;
  const notes = new Map<string, string>();
  for (const override of value.localOverrides) {
    if (override.target.kind === kind) {
      notes.set(override.target.key, `Overridden on ${value.hostName}`);
    }
  }
  // Pending wins: it is the newer fact about the row.
  for (const key of pendingUploadKeys(value.state, kind)) {
    notes.set(key, "Pending");
  }
  return notes.size === 0 ? EMPTY_NOTES : notes;
}

const EMPTY_NOTES: ReadonlyMap<string, string> = new Map();

/**
 * What a Personal MCP server or skill says where its settings cannot be
 * changed on the host: the host forwards only Remove and an MCP server's tool
 * switches for an entry that is one of the person's settings, and refuses the
 * rest with this same sentence.
 */
export const PERSONAL_ENTRY_LOCKED_TEXT = "Change this in the dashboard.";

/**
 * What Remove on a Personal MCP server or skill asks: the host forwards it as
 * the item's delete, so it leaves every provider on every host (finding 31).
 */
export function personalRemoveText(name: string): string {
  return `Remove “${name}” from every provider on every host?`;
}

/**
 * Whether the global MCP server or skill `name` is one of the person's
 * settings on the window's host: the host applied one of their items as it
 * (`environment.status` `appliedAs`). `false` outside a Personal page, for a
 * project's entries, and for a `null` name.
 */
export function usePersonalEntryApplied(
  entryKind: "mcp" | "skills",
  name: string | null,
  scope: ProviderNativeScope,
): boolean {
  const state = useContext(PersonalPageContext)?.state ?? null;
  if (name === null || scope !== "global" || state?.kind !== "ready") {
    return false;
  }
  return state.status.items.some(
    (item) =>
      item.appliedAs !== null &&
      item.appliedAs.entryKind === entryKind &&
      item.appliedAs.name === name,
  );
}
