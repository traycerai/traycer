import { createContext, useContext } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
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
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";

export interface PersonalPageContextValue {
  /** The page, and the configuration the Environment dropdown picked. */
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
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

/**
 * The window host's name, or `null` outside a Personal page and where the
 * page knows no name (a page with no host of its own carries an empty one),
 * so a caller's fallback names the host rather than a blank.
 */
export function usePersonalHostName(): string | null {
  const hostName = useContext(PersonalPageContext)?.hostName ?? "";
  return hostName.length === 0 ? null : hostName;
}

/** The window's host and the client that reaches it, or `null`s outside a Personal page. */
export function usePersonalPageHost(): {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
} {
  const value = useContext(PersonalPageContext);
  return { hostId: value?.hostId ?? null, client: value?.client ?? null };
}

/**
 * What a row says beside its name: `pending` while an edit made offline
 * waits for its receipt; `own` where this host keeps a value of its own,
 * which the row shows as "dev-box uses: error" with Use everywhere.
 */
export type PersonalRowNote =
  | { readonly kind: "pending" }
  | { readonly kind: "own"; readonly hostName: string; readonly value: string };

/**
 * Which rows' notes: Variables', or one provider's Env, whose item keys are
 * `<keyPrefix><NAME>` while its rows are keyed by NAME.
 */
export type PersonalRowNotesTarget =
  | { readonly kind: "variable" }
  | {
      readonly kind: "env_override";
      readonly providerId: ProviderId;
      readonly keyPrefix: string;
    };

/**
 * The notes of the target's rows, keyed by the row's key. Empty outside a
 * Personal page.
 */
export function usePersonalRowNotes(
  target: PersonalRowNotesTarget,
): ReadonlyMap<string, PersonalRowNote> {
  const value = useContext(PersonalPageContext);
  if (value === null) return EMPTY_NOTES;
  const hostName =
    value.hostName.length === 0 ? "this computer" : value.hostName;
  const notes = new Map<string, PersonalRowNote>();
  for (const override of value.localOverrides) {
    const own = override.target;
    if (
      own.kind === target.kind &&
      (own.kind === "variable" ||
        (target.kind === "env_override" &&
          own.providerId === target.providerId))
    ) {
      notes.set(own.key, { kind: "own", hostName, value: override.value });
    }
  }
  // Pending wins: it is the newer fact about the row.
  const prefix = target.kind === "variable" ? "" : target.keyPrefix;
  for (const key of pendingUploadKeys(value.state, target.kind)) {
    if (key.startsWith(prefix)) {
      notes.set(key.slice(prefix.length), { kind: "pending" });
    }
  }
  return notes.size === 0 ? EMPTY_NOTES : notes;
}

const EMPTY_NOTES: ReadonlyMap<string, PersonalRowNote> = new Map();

/**
 * The page's values of `kind` an earlier version held because they look like
 * a key, by item key (an override's is `<harness>:<NAME>`). Their value is
 * never shown. Empty outside a Personal page.
 */
export function usePersonalHeldValues(
  kind: "variable" | "env_override",
): ReadonlyMap<string, EnvironmentReviewEntry> {
  const review = useContext(PersonalPageContext)?.review ?? NO_REVIEW;
  const held = new Map<string, EnvironmentReviewEntry>();
  for (const entry of review) {
    if (entry.reason === "credential_like_value" && entry.kind === kind) {
      held.set(entry.key, entry);
    }
  }
  return held.size === 0 ? EMPTY_HELD : held;
}

const EMPTY_HELD: ReadonlyMap<string, EnvironmentReviewEntry> = new Map();

/**
 * What a Personal MCP server or skill says where its settings cannot be
 * changed on the host: the host forwards only Remove and an MCP server's tool
 * switches for an entry that is one of the person's settings, and refuses the
 * rest with this same sentence.
 */
export const PERSONAL_ENTRY_LOCKED_TEXT = "Change this in the dashboard.";

/**
 * What Remove on a Personal MCP server or skill asks: the host forwards it as
 * the item's delete, so it leaves every provider on every host.
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
