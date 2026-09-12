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
  Gavel,
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
export function isTuiHarnessId(value: string): value is TuiHarnessId {
  return tuiHarnessIdSchema.safeParse(value).success;
}

// Hand-written duplicate of the protocol's `permissionModeSchema`. It stays
// hand-written because `PERMISSION_OPTIONS` below has to pair each mode with
// renderer-only copy and an icon, and a mode with no option is not renderable -
// but it means the two lists must be widened together, and the ORDER here and
// there is the same most-restrictive-to-most-permissive order the protocol
// documents (`ALL_PERMISSION_MODES`), because the clamp walks it.
export type PermissionMode =
  | "supervised"
  | "auto_accept_edits"
  | "auto"
  | "full_access";

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
// Three things the previous string ("…asks you only when unsure") got wrong,
// all of them verified against the seam: a BLOCK verdict cards, an
// UNAVAILABLE judge cards (`applyJudgeEscalation` is reached for both), and
// the mode spends money that only Settings mentioned. The phrasing below is
// deliberately not a list of three cases dressed as prose - ALLOW is the only
// silent path, and "asks you whenever it can't clearly approve" states exactly
// that invariant, so a user who reads only the first clause still holds a true
// belief. The three words after the dash are its instances.
const AUTO_PERMISSION_OPTION: PermissionOption = {
  id: "auto",
  label: "Auto",
  description:
    "Auto-approve edits. A judge reviews each command and asks you whenever it can't clearly approve — risky, unsure, or unavailable.",
  icon: Gavel,
};
const FULL_ACCESS_PERMISSION_OPTION: PermissionOption = {
  id: "full_access",
  label: "Full access",
  description: "Allow commands and edits without prompts.",
  icon: UnlockKeyhole,
};

// Order is load-bearing twice over: the picker renders in this order, and
// `findSafestSupportedPermissionMode` walks it to pick a clamp target. `auto`
// sits above `auto_accept_edits` because it does everything that mode does and
// additionally lets a judge approve commands.
//
// That POSITION is not what makes `auto` clamp to `auto_accept_edits`, and
// reading it that way is the trap: the safest-supported walk starts at the top
// of this list, so on a host serving the pre-auto trio it lands on
// `supervised`, three rows below where the user was. `PERMISSION_FALLBACK_MODE`
// is what names the target; the order here only has to keep `auto` ABOVE
// `auto_accept_edits` so the two agree about which way is down.
export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  SUPERVISED_PERMISSION_OPTION,
  AUTO_ACCEPT_EDITS_PERMISSION_OPTION,
  AUTO_PERMISSION_OPTION,
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
  if (mode === "auto") return AUTO_PERMISSION_OPTION;
  if (mode === "full_access") return FULL_ACCESS_PERMISSION_OPTION;
  return SUPERVISED_PERMISSION_OPTION;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_OPTIONS.some((option) => option.id === value);
}

// The mode a peer that cannot honor a given one should be handed INSTEAD,
// consulted before the generic safest-supported rule below. Exhaustive over
// `PermissionMode` on purpose: widening the union again is then a compile
// error here rather than a silent inheritance of the safest-mode default.
//
// Only `auto` names one, and the reason is that `auto` is the sole mode whose
// unsupported case is a MISSING CAPABILITY rather than a policy the peer
// declines. A host that predates `auto` filters it out of every
// `supportedPermissionModes` row it serves, so what the user asked for
// ("auto-accept edits, and let a judge decide the rest") is still half
// available there: the edits half. Walking to the safest supported mode would
// answer that request with `supervised` - stricter than the user's own
// `auto_accept_edits` default and stricter than the chat ran a moment ago on
// another host - so `auto` names its own target instead.
const PERMISSION_FALLBACK_MODE: Readonly<
  Record<PermissionMode, PermissionMode | null>
> = {
  supervised: null,
  auto_accept_edits: null,
  auto: "auto_accept_edits",
  full_access: null,
};

/**
 * The mode `value` degrades to on a peer that does not know it, with no
 * supported-set to consult - the whole-peer twin of the per-harness clamp in
 * {@link normalizePermissionMode}, sharing its table so the two can never
 * disagree about where `auto` lands.
 *
 * A mode with no declared fallback answers itself: this only ever demotes, and
 * only where a demotion target has been written down.
 */
