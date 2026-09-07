import {
  guiHarnessIdSchema,
  modelsForHarness,
  readableModelMatch,
  resolveModelBySlug,
  tuiHarnessIdSchema,
  type GuiAgentModelOption,
  type GuiHarnessId,
  type GuiHarnessOption,
  type AgentReasoningEffortOption,
  type AgentServiceTierOption,
} from "@traycer/protocol/host/index";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import {
  FileCheck2,
  ShieldCheck,
  UnlockKeyhole,
  type LucideIcon,
} from "lucide-react";

export type ProviderId = GuiHarnessId;
export type ModelOption = GuiAgentModelOption;
export type HarnessOption = GuiHarnessOption;

// Landing composer surface: a free-text chat prompt vs.
export type ComposerMode = "chat" | "terminal";

const COMPOSER_MODES: ReadonlyArray<ComposerMode> = ["chat", "terminal"];

export const DEFAULT_COMPOSER_MODE: ComposerMode = "chat";

const NEXT_COMPOSER_MODE_BY_ID: Readonly<Record<ComposerMode, ComposerMode>> = {
  chat: "terminal",
  terminal: "chat",
};

export function isComposerMode(value: string): value is ComposerMode {
  return COMPOSER_MODES.some((mode) => mode === value);
}

export function nextComposerMode(mode: ComposerMode): ComposerMode {
  return NEXT_COMPOSER_MODE_BY_ID[mode];
}

// Gate for the terminal-launch flow: a harness picked in the (shared) model picker that isn't TUI-capable
// can't start a terminal agent.
export function isTuiHarnessId(value: string): value is TuiHarnessId {
  return tuiHarnessIdSchema.safeParse(value).success;
}

export type PermissionMode = "supervised" | "auto_accept_edits" | "full_access";

export interface PermissionOption {
  id: PermissionMode;
  label: string;
  description: string;
  icon: LucideIcon;
}

const SUPERVISED_PERMISSION_OPTION: PermissionOption = {
  id: "supervised",
  label: "Supervised",
  description: "Ask before commands and file changes.",
  icon: ShieldCheck,
};
const AUTO_ACCEPT_EDITS_PERMISSION_OPTION: PermissionOption = {
  id: "auto_accept_edits",
  label: "Auto-accept edits",
  description: "Auto-approve edits, ask before other actions.",
  icon: FileCheck2,
};
const FULL_ACCESS_PERMISSION_OPTION: PermissionOption = {
  id: "full_access",
  label: "Full access",
  description: "Allow commands and edits without prompts.",
  icon: UnlockKeyhole,
};

export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  SUPERVISED_PERMISSION_OPTION,
  AUTO_ACCEPT_EDITS_PERMISSION_OPTION,
  FULL_ACCESS_PERMISSION_OPTION,
];

export const DEFAULT_PERMISSION: PermissionMode = "full_access";

export function findPermissionLabel(mode: PermissionMode): string {
  return findPermissionOption(mode).label;
}

export function findPermissionOption(mode: PermissionMode): PermissionOption {
  if (mode === "auto_accept_edits") {
    return AUTO_ACCEPT_EDITS_PERMISSION_OPTION;
  }
  if (mode === "full_access") return FULL_ACCESS_PERMISSION_OPTION;
  return SUPERVISED_PERMISSION_OPTION;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_OPTIONS.some((option) => option.id === value);
}

// An empty array is treated identically to `null`: the harness explicitly advertised no constraint, but we
// don't know what's actually honored, so we keep the sticky value rather than escalating.
export function normalizePermissionMode(
  value: PermissionMode,
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null,
): PermissionMode {
  if (supportedPermissionModes === null) return value;
  if (supportedPermissionModes.length === 0) return value;
  if (supportedPermissionModes.includes(value)) return value;
  return findSafestSupportedPermissionMode(supportedPermissionModes) ?? value;
}

function findSafestSupportedPermissionMode(
  supported: ReadonlyArray<PermissionMode>,
): PermissionMode | null {
  const supportedModes = new Set(supported);
  for (const option of PERMISSION_OPTIONS) {
    if (supportedModes.has(option.id)) return option.id;
  }
  return null;
}

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return value.trim().length > 0;
}

export type ReasoningLevel = string;
export type ReasoningLevelOption = AgentReasoningEffortOption;

// The toolbar store clamps it to the selected model via `normalizeServiceTierForModel` for both display and
// emit.
export type ServiceTier = string;
export type ServiceTierOption = AgentServiceTierOption;

/** Per the `ServiceTier` contract above, both `null` (never set) and `""` ("use the harness default") mean off. */
export function isFastModeEnabled(serviceTier: string | null): boolean {
  return serviceTier !== null && serviceTier.trim().length > 0;
}

