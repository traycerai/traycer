import {
  readableModelMatch,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";
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

/** Every field is already display-ready: labels are resolved against the live GUI harness catalog with a
 * raw-slug fallback, so the view never needs the catalog again. */
export interface OwnerSettingsHeaderView {
  readonly harnessId: ProviderId;
  readonly harnessName: string;
  readonly modelLabel: string | null;
  readonly reasoningLabel: string | null;
  readonly fastMode: boolean;
  /** Same `AccentDot` projection the composer's model-picker trigger uses, so the same profile reads as the same
   * mark on both surfaces. */
  readonly profileAccentDot: ProfileAccentDotInput | null;
  /** The raw mode, not a pre-resolved label: the header needs both the label and the mode's icon, and
   * `findPermissionOption` is the single source of truth for that pair (`landing-options`). */
  readonly permissionMode: PermissionMode | null;
}

export interface OwnerSettingsHeaderInput {
  readonly ownerKind: WorktreeBindingOwnerKind;
  /** GUI chat's persisted run settings (`null` for terminal agents and for
   *  legacy chats that predate the settings field). */
  readonly chatSettings: ChatRunSettings | null;
  readonly tuiHarnessId: ProviderId | null;
  readonly tuiModel: string | null;
  readonly tuiReasoningEffort: string | null;
  readonly tuiProfileId: string | null;
  /** Empty while the catalog is cold or the host is unreachable, which drives the raw-slug fallback. */
  readonly harnesses: ReadonlyArray<GuiHarnessCatalogEntry>;
  /** The accent dot is gated on this list crossing the 2-profile mark, and that gate only means "this provider
   * has more than one account" if the list is scoped to the provider in question. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
}

/** Resolves the hover-card settings header from already-local data: the chat's persisted `settings` (or the
 * terminal agent's flat fields) plus the dynamic harness catalog. */
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
    reasoningLabel: resolveReasoningLabel(input.tuiReasoningEffort, model),
    fastMode: false,
    // Terminal `null` is the unbadged ambient identity. A tombstoned managed
    // id also resolves to null below rather than leaking an opaque id.
    profileAccentDot:
      input.tuiProfileId === null
        ? null
        : resolveProfileAccentDot(input.tuiProfileId, input.profiles),
    permissionMode: null,
  };
}

function findHarnessEntry(
  harnesses: ReadonlyArray<GuiHarnessCatalogEntry>,
  harnessId: ProviderId,
): GuiHarnessCatalogEntry | null {
  return harnesses.find((harness) => harness.id === harnessId) ?? null;
}

// Read-only: the row is only read for its label and reasoning options, so an
// ambiguous alias match is fine here (see `readableModelMatch`).
function findModel(
  entry: GuiHarnessCatalogEntry | null,
  slug: string,
): ModelOption | null {
  if (entry === null) return null;
  return readableModelMatch(resolveModelBySlug(entry.models, slug));
}

// `findReasoningLabel` falls back to the raw level when the model (or its options) is missing, so an
// unresolved effort still reads as its persisted slug rather than disappearing.
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

// `null` here is ambient, not "no profile" - it matches the ambient row via `profileCommitId`, so a chat
// running on the Terminal account gets its own mark rather than silently reading as an unconfigured one.
export function resolveProfileAccentDot(
  profileId: string | null,
  profiles: ReadonlyArray<ProviderProfile>,
): ProfileAccentDotInput | null {
  if (profiles.length < 2) return null;
  const profile =
    profiles.find((candidate) => profileCommitId(candidate) === profileId) ??
    null;
  return profile === null ? null : profileAccentDotInput(profile);
}
