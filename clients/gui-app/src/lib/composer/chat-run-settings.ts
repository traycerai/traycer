import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatRunSettingsStrict } from "@traycer/protocol/persistence/epic/foundation";

import {
  DEFAULT_PERMISSION,
  isPermissionMode,
} from "@/components/home/data/landing-options";
import type {
  ModelOption,
  PermissionMode,
  HarnessModelSelection,
  ProviderId,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";

const IMAGE_INPUT_MODALITIES = new Set([
  "image",
  "images",
  "imageurl",
  "imageurls",
  "inputimage",
  "inputimages",
  "vision",
  "visual",
]);

export function buildChatRunSettings(input: {
  selection: HarnessModelSelection;
  permission: PermissionMode;
  reasoning: ReasoningLevel;
  serviceTier: ServiceTier;
}): ChatRunSettings {
  const { selection, permission, reasoning, serviceTier } = input;
  const trimmedServiceTier = serviceTier.trim();
  return {
    harnessId: selection.harnessId,
    model: selection.modelSlug,
    permissionMode: permission,
    reasoningEffort: reasoning.length === 0 ? null : reasoning,
    // Trim before sentinel collapse so a whitespace-only stored preference
    // ("   ", "\n", etc.) never reaches the host as a bogus tier id.
    serviceTier: trimmedServiceTier.length === 0 ? null : trimmedServiceTier,
    // Epic Mode was removed from the product. The protocol's persisted
    // `ChatRunSettings` still carries the field, so state the one remaining
    // mode; nothing reads it back.
    agentMode: "regular",
    profileId: selection.profileId,
    // No composer picker writes this yet - T10/T11 own the Identities surface -
    // so every settings tuple this builder produces runs with the stock
    // identity, which is what `null` means. It is stated rather than omitted
    // because the field is required on the tuple: a builder that left it out
    // would not compile, and that is the point of the required shape.
    identityId: null,
  };
}

/**
 * The composer seed for an imported chat whose own `ChatRunSettings` is null.
 *
 * An imported chat belongs to the provider it was imported FROM, and the host
 * says so in its settings tuple - except when it could not, because the source
 * provider listed no model at import time. The composer would then fall back to
 * whatever the user last ran, and answer a Codex transcript with Claude. This
 * puts the provenance back in charge of that one field.
 *
 * The model is left empty on purpose: the toolbar resolves a provider's own
 * default from its catalog for any seed that carries none, so naming one here
 * would only be a second, staler guess. `profileId` is cleared for the same
 * reason the toolbar clears it when it reroutes a provider - a remembered
 * profile belongs to the provider it was remembered for.
 *
 * Permission, reasoning, and tier are carried through untouched. So is the
 * unavailable-provider case: a source provider that is not authenticated on
 * this host is rerouted by the toolbar's own availability pass, exactly as an
 * unavailable default would be.
 */
export function importedChatSettingsSeed(
  rememberedSettings: ChatRunSettings | null,
  defaultSettings: ChatRunSettings,
  sourceProvider: ProviderId,
): ChatRunSettings {
  return {
    ...(rememberedSettings ?? defaultSettings),
    harnessId: sourceProvider,
    model: "",
    profileId: null,
  };
}

/**
 * A draft head's persisted run settings, as the composer's own tuple.
 *
 * The draft head persists the STRICT tuple (`chatRunSettingsStrictSchema`),
 * which is the live one MINUS `identityId` - so a draft does not remember which
 * agent identity its composer had selected, and reopening one runs with the
 * stock identity. That is an accepted v1 gap, not an oversight: the strict tuple
 * is the request shape of the RELEASED `epic.updateChatRunSettings@1.1`, where
 * every field is required precisely so a partial write cannot silently clobber a
 * setting the caller never looked at - and a defaulted `identityId` there would
 * do exactly that, clearing a chat's identity every time a shipped client wrote
 * its settings. Closing the gap needs a new strict-with-identity line, not a
 * widening of that one.
 *
 * So the widening happens HERE, once, where it is visible - rather than at each
 * of the two draft-apply sites, where the missing field would read as an
 * oversight rather than as a decision.
 */
export function chatRunSettingsFromDraftPortable(
  settings: ChatRunSettingsStrict | null,
): ChatRunSettings | null {
  if (settings === null) return null;
  return { ...settings, identityId: null };
}

export function selectionFromChatRunSettings(
  settings: ChatRunSettings,
): HarnessModelSelection {
  return {
    harnessId: settings.harnessId,
    modelSlug: settings.model,
    // `??` guards a pre-profile persisted blob (the field is missing, not
    // `null`, on an old serialized `ChatRunSettings`) so it resolves to
    // ambient instead of leaking `undefined` into a `string | null` field.
    profileId: settings.profileId ?? null,
  };
}

export function permissionFromChatRunSettings(
  settings: ChatRunSettings,
): PermissionMode {
  if (isPermissionMode(settings.permissionMode)) return settings.permissionMode;
  return DEFAULT_PERMISSION;
}

export function reasoningFromChatRunSettings(
  settings: ChatRunSettings,
): ReasoningLevel {
  return settings.reasoningEffort ?? "";
}

export function serviceTierFromChatRunSettings(
  settings: ChatRunSettings,
): ServiceTier {
  return settings.serviceTier ?? "";
}

export function modelSupportsImageAttachments(model: ModelOption): boolean {
  const inputModalities = model.metadata.inputModalities;
  return (
    (Array.isArray(inputModalities) &&
      inputModalities.some(isImageInputModality)) ||
    model.metadata.supportsImages === true ||
    model.metadata.supportsImageAttachments === true ||
    model.metadata.multimodal === true ||
    model.metadata.vision === true
  );
}

export function selectedModelRejectsImageAttachments(
  model: ModelOption | null,
): boolean {
  return model !== null && !modelSupportsImageAttachments(model);
}

function isImageInputModality(modality: unknown): boolean {
  if (typeof modality !== "string") return false;
  return IMAGE_INPUT_MODALITIES.has(
    modality
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );
}