export function fallbackPermissionMode(value: PermissionMode): PermissionMode {
  return PERMISSION_FALLBACK_MODE[value] ?? value;
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
// - Otherwise: keep the current value if supported; else take the value's own
//   declared fallback when the peer honors THAT (`PERMISSION_FALLBACK_MODE` -
//   in practice `auto` → `auto_accept_edits`); else fall back to the
//   *most-restrictive* supported mode (per `PERMISSION_OPTIONS` order,
//   supervised → auto_accept_edits → auto → full_access). NEVER trust
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
  const declaredFallback = PERMISSION_FALLBACK_MODE[value];
  if (
    declaredFallback !== null &&
    supportedPermissionModes.includes(declaredFallback)
  ) {
    return declaredFallback;
  }
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

/**
 * Every permission mode ANY harness on this host honors - the union across the
 * catalog, not one row's set.
 *
 * This is what separates a HOST constraint from a PROVIDER one. A picker holds
 * the selected harness's `supportedPermissionModes` and cannot tell "this host
 * predates `auto`" (absent from every row) from "this provider declines it"
 * (amp, cursor), so it reported both as "Not supported by <provider>" and sent
 * users to file a provider bug whose fix was "update your host".
 *
 * `undefined` harnesses (catalog still loading) answer `null` - nothing is
 * known, so callers keep today's copy. An EMPTY catalog answers `null` too,
 * matching {@link normalizePermissionMode}'s treatment of an empty supported
 * set: a list that constrains nothing is not evidence that a mode is missing.
 */
export function catalogSupportedPermissionModes(
  harnesses: ReadonlyArray<HarnessOption> | undefined,
): ReadonlyArray<PermissionMode> | null {
  if (harnesses === undefined || harnesses.length === 0) return null;
  const union = new Set<PermissionMode>();
  for (const harness of harnesses) {
    for (const mode of harness.supportedPermissionModes) union.add(mode);
  }
  if (union.size === 0) return null;
  return PERMISSION_OPTIONS.filter((option) => union.has(option.id)).map(
    (option) => option.id,
  );
}

/**
 * What the `auto` row says when the user is mid-turn and about to switch INTO
 * it.
 *
 * The second sentence is the load-bearing one. `ActiveExecution.autoJudge`
 * stays `null` on a mid-turn flip, so the rest of that turn behaves exactly as
 * `auto_accept_edits` did - without it a user reads the first sentence as "the
 * judge starts soon" and waits for a change that never arrives in this turn.
 *
 * It lives in the PICKER rather than as a chat notice deliberately: the user's
 * attention is in the menu at the moment of the choice, and this is a
 * prediction about a choice not yet committed. A chat notice would arrive
 * after the fact, and the host has no reason to learn about a renderer gesture
 * that changes nothing it does.
 */
export const AUTO_MID_TURN_NOTICE =
  "The judge starts on your next message. This turn keeps running as it is.";

/**
 * What a disabled option says, and WHO it blames.
 *
 * Shared by the desktop dropdown and the phone sheet so the two can never
 * disagree about it - the sheet's own doc already commits to reading the
 * desktop picker's registries rather than restating them.
 *
 * A mode absent from the whole catalog is a host that predates it; a mode
 * present elsewhere but not here is the provider declining it. `null`
 * `catalogSupportedModes` is "not known yet" and keeps the provider string, so
 * a catalog still loading never accuses the host.
 */
export function unsupportedPermissionModeCopy(input: {
  readonly mode: PermissionMode;
  readonly harnessLabel: string | null;
  readonly catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
}): string {
  const { mode, harnessLabel, catalogSupportedModes } = input;
  if (catalogSupportedModes !== null && !catalogSupportedModes.includes(mode)) {
    return "Needs a newer Traycer on this machine.";
  }
  return `Not supported by ${harnessLabel ?? "this provider"}.`;
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

/**
 * Whether a persisted service tier means "fast mode is on" - i.e. the value is
 * a real non-default tier rather than the harness default. Per the `ServiceTier`
 * contract above, both `null` (never set) and `""` ("use the harness default")
 * mean off. The single definition shared by every surface that reports fast
 * mode: the assistant turn footer and the sidebar hover card's settings header.
 */
export function isFastModeEnabled(serviceTier: string | null): boolean {
  return serviceTier !== null && serviceTier.trim().length > 0;
}

export interface HarnessModelSelection {
  harnessId: ProviderId;
  modelSlug: string;
  // Which of the harness's logged-in profiles (subscriptions) this selection
  // runs on. `null` = the ambient/host login - the only value single/no-profile
  // providers ever carry, so their behavior stays byte-identical. See the
  // multi-profile decision log.
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

// A READ-ONLY lookup: the row is used for display and for reading capability
// off, never to rewrite the persisted slug. That is why an AMBIGUOUS alias
// match is acceptable here - tied rows are the same underlying model, so any
// of them answers "what is this model called / what can it do". The write side
// (`resolveModelSlug` in the composer toolbar store) is the one that must
// refuse an ambiguous match.
//
// KNOWN LIMIT, deliberately not designed around: the caller also clamps the
// sticky reasoning effort and service tier against this row
// (`normalizeReasoningForModel` / `normalizeServiceTierForModel` in
// `deriveToolbarState`), so if tied rows ever disagreed about an effort the
// user had selected, first-in-catalog-order would silently drop it from the
// emitted settings. Measured against the live Claude catalog the two tied rows
// (`default`, `opus[1m]`) expose identical efforts and both expose the fast
// tier, so there is nothing to choose between them today. Preferring whichever
// tied row happens to support the request would pick a row based on what was
// asked for, which is worse than picking one by a stable order. The host-side
// A2A readers, which CAN report back, surface the disagreement through their
// `warnings` channel instead - see `aliasDisagreementWarnings`.
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
  // Names carry the provider/vendor as a prefix - "Z.ai: GLM 5.2", OpenRouter's
  // "latest" aliases "Anthropic Claude Haiku Latest", or Kilo's "OpenRouter/Aion
  // -1.0". Trim it (": ", " ", or "/" separator) since the provider is already
  // shown as the group header.
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