export interface HarnessModelSelection {
  harnessId: ProviderId;
  modelSlug: string;
  // `null` = the ambient/host login - the only value single/no-profile providers ever carry, so their behavior
  // stays byte-identical.
  profileId: string | null;
}

export const DEFAULT_SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "",
  profileId: null,
};

export const DEFAULT_REASONING: ReasoningLevel = "high";
export const DEFAULT_SERVICE_TIER: ServiceTier = "";

function isProviderId(value: string): value is ProviderId {
  return guiHarnessIdSchema.safeParse(value).success;
}

export function normalizeProviderId(value: string): ProviderId | null {
  if (value === "claude-code") return "claude";
  return isProviderId(value) ? value : null;
}

export function findModelLabel(
  models: ReadonlyArray<ModelOption>,
  selection: HarnessModelSelection,
): string {
  const model = findSelectedModel(models, selection);
  return model === null ? "Select model" : modelDisplayLabel(model);
}

export function modelDisplayLabel(model: ModelOption): string {
  // Harness-agnostic: strip the group prefix the label may carry when the host declared a group (OpenCode
  // `Anthropic: Claude` -> `Claude`).
  const providerLabel = modelMetadataString(
    model.metadata.openCodeProviderLabel,
  );
  const providerId = modelMetadataString(model.metadata.openCodeProviderId);
  const providerPrefix = providerLabel.length > 0 ? providerLabel : providerId;
  if (providerPrefix.length === 0) return model.label;
  return stripProviderPrefix(model.label, providerPrefix);
}

// A read-only lookup: the row is used for display and for reading capability off, never to rewrite the
// persisted slug.
export function findSelectedModel(
  models: ReadonlyArray<ModelOption>,
  selection: HarnessModelSelection,
): ModelOption | null {
  if (selection.modelSlug.length === 0) return findDefaultModel(models);
  return readableModelMatch(
    resolveModelBySlug(
      modelsForHarness(models, selection.harnessId),
      selection.modelSlug,
    ),
  );
}

export function findDefaultModel(
  models: ReadonlyArray<ModelOption>,
): ModelOption | null {
  return models.at(0) ?? null;
}

export function modelMetadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripProviderPrefix(label: string, providerLabel: string): string {
  // Trim it (": ", " ", or "/" separator) since the provider is already shown as the group header.
  for (const separator of [": ", " ", "/"]) {
    const prefix = `${providerLabel}${separator}`;
    if (label.startsWith(prefix)) return label.slice(prefix.length);
  }
  return label;
}

const NO_REASONING_OPTIONS: ReadonlyArray<ReasoningLevelOption> = [];

export function findReasoningOptionsForModel(
  model: ModelOption | null,
): ReadonlyArray<ReasoningLevelOption> {
  return model?.supportedReasoningEfforts ?? NO_REASONING_OPTIONS;
}

export function normalizeReasoningForModel(
  value: ReasoningLevel,
  model: ModelOption | null,
): ReasoningLevel {
  if (model === null) return value;
  const options = findReasoningOptionsForModel(model);
  if (options.length === 0) return "";
  if (options.some((option) => option.id === value)) return value;
  const defaultReasoningEffort = model.defaultReasoningEffort;
  if (
    defaultReasoningEffort !== null &&
    options.some((option) => option.id === defaultReasoningEffort)
  ) {
    return defaultReasoningEffort;
  }
  return options[0]?.id ?? value;
}

export function findReasoningLabel(
  level: ReasoningLevel,
  options: ReadonlyArray<ReasoningLevelOption>,
): string {
  return options.find((option) => option.id === level)?.label ?? level;
}

// We deliberately do not assume `supportedServiceTiers[0]` is the upgrade: Codex's protocol ordering isn't
// contractual, and the legacy `additionalSpeedTiers` shape can prepend a literal `"default"` entry.
export function findUpgradeServiceTierForModel(
  model: ModelOption | null,
): ServiceTierOption | null {
  if (model === null) return null;
  const options = model.supportedServiceTiers;
  if (options.length === 0) return null;
  const defaultId = model.defaultServiceTier;
  if (defaultId !== null) {
    const upgrade = options.find((option) => option.id !== defaultId);
    if (upgrade !== undefined) return upgrade;
  }
  return options[0] ?? null;
}

// The raw value stays sticky in the toolbar store's `values`.
export function normalizeServiceTierForModel(
  value: ServiceTier,
  model: ModelOption | null,
): ServiceTier {
  if (model === null) return value;
  const upgrade = findUpgradeServiceTierForModel(model);
  if (upgrade === null) return "";
  return value.trim() === upgrade.id ? upgrade.id : "";
}
