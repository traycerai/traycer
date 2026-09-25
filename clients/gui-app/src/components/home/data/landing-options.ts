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
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { agentGuiListHarnessesV91 } from "@traycer/protocol/host/agent/gui/contracts";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import {
  Eye,
  FilePen,
  ShieldCheck,
  ShieldOff,
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

// One sentence per mode, and the four icons are one family read as a dial:
// an eye (you watch everything), a pen (edits flow), a shield on (something
// reviews for you), a shield off (nothing does). Exceptions do not go into
// these sentences; they live where they apply - `PERMISSION_MODE_DETAILS`
// below, and the Auto row's meta line.
const SUPERVISED_PERMISSION_OPTION: PermissionOption = {
  id: "supervised",
  label: "Supervised",
  description: "Asks before every command and file change.",
  icon: Eye,
};
const AUTO_ACCEPT_EDITS_PERMISSION_OPTION: PermissionOption = {
  id: "auto_accept_edits",
  label: "Auto-accept edits",
  description: "Edits go through. Commands still ask.",
  icon: FilePen,
};
// ALLOW is the only silent path: a block, an unsure verdict and a judge that
// cannot run all come to the user as a card, which is what "asks you about
// risky ones" has to stay true of.
const AUTO_PERMISSION_OPTION: PermissionOption = {
  id: "auto",
  label: "Auto",
  description:
    "A judge approves routine commands and asks you about risky ones.",
  icon: ShieldCheck,
};
const FULL_ACCESS_PERMISSION_OPTION: PermissionOption = {
  id: "full_access",
  label: "Full access",
  description: "Runs everything. Nothing asks.",
  icon: ShieldOff,
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

/**
 * One thing a mode lets an agent do without asking, and - where one applies -
 * the exception that still asks, kept apart so a surface can set it off from
 * the item rather than burying it in the sentence.
 */
export interface PermissionModeDetailItem {
  readonly text: string;
  readonly exception: string | null;
}

export interface PermissionModeDetails {
  /** What runs without asking under this mode, most basic first. */
  readonly runsWithoutAsking: ReadonlyArray<PermissionModeDetailItem>;
}

/**
 * The "runs without asking" lists Settings ▸ Permissions ▸ Modes renders, one
 * card per mode.
 *
 * Beside {@link PERMISSION_OPTIONS} rather than in the Settings panel so the
 * one-line descriptions and these lists are edited together: the list is what
 * the description is a summary of.
 *
 * The guarded-path exception sits on the Auto-accept edits entry because that
 * is where it applies: edits to a workspace's configuration, scripts and git
 * internals still ask even though edits otherwise go through (the host's
 * `judge-input-edit-paths.ts`). Auto's exception sits on the judge item for
 * the same reason: the list is what runs WITHOUT asking, so "risky commands
 * ask you" is not a member of it - it is the exception to the judge's
 * approvals, set off from that item rather than listed as if it ran unasked.
 */
export const PERMISSION_MODE_DETAILS: Readonly<
  Record<PermissionMode, PermissionModeDetails>
> = {
  supervised: {
    runsWithoutAsking: [{ text: "Reads and searches", exception: null }],
  },
  auto_accept_edits: {
    runsWithoutAsking: [
      { text: "Reads and searches", exception: null },
      {
        text: "File edits in the workspace",
        exception: "config, scripts and git internals still ask",
      },
    ],
  },
  auto: {
    runsWithoutAsking: [
      { text: "Reads, searches, edits", exception: null },
      {
        text: "Commands the judge approves",
        exception: "risky ones still ask you",
      },
    ],
  },
  full_access: {
    runsWithoutAsking: [{ text: "Everything, unreviewed", exception: null }],
  },
};

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

/**
 * Whether a harness row's advertised modes permit `mode`.
 *
 * **Absent and EMPTY both mean "unconstrained", and the empty case is the one
 * that gets missed.** `null` is "no harness scope yet" - the Settings default
 * row, or a catalog still loading. An empty array is a harness that ANSWERED
 * and declared no constraint, and the authority for reading it that way is the
 * host: `HarnessRuntime.assertAdapterPermissionModeSupported` opens with
 * `if (adapter.supportedPermissionModes.length === 0) return;`, so such a
 * harness accepts every mode. A reader that treats empty as "supports nothing"
 * therefore refuses - or silently rewrites - a tuple the host would have run.
 *
 * ONE COPY, and that is the point of it existing. The rule was written out four
 * times: here (through {@link normalizePermissionMode}), in the desktop picker's
 * per-option `isSupported`, in the phone sheet's, and - wrongly, as a bare
 * `.includes("auto")` - in the clone clamp, which is where the missing empty
 * case became a silent demotion of a user's chosen mode.
 */
export function harnessHonorsPermissionMode(
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null,
  mode: PermissionMode,
): boolean {
  if (supportedPermissionModes === null) return true;
  if (supportedPermissionModes.length === 0) return true;
  return supportedPermissionModes.includes(mode);
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
/**
 * Whether this composer may OFFER `mode` - the ROW's constraint AND the HOST's
 * line, which are two different questions and both have to answer yes.
 *
 * {@link harnessHonorsPermissionMode} is about the row alone and is right to
 * be: an empty `supportedPermissionModes` is a harness that answered and
 * constrained nothing, so it honors every mode. But "this provider would run
 * it" is not "this machine can express it". A pre-`auto` host returns
 * unconstrained rows like any other, so the row predicate says yes and the
 * option lights up on a host whose `chat.subscribe` line cannot carry the
 * enum - the UI then sits on Auto while `sendAction` drops every mode-bearing
 * frame at the projection cliff, which is silent on both ends.
 *
 * Only `auto` takes the second proof, for the reason
 * {@link catalogLineKnowsAutoMode} gives: it is the one mode young enough for a
 * supported host to predate.
 *
 * `hostKnowsAutoMode` has THREE states, and the third is the one that gets
 * missed:
 *
 * - `true` - a host is in scope and its negotiated line can spell `auto`;
 * - `false` - a host is in scope and it cannot, or its line is unreadable.
 *   Unreadable counts as cannot: the surface is about to send on that host;
 * - `null` - NO host is in scope. Settings' install-wide default row is the
 *   case: it names no harness and no machine, and a preference recorded there
 *   is clamped later by whichever host actually runs it.
 *
 * Collapsing `null` into `false` refuses a mode because no machine has been
 * named, which is not the claim "a machine said no". The row dimension beside
 * it has carried the same three states all along (`null` / `[]` / a list).
 *
 * ONE COPY of that pairing, same discipline as the row predicate's own note -
 * the pickers, the sticky clamp and anything else that offers a mode read this
 * rather than restating "and also check the host".
 */
export function composerOffersPermissionMode(
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null,
  mode: PermissionMode,
  hostKnowsAutoMode: boolean | null,
): boolean {
  if (!harnessHonorsPermissionMode(supportedPermissionModes, mode))
    return false;
  // `=== false`, not falsy. `null` is NO HOST IN SCOPE and passes through,
  // exactly as a `null` `supportedPermissionModes` does one line up - the two
  // dimensions carry the same three states and have to read them the same way.
  return mode !== "auto" || hostKnowsAutoMode !== false;
}

export function normalizePermissionMode(
  value: PermissionMode,
  supportedPermissionModes: ReadonlyArray<PermissionMode> | null,
  hostKnowsAutoMode: boolean | null,
): PermissionMode {
  // The HOST proof runs FIRST, and it is not foldable into the row walk below.
  // That walk only ever narrows within what the row declares, and a pre-`auto`
  // host's rows are routinely unconstrained - so an `auto` sticky would satisfy
  // `harnessHonorsPermissionMode`, return on the first branch, and never reach
  // a fallback at all. `findSafestSupportedPermissionMode([])` answers `null`
  // for the same reason, so even the tail would have handed `auto` back.
  //
  // `hostKnowsAutoMode` is a required parameter rather than a defaulted one
  // precisely so every call site has to answer it; the repo bans defaults for
  // this reason and it earns its keep here.
  const candidate =
    value === "auto" && hostKnowsAutoMode === false
      ? (PERMISSION_FALLBACK_MODE.auto ?? value)
      : value;
  // The null arm is repeated here rather than left to the predicate alone:
  // the predicate already answers true for it, but the compiler cannot see
  // that, and the fallback path below needs the array narrowed.
  if (
    supportedPermissionModes === null ||
    harnessHonorsPermissionMode(supportedPermissionModes, candidate)
  )
    return candidate;
  const declaredFallback = PERMISSION_FALLBACK_MODE[candidate];
  if (
    declaredFallback !== null &&
    supportedPermissionModes.includes(declaredFallback)
  ) {
    return declaredFallback;
  }
  return (
    findSafestSupportedPermissionMode(supportedPermissionModes) ?? candidate
  );
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
 * Whether this host's negotiated harness-catalog line can SPELL `auto` at all.
 *
 * A HOST capability, which is a different question from every predicate around
 * it. `harnessHonorsPermissionMode` asks whether one row would accept a mode;
 * {@link catalogSupportedPermissionModes} asks which modes the rows collectively
 * name. Neither can answer "does this machine have Auto mode", and the gap
 * between them is exactly where a surface gets it wrong: a catalog of
 * UNCONSTRAINED rows (`supportedPermissionModes: []`, which the host reads as
 * accepting every mode) names no modes at all, so a union-based test concludes
 * "no auto here" about a host that would run it.
 *
 * The honest evidence is the negotiated line. `auto` became expressible in
 * `supportedPermissionModes` at `agent.gui.listHarnesses@9.1`, and a host below
 * it filters the mode out of every row it serves - so the line, not the rows,
 * is what says the capability exists. Same shape as
 * `session-import-run-controller`'s `handshakeProvesPreAutoCatalog`, which
 * reads the same manifest entry against the same contract; that one is a VETO
 * and this is a PROOF, which is why they are two predicates rather than one
 * (see `versionIsBelow`'s note on why the higher-major case has to answer
 * differently for each).
 *
 * `null` - no handshake recorded for this host yet - is NOT proven, and that is
 * the safe direction for every caller: a surface that appears a moment later is
 * ordinary, one that claims a capability it has not seen evidence for is not.
 * The version is compared against the CONTRACT rather than a literal, so a
 * rebase that renumbers the line moves this with it.
 */
export function catalogLineKnowsAutoMode(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  const line = agentGuiListHarnessesV91.schemaVersion;
  if (version.major !== line.major) return false;
  return version.minor >= line.minor;
}

/**
 * Whether a surface may offer `auto`, from BOTH proofs a surface can hold.
 *
 * The two are different methods and negotiate independently, which is the
 * whole reason this exists:
 *
 * - {@link catalogLineKnowsAutoMode} on `agent.gui.listHarnesses@9.1` says
 *   this host can OFFER the mode - a host below it filters `auto` out of every
 *   catalog row it serves;
 * - `chatLineCarriesAutoMode` on `chat.subscribe@1.13` says this chat can
 *   CARRY the value on a client frame. Below it,
 *   `projectChatClientFrameForVersion` THROWS rather than stripping the field,
 *   so an offer the send cannot honour is a crash at the stream boundary and
 *   not a silent downgrade.
 *
 * A chat composer needs both. Gating on the catalog alone is the
 * gate-on-a-sibling-method defect: the catalog line is evidence about the
 * catalog's shape and about nothing else.
 *
 * `chatLineCarriesAutoMode` has THREE states, and `null` is the one that makes
 * this usable from more than one surface:
 *
 * - `true` / `false` - a live chat session answered about ITS negotiated line;
 * - `null` - NO chat session is in scope, so the catalog line is all this
 *   surface can know. The landing composer is the case: it has no chat yet,
 *   and the chat it creates negotiates only once it opens.
 *
 * `null` therefore passes through rather than vetoing, exactly as it does in
 * {@link composerOffersPermissionMode} one level up - refusing a mode because
 * nothing has been asked is not the claim "a line said no".
 *
 * **Why this cannot be read per-host.** `chat.subscribe` is a STREAM method.
 * The negotiated-manifest registry behind `useHostMethodSchemaVersion` is fed
 * only by the UNARY connection's `openAck`, so it holds no stream method at
 * all and `getNegotiatedHostMethodVersion(hostId, "chat.subscribe")` answers
 * `null` for every host forever. The version is also per-SESSION rather than
 * per-host - sibling tabs negotiate separately - so the fact has to travel
 * from a live session (`ChatStreamClient.autoPermissionModeProtocolSupported`)
 * and there is no host-wide answer to substitute.
 */
export function autoModeOfferableHere(
  catalogLine: SchemaVersion | null,
  chatLineCarriesAutoMode: boolean | null,
): boolean {
  if (!catalogLineKnowsAutoMode(catalogLine)) return false;
  // `!== false`, not truthy: `null` is "no chat in scope", not a refusal.
  return chatLineCarriesAutoMode !== false;
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
    // An UNCONSTRAINED row makes the whole union unknowable, and skipping that
    // is how `[[], ["full_access"]]` came out as "this host only does full
    // access" while the first harness honours every mode. A union can only
    // describe rows that constrain something; one that does not is a row whose
    // modes are "all of them", and adding all of them would be a different
    // lie - it would claim `auto` for a pre-auto host whose adapters simply
    // declare nothing. `null` is the honest answer: nothing is known about
    // this catalog's aggregate, which every caller already reads as "keep
    // today's copy" (see `harnessHonorsPermissionMode` for the per-row rule
    // this mirrors, and `catalogLineKnowsAutoMode` for the question a union
    // was never able to answer).
    if (harness.supportedPermissionModes.length === 0) return null;
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
 * **This sentence has been wrong in BOTH directions, which is why it now claims
 * as little as it can.** It first said "This turn keeps running as it is",
 * which was false because a mid-turn change is not deferred:
 * `handleComposerSettingsChange` forwards `activePermissionModeUpdate` the
 * moment the mode moves while a run is in progress, and the host mutates
 * `activeExecution.permissionMode` on arrival. It was then corrected to say
 * edits are "approved without review until then" - true of the host at that
 * moment, and false of the host today.
 *
 * **The fact it is pinned to is `authorizingPermissionMode` in the host's
 * `chat-session-manager.ts`:** `permissionMode === "auto" && autoJudge === null`
 * returns `"supervised"`, and that is what `FileEditCoordinator` is handed
 * (`getPermissionMode: () => authorizingPermissionMode(execution)`). So a turn
 * that enters `auto` without a judge bound now FAILS CLOSED - every edit is put
 * to the user - rather than passing unreviewed. If that function changes, this
 * sentence moves with it; nothing in this repo can go red to tell you, because
 * the behaviour it describes lives in another one.
 *
 * It also no longer says WHEN the judge starts, and that clause was the second
 * error: `autoJudge` is bound once at turn start, so a turn that began in
 * `auto`, left it and came back still has its judge - for that user the judge
 * did not wait for the next message. The claim that survives both cases is the
 * one that matters at the moment of the choice: the switch applies now, and
 * nothing passes unchecked either way. The second sentence is that claim for
 * the approvals already on screen: a card raised before the switch stays a
 * card, it is not handed to the judge retroactively.
 *
 * It lives in the PICKER rather than as a chat notice deliberately: the user's
 * attention is in the menu at the moment of the choice, and this is a
 * prediction about a choice not yet committed. A chat notice would arrive
 * after the fact.
 */
export const AUTO_MID_TURN_NOTICE =
  "Switches now. Anything already waiting still asks you.";

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
 *
 * The host accusation is restricted to `auto`, and the restriction is
 * load-bearing rather than defensive. `catalogSupportedModes` is a UNION over
 * the rows the host served, so a mode is absent from it when EITHER the host
 * cannot spell the value OR every available provider declined it - two facts
 * one array cannot tell apart. `auto` is the only mode young enough for the
 * first reading to be possible at all (a pre-`auto` host filters it out of
 * every row it serves, `agent.gui.listHarnesses@9.1`); `supervised`,
 * `auto_accept_edits` and `full_access` predate every host that can answer this
 * catalog, so their absence is ALWAYS the providers declining, and blaming the
 * machine for one would send a user chasing an update that changes nothing.
 */
export function unsupportedPermissionModeCopy(input: {
  readonly mode: PermissionMode;
  readonly harnessLabel: string | null;
  readonly catalogSupportedModes: ReadonlyArray<PermissionMode> | null;
  /**
   * Whether the host's negotiated catalog line can spell `auto` at all
   * ({@link catalogLineKnowsAutoMode}). `true` VETOES the upgrade sentence.
   */
  readonly hostKnowsAutoMode: boolean | null;
}): string {
  const { mode, harnessLabel, catalogSupportedModes, hostKnowsAutoMode } =
    input;
  // The upgrade sentence is a claim about the MACHINE, and the mode union
  // cannot make it. `auto` missing from the union has two causes - a host that
  // cannot spell it, and a 9.1 host whose available providers all decline it -
  // and telling the second user to update Traycer sends them after a fix that
  // changes nothing, which is the mirror of the bug this sentence was written
  // to prevent. So the negotiated line gets a veto: if the host demonstrably
  // knows `auto`, its absence here is the providers' doing and the provider
  // sentence is the true one.
  if (
    mode === "auto" &&
    // `=== false` for the same reason the offer predicate uses it: with no
    // host in scope there is no machine to tell the user to update.
    hostKnowsAutoMode === false &&
    catalogSupportedModes !== null &&
    !catalogSupportedModes.includes(mode)
  ) {
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

/**
 * Standard reasoning effort levels for Kimi K3 / coding models.
 *
 * Used as a client-side fallback for catalog rows (e.g. on `kimi` and `hermes`
 * harnesses) that shipped no `supportedReasoningEfforts` metadata in the host
 * response (issue #1236).
 */
export const KIMI_K3_DEFAULT_REASONING_OPTIONS: ReadonlyArray<ReasoningLevelOption> =
  [
    {
      id: "off",
      label: "Off",
      description: "Standard execution without extended reasoning",
    },
    {
      id: "low",
      label: "Low",
      description: "Fast reasoning pass",
    },
    {
      id: "high",
      label: "High",
      description: "Deep reasoning pass",
    },
    {
      id: "max",
      label: "Max",
      description: "Maximum reasoning effort",
    },
  ];

const KIMI_K3_HARNESS_IDS = new Set(["kimi", "hermes", "omp"]);

/**
 * Checks whether a given model selection matches a known Kimi K3 / Kimi-coding
 * model identity.
 *
 * @param model - The model option or selection descriptor to test.
 * @returns `true` if the model is a recognized Kimi K3 / coding variant.
 */
export function isKimiK3Model(model: {
  readonly harnessId: string;
  readonly slug: string;
  readonly label?: string | null;
}): boolean {
  if (!KIMI_K3_HARNESS_IDS.has(model.harnessId)) {
    return false;
  }
  const slugLower = model.slug.toLowerCase();
  const labelLower = (model.label ?? "").toLowerCase();

  return (
    slugLower.includes("k3") ||
    slugLower.includes("kimi-for-coding") ||
    slugLower.includes("kimi-coding") ||
    slugLower.includes("kimi-code") ||
    labelLower.includes("k3") ||
    labelLower.includes("kimi-for-coding") ||
    labelLower.includes("kimi-coding")
  );
}

/**
 * Finds the reasoning effort options available for a model.
 *
 * If the host catalog provided explicit options, those are returned.
 * If empty and the model is recognized as a Kimi K3 model, returns the default
 * K3 reasoning effort options (`off`, `low`, `high`, `max`).
 *
 * @param model - The model option to inspect.
 * @returns An array of supported reasoning level options.
 */
export function findReasoningOptionsForModel(
  model: ModelOption | null,
): ReadonlyArray<ReasoningLevelOption> {
  if (model === null) return NO_REASONING_OPTIONS;
  if (model.supportedReasoningEfforts.length > 0) {
    return model.supportedReasoningEfforts;
  }
  if (isKimiK3Model(model)) {
    return KIMI_K3_DEFAULT_REASONING_OPTIONS;
  }
  return NO_REASONING_OPTIONS;
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
