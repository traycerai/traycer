import {
  DEFAULT_AGENT_MODE as PROTOCOL_DEFAULT_AGENT_MODE,
  agentModeSchema,
  guiHarnessIdSchema,
  tuiHarnessIdSchema,
  type GuiAgentModelOption,
  type GuiHarnessId,
  type GuiHarnessOption,
  type AgentReasoningEffortOption,
  type AgentServiceTierOption,
  type AgentMode as ProtocolAgentMode,
} from "@traycer/protocol/host/index";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import {
  Code2,
  FileCheck2,
  Layers,
  ShieldCheck,
  UnlockKeyhole,
  type LucideIcon,
} from "lucide-react";

export type ProviderId = GuiHarnessId;
export type ModelOption = GuiAgentModelOption;
export type HarnessOption = GuiHarnessOption;

// Landing composer surface: a free-text chat prompt vs. launching a terminal
// (TUI) agent. The switcher in `LandingComposer` flips between the two; the
// chat path drives `actions.submit`, the terminal path `selectTerminalAgent`.
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

// Gate for the terminal-launch flow: a harness picked in the (shared) model
// picker that isn't TUI-capable can't start a terminal agent. Derived from the
// protocol schema (the single source of truth) rather than a re-listed literal,
// mirroring how `isAgentMode` validates against `agentModeSchema`.
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

export const DEFAULT_PERMISSION: PermissionMode = "supervised";

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

// Clamp the composer's sticky permission to a value the active harness
// actually honors.
//
// - `null` `supportedPermissionModes` means "no harness scope" (Settings
//   default-permission row, or the catalog still loading) - pass through.
// - An empty array is treated identically to `null`: the harness explicitly
//   advertised no constraint, but we don't know what's actually honored, so
//   we keep the sticky value rather than escalating. The host-side gate in
//   `HarnessRuntime.assertPermissionModeSupported` short-circuits on empty
//   too, so neither side silently elevates.
// - Otherwise: keep the current value if supported; else fall back to the
//   *most-restrictive* supported mode (per `PERMISSION_OPTIONS` order,
//   supervised → auto_accept_edits → full_access). NEVER trust
//   `supportedPermissionModes[0]` - adapters may declare modes in any order,
//   and picking the head silently elevates Cursor (`["full_access"]`) past
//   any sticky preference the user previously held.
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

// Service / speed tier (e.g. Codex `"priority"` for the Fast upgrade). The
// stored value is the raw user preference - `""` represents "use the harness
// default" (omit the field on the wire). The toolbar store clamps it to the
// selected model via `normalizeServiceTierForModel` for both display and emit,
// so a tier carried over from another model (e.g. Codex `"priority"`) never
// shows or sends as fast on a model whose only upgrade tier differs (e.g.
// Claude `"fast"`); the raw preference stays sticky for a later model that
// honors it. The codex-adapter additionally re-filters against the model's
// `supportedServiceTiers` at thread/start as defense-in-depth.
export type ServiceTier = string;
export type ServiceTierOption = AgentServiceTierOption;

export type AgentMode = ProtocolAgentMode;

