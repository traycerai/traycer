import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import {
  findPermissionLabel,
  findReasoningLabel,
  isFastModeEnabled,
  modelDisplayLabel,
  type ModelOption,
  type ProviderId,
} from "@/components/home/data/landing-options";
import {
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";

/**
 * The resolved run-settings header shown atop the chat/terminal-agent hover
 * card. Every field is already display-ready: labels are resolved against the
 * live GUI harness catalog with a raw-slug fallback, so the view never needs
 * the catalog again. Terminal agents carry only `harness` + `model` (they have
 * no permission / reasoning / fast-mode / profile settings), so those fields
 * are always `null` for them.
 */
export interface OwnerSettingsHeaderView {
  readonly harnessId: ProviderId;
  readonly harnessName: string;
  readonly modelLabel: string | null;
  readonly reasoningLabel: string | null;
  readonly fastMode: boolean;
  readonly profileLabel: string | null;
  readonly permissionLabel: string | null;
}

export interface OwnerSettingsHeaderInput {
  readonly ownerKind: WorktreeBindingOwnerKind;
  /** GUI chat's persisted run settings (`null` for terminal agents and for
   *  legacy chats that predate the settings field). */
  readonly chatSettings: ChatRunSettings | null;
  /** Terminal agent's harness id (`null` for GUI chats). */
  readonly tuiHarnessId: ProviderId | null;
  /** Terminal agent's selected model slug, if any (`null` for GUI chats). */
  readonly tuiModel: string | null;
  /** Live GUI harness catalog entries - the dynamic label source. Empty while
   *  the catalog is cold or the host is unreachable, which drives the
   *  raw-slug fallback. */
  readonly harnesses: ReadonlyArray<GuiHarnessCatalogEntry>;
  /** The chat host's provider profiles, flattened across providers. Used only
   *  to resolve the chat's `profileId` to a label; when it cannot be resolved
   *  the profile row is omitted rather than showing the opaque id. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

/**
 * Resolves the hover-card settings header from already-local data: the chat's
 * persisted `settings` (or the terminal agent's flat fields) plus the dynamic
 * harness catalog. Returns `null` when there is nothing to show (a chat with no
 * persisted settings, or a terminal agent with no harness).
 */
export function deriveOwnerSettingsHeader(
  input: OwnerSettingsHeaderInput,
): OwnerSettingsHeaderView | null {
  if (input.ownerKind === "terminal-agent") {
    return deriveTerminalAgentHeader(input);
  }
  return deriveChatHeader(input);
}

function deriveChatHeader(
  input: OwnerSettingsHeaderInput,
): OwnerSettingsHeaderView | null {
  const settings = input.chatSettings;
  if (settings === null) return null;
  const harnessId = settings.harnessId;
  const entry = findHarnessEntry(input.harnesses, harnessId);
  const model = findModel(entry, settings.model);
  return {
    harnessId,
    harnessName: entry?.label ?? harnessId,
    modelLabel: model === null ? settings.model : modelDisplayLabel(model),
    reasoningLabel: resolveReasoningLabel(settings.reasoningEffort, model),
    fastMode: isFastModeEnabled(settings.serviceTier),
    profileLabel: resolveProfileLabel(settings.profileId, input.profiles),
    permissionLabel: findPermissionLabel(settings.permissionMode),
  };
}

function deriveTerminalAgentHeader(
  input: OwnerSettingsHeaderInput,
): OwnerSettingsHeaderView | null {
  const harnessId = input.tuiHarnessId;
  if (harnessId === null) return null;
  const entry = findHarnessEntry(input.harnesses, harnessId);
  const model =
    input.tuiModel === null ? null : findModel(entry, input.tuiModel);
  return {
    harnessId,
    harnessName: entry?.label ?? harnessId,
    modelLabel: model === null ? input.tuiModel : modelDisplayLabel(model),
    reasoningLabel: null,
    fastMode: false,
    profileLabel: null,
    permissionLabel: null,
  };
}

function findHarnessEntry(
  harnesses: ReadonlyArray<GuiHarnessCatalogEntry>,
  harnessId: ProviderId,
): GuiHarnessCatalogEntry | null {
  return harnesses.find((harness) => harness.id === harnessId) ?? null;
}

function findModel(
  entry: GuiHarnessCatalogEntry | null,
  slug: string,
): ModelOption | null {
  if (entry === null) return null;
  return entry.models.find((model) => model.slug === slug) ?? null;
}

// `findReasoningLabel` falls back to the raw level when the model (or its
// options) is missing, so an unresolved effort still reads as its persisted
// slug rather than disappearing. An empty/absent effort omits the row.
function resolveReasoningLabel(
  reasoningEffort: string | null,
  model: ModelOption | null,
): string | null {
  if (reasoningEffort === null || reasoningEffort.trim().length === 0) {
    return null;
  }
  return findReasoningLabel(
    reasoningEffort,
    model?.supportedReasoningEfforts ?? [],
  );
}

// Ambient (`null`) omits the row, and so does an id we cannot resolve to a
// human name (profiles not cached, host unreachable, or a removed profile).
// Unlike the harness/model slugs - which are themselves readable ("claude",
// "gpt-5.5-codex") - a raw `profileId` is an opaque host-generated string, so
// showing it under a "Profile" label would be noise rather than a degraded
// answer.
function resolveProfileLabel(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile>,
): string | null {
  if (profileId === null) return null;
  const profile =
    profiles.find((candidate) => profileCommitId(candidate) === profileId) ??
    null;
  return profile === null ? null : profileDisplayLabel(profile);
}
