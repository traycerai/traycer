import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import {
  DEFAULT_PERMISSION,
  isPermissionMode,
} from "@/components/home/data/landing-options";
import type {
  ModelOption,
  PermissionMode,
  AgentMode,
  HarnessModelSelection,
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
  agentMode: AgentMode;
}): ChatRunSettings {
  const { selection, permission, reasoning, serviceTier, agentMode } = input;
  const trimmedServiceTier = serviceTier.trim();
  return {
    harnessId: selection.harnessId,
    model: selection.modelSlug,
    permissionMode: permission,
    reasoningEffort: reasoning.length === 0 ? null : reasoning,
    // Trim before sentinel collapse so a whitespace-only stored preference
    // ("   ", "\n", etc.) never reaches the host as a bogus tier id.
    serviceTier: trimmedServiceTier.length === 0 ? null : trimmedServiceTier,
    agentMode: agentMode,
    profileId: selection.profileId,
  };
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

export function agentModeFromChatRunSettings(
  settings: ChatRunSettings,
): AgentMode {
  return settings.agentMode;
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
