import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import {
  findReasoningLabel,
  isFastModeEnabled,
  modelDisplayLabel,
  type ModelOption,
  type PermissionMode,
  type ProviderId,
} from "@/components/home/data/landing-options";
import {
  profileAccentDotInput,
  profileCommitId,
  type ProfileAccentDotInput,
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
  /** Corner badge for the harness mark, NOT a text segment: the profile name
   *  used to ride at the end of the line, where a long label ("Anthropic work
   *  account") wrapped the row onto a second line and pushed the permission
   *  mode - the one value here with a safety consequence - out of first sight.
   *  Same `AccentDot` projection the composer's model-picker trigger uses, so
   *  the same profile reads as the same mark on both surfaces. */
  readonly profileAccentDot: ProfileAccentDotInput | null;
  /** The raw mode, not a pre-resolved label: the header needs BOTH the label
   *  and the mode's icon, and `findPermissionOption` is the single source of
   *  truth for that pair (`landing-options`). Resolving only the label here is
   *  what let this surface drift into hardcoding one padlock for all three
   *  modes. */
  readonly permissionMode: PermissionMode | null;
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
  /** The chat harness's OWN profiles - not every provider's, flattened. The
   *  accent dot is gated on this list crossing the 2-profile mark, and that
   *  gate only means "this provider has more than one account" if the list is
   *  scoped to the provider in question. */
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
    profileAccentDot: resolveProfileAccentDot(
      settings.profileId,
      input.profiles,
    ),
    permissionMode: settings.permissionMode,
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
    profileAccentDot: null,
    permissionMode: null,
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

// Deliberately the same three lines as the model picker's own badge resolution
// (`deriveHarnessModelPickerPresentation`), including the shape of what it
// declines to show:
//
//   - Fewer than 2 profiles is the progressive-disclosure gate. A dot that is
//     always present signals nothing; it earns its pixels only once the
//     provider actually has more than one account to be confused between.
//   - `null` here is AMBIENT, not "no profile" - it matches the ambient row via
//     `profileCommitId`, so a chat running on the Terminal account gets its own
//     mark rather than silently reading as an unconfigured one.
//   - An id matching nothing (cold provider cache, host unreachable, deleted
//     profile) omits the badge rather than guessing a color from an opaque id.
function resolveProfileAccentDot(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile>,
): ProfileAccentDotInput | null {
  if (profiles.length < 2) return null;
  const profile =
    profiles.find((candidate) => profileCommitId(candidate) === profileId) ??
    null;
  return profile === null ? null : profileAccentDotInput(profile);
}