export interface AgentModeOption {
  readonly id: AgentMode;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const REGULAR_AGENT_MODE_OPTION = {
  id: "regular",
  label: "Regular Mode",
  shortLabel: "Regular",
  description: "Native coding agent experience with Traycer flavour.",
  icon: Code2,
} satisfies AgentModeOption;

const EPIC_AGENT_MODE_OPTION = {
  id: "epic",
  label: "Epic Mode",
  shortLabel: "Epic",
  description: "Traycer Planning experience",
  icon: Layers,
} satisfies AgentModeOption;

export const AGENT_MODE_OPTIONS: ReadonlyArray<AgentModeOption> = [
  REGULAR_AGENT_MODE_OPTION,
  EPIC_AGENT_MODE_OPTION,
];

const AGENT_MODE_OPTIONS_BY_ID: Readonly<Record<AgentMode, AgentModeOption>> = {
  [REGULAR_AGENT_MODE_OPTION.id]: REGULAR_AGENT_MODE_OPTION,
  [EPIC_AGENT_MODE_OPTION.id]: EPIC_AGENT_MODE_OPTION,
};
const NEXT_AGENT_MODE_BY_ID: Readonly<Record<AgentMode, AgentMode>> = {
  [REGULAR_AGENT_MODE_OPTION.id]: EPIC_AGENT_MODE_OPTION.id,
  [EPIC_AGENT_MODE_OPTION.id]: REGULAR_AGENT_MODE_OPTION.id,
};

export const DEFAULT_AGENT_MODE: AgentMode = PROTOCOL_DEFAULT_AGENT_MODE;

export function isAgentMode(value: string): value is AgentMode {
  return agentModeSchema.safeParse(value).success;
}

export function findAgentModeOption(mode: AgentMode): AgentModeOption {
  return AGENT_MODE_OPTIONS_BY_ID[mode];
}

export function nextAgentMode(mode: AgentMode): AgentMode {
  return NEXT_AGENT_MODE_BY_ID[mode];
}

export interface HarnessModelSelection {
  harnessId: ProviderId;
  modelSlug: string;
}

export const DEFAULT_SELECTION: HarnessModelSelection = {
  harnessId: "codex",
  modelSlug: "",
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
  // Harness-agnostic: strip the group prefix the label may carry when the host
  // declared a group (OpenCode `Anthropic: Claude` -> `Claude`). OpenRouter
  // labels carry no such prefix, so this is a no-op for them.
  const providerLabel = modelMetadataString(
    model.metadata.openCodeProviderLabel,
  );
  const providerId = modelMetadataString(model.metadata.openCodeProviderId);
  const providerPrefix = providerLabel.length > 0 ? providerLabel : providerId;
  if (providerPrefix.length === 0) return model.label;
  return stripProviderPrefix(model.label, providerPrefix);
}

export function findSelectedModel(
  models: ReadonlyArray<ModelOption>,
  selection: HarnessModelSelection,
): ModelOption | null {
  if (selection.modelSlug.length === 0) return findDefaultModel(models);
  return (
    models.find(
      (model) =>
        model.harnessId === selection.harnessId &&
        model.slug === selection.modelSlug,
    ) ?? null
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
  // Names carry the vendor as a prefix - "Z.ai: GLM 5.2", or for OpenRouter's
  // "latest" aliases "Anthropic Claude Haiku Latest". Trim it (": " or " "
  // separator) since the vendor is already shown as the group header.
  for (const separator of [": ", " "]) {
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

// Identify the model's "upgrade" tier - the one the toolbar toggle should
// flip TO when activated. We deliberately do not assume `supportedServiceTiers[0]`
// is the upgrade: Codex's protocol ordering isn't contractual, and the legacy
// `additionalSpeedTiers` shape can prepend a literal `"default"` entry. Skip
// any option whose id matches the model's declared `defaultServiceTier`; if
// every advertised option matches the default (or none do), fall through to
// the first option so a model that advertises only an upgrade still works.
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

// Clamp the composer's sticky service-tier preference to the selected model -
// the service-tier analogue of `normalizeReasoningForModel`. The raw value
// stays sticky in the toolbar store's `values`, but the derived value the UI
// shows AND the emit path sends is gated here so a preference carried over from
// another model (e.g. Codex `"priority"`) never leaks onto a model whose only
// upgrade tier differs (e.g. Claude `"fast"`) - which would otherwise record
// the wrong "Fast mode on" on the turn and persist a tier the model never
// honored.
//
// - `null` model means the catalog is still resolving: pass the value through
//   untouched (the emit path defers while the slug is unresolved), exactly as
//   reasoning / permission do, so first paint never clobbers the sticky value.
// - Otherwise keep the value only when it is the model's upgrade tier - the
//   same `findUpgradeServiceTierForModel` comparison the toggle uses - so the
//   emitted / recorded tier can never disagree with what the picker displays.
export function normalizeServiceTierForModel(
  value: ServiceTier,
  model: ModelOption | null,
): ServiceTier {
  if (model === null) return value;
  const upgrade = findUpgradeServiceTierForModel(model);
  if (upgrade === null) return "";
  return value.trim() === upgrade.id ? upgrade.id : "";
}
