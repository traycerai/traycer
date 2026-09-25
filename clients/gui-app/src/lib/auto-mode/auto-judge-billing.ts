/**
 * Which pocket a judged approval is charged to, and the copy that says so.
 *
 * One rule, no catalog field, no protocol work: `traycer` is the only harness
 * metered against Traycer credits, and every other one routes through that
 * vendor's own CLI/SDK on the user's own credential. So the predicate is
 * `harnessId !== "traycer"`, which every client already holds. What varies is
 * the SEVERITY, and only one harness has a number worth quoting.
 *
 * The Copilot line quotes TRAYCER'S OWN CALL RATE, never GitHub's monthly
 * allotment. The rate is a fact about our behaviour that we control and that
 * cannot go stale when GitHub reprices; the allotment is theirs, and it would.
 *
 * The composer's Auto row names the MODEL as well as the pocket ("Reviewed by
 * Sonnet 5 on Traycer · uses credits"), so the run-level shape carries a model
 * label. Which judge that is comes from `autoJudge.get`'s `effective`, and
 * under Automatic's fallback it is the conversation's own harness - see
 * {@link autoJudgeTarget}.
 */
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  autoJudgeGetV12,
  autoJudgeSetV12,
} from "@traycer/protocol/host/auto-mode/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type {
  AutoJudgeBlocked,
  AutoJudgeEffective,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { effectiveJudgeReasoningEffort } from "@traycer/protocol/host/agent/gui/reasoning-effort-order";
import {
  ORDERED_PROVIDERS,
  guiHarnessIdToProviderId,
} from "@/lib/provider-ordering";
import { providerAutoJudgeFor } from "@/lib/providers/provider-auto-judge";

/**
 * The stored judge harness is a CHECKED STRING on the wire, not an enum (see
 * `autoJudgeSelectionSchema`), so every id here is compared as a string and an
 * unrecognized one falls back to its own raw id as a label rather than being
 * presented as some other provider.
 */
const TRAYCER_JUDGE_HARNESS_ID = "traycer";
const COPILOT_JUDGE_HARNESS_ID = "copilot";

/**
 * What a stored judge SELECTION can be billed as, and the whole of it.
 *
 * Named separately from {@link AutoJudgeBilling} because {@link
 * autoJudgeBillingFor} can only ever produce these two - it reads a harness id
 * and nothing else - while the RUN-level union below adds two kinds that depend
 * on facts that function never sees. Callers narrowing on "not traycer, so it
 * has a label" are correct against this type and were silently broken by each
 * widening of the union; saying so here is what keeps them correct.
 */
export type AutoJudgeSelectionBilling =
  | { readonly kind: "traycer" }
  | {
      readonly kind: "provider";
      readonly harnessId: string;
      readonly harnessLabel: string;
    };

export type AutoJudgeBilling =
  /**
   * A judge runs and is billed to Traycer credits (`traycer`) or to the user's
   * own account at that vendor (`provider`). `modelLabel` is the display name
   * of the model it runs on, resolved through that harness's catalog, or the
   * raw slug when the catalog has no row for it. `effortLabel` is the
   * reasoning effort the judge runs that model at - the stored pick, or the
   * host's default of the lowest the model advertises - and `null` when the
   * model advertises none or the host predates judge efforts.
   */
  | {
      readonly kind: "traycer";
      readonly modelLabel: string;
      readonly effortLabel: string | null;
    }
  | {
      readonly kind: "provider";
      readonly harnessId: string;
      readonly harnessLabel: string;
      readonly modelLabel: string;
      readonly effortLabel: string | null;
    }
  /**
   * The run's OWN provider reviews its own commands, and Traycer's judge never
   * runs at all.
   *
   * A third kind rather than a flavour of `provider`, because it answers a
   * different question. `provider` means "Traycer's judge runs, billed to the
   * user's account at that vendor" - a real extra call per command reviewed.
   * This one means there is no extra call: the classifier decides inside the
   * agent turn the user is already paying for, which is exactly what the
   * Providers panel's own copy promises ("faster and costs nothing extra").
   * Collapsing the two would make the composer contradict that panel.
   */
  | {
      readonly kind: "provider-native";
      readonly harnessId: string;
      readonly harnessLabel: string;
    }
  /**
   * The host reported that no judge can run (`effective: null`, or a
   * `blocked` reason), so NO judge runs and nothing is charged to anyone.
   *
   * It carries no harness, on purpose: the stored selection is still there and
   * still readable, but it names a judge that will not be called, and a label
   * on this row would invite the reader to believe otherwise. Settings ▸
   * Permissions ▸ Judge already explains WHICH blocker and how to clear it;
   * the composer's one line only has to stop claiming a pocket.
   */
  | { readonly kind: "blocked" };

const TRAYCER_BILLING: AutoJudgeSelectionBilling = { kind: "traycer" };
const BLOCKED_BILLING: AutoJudgeBilling = { kind: "blocked" };

/**
 * Which judge a run's approvals would go to, before its model is named.
 *
 * - `judge` - this harness, on this model slug.
 * - `none` - no judge can run: the host said so (`effective: null`, or a
 *   `blocked` reason), and every command asks the user.
 * - `unknown` - an input the answer needs has not arrived, or the host cannot
 *   say. The row shows no meta line rather than a guess.
 */
export type AutoJudgeTarget =
  | { readonly kind: "unknown" }
  | { readonly kind: "none" }
  | {
      readonly kind: "judge";
      readonly harnessId: string;
      readonly modelSlug: string;
    };

/** What {@link autoJudgeTarget} reads: the `autoJudge.get` answer and the run. */
export interface AutoJudgeTargetInput {
  readonly selection: AutoJudgeSelection | null;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly blocked: AutoJudgeBlocked | null | undefined;
  readonly runHarnessId: string | null;
  /** The composer's selected model; `""` while its catalog is loading. */
  readonly runModelSlug: string;
  /**
   * The run harness's catalog `judgeDefaultModel`, or `null` for none. `""`
   * reads as none too - the wire accepts it, and `defaultJudgeModelFor` in
   * Settings already reads it that way.
   */
  readonly runJudgeDefaultModel: string | null;
}

const UNKNOWN_TARGET: AutoJudgeTarget = { kind: "unknown" };
const NO_JUDGE_TARGET: AutoJudgeTarget = { kind: "none" };

/**
 * The model Automatic's fallback judges on: the run harness's catalog
 * `judgeDefaultModel` when the row names one, else the composer's own model,
 * else `null` while neither is known.
 *
 * `""` is "no default" too, not a slug: the wire accepts it, and Settings'
 * `defaultJudgeModelFor` already reads it that way, so the composer row and
 * the Judge tab name the same judge for the same catalog row. Read as a slug
 * it rendered "Reviewed by  on …" with a blank where the model goes.
 */
function fallbackJudgeModelSlug(
  judgeDefaultModel: string | null,
  runModelSlug: string,
): string | null {
  if (judgeDefaultModel !== null && judgeDefaultModel.length > 0) {
    return judgeDefaultModel;
  }
  return runModelSlug.length > 0 ? runModelSlug : null;
}

/**
 * The judge `autoJudge.get` says a run on `runHarnessId` would get.
 *
 * - `effective: null` is "no judge can run", WHATEVER `blocked` says: a `1.0`
 *   host's `no-default` arrives upgraded as `blocked: unsupported-harness`
 *   with `effective: null`, and a `1.1` host projects nothing else onto
 *   `null`. The pocket is never derived from the stored selection there.
 * - A `blocked` reason is "no judge can run" too.
 * - `selection` / `default` name the harness and model outright.
 * - `fallback` is Automatic falling back to the CONVERSATION'S OWN harness,
 *   which a host-scoped read cannot name. The host judges on that harness's
 *   `judgeDefaultModel` when its catalog row names one, otherwise on the
 *   conversation's currently selected model - so that is what is named here,
 *   from the composer's own run settings. A conversation that itself runs on
 *   `traycer` has no fallback at all: its own provider IS the default that
 *   just could not answer, billed the same way, so the host offers no second
 *   Traycer candidate (`autoJudgeCandidates`) and asks the person instead.
 * - `undefined` is a host that predates `effective` (an unreleased `1.0`
 *   build). A stored selection still names the judge; an unset one names a
 *   server-flagged model this client cannot see, so it is `unknown`.
 */
export function autoJudgeTarget(input: AutoJudgeTargetInput): AutoJudgeTarget {
  const { selection, effective, blocked } = input;
  if (effective === null) return NO_JUDGE_TARGET;
  if (blocked !== null && blocked !== undefined) return NO_JUDGE_TARGET;
  if (effective === undefined) {
    return selection === null
      ? UNKNOWN_TARGET
      : {
          kind: "judge",
          harnessId: selection.harnessId,
          modelSlug: selection.model,
        };
  }
  if (effective.source === "fallback") {
    if (input.runHarnessId === null) return UNKNOWN_TARGET;
    if (input.runHarnessId === TRAYCER_JUDGE_HARNESS_ID) return NO_JUDGE_TARGET;
    const modelSlug = fallbackJudgeModelSlug(
      input.runJudgeDefaultModel,
      input.runModelSlug,
    );
    if (modelSlug === null) return UNKNOWN_TARGET;
    return { kind: "judge", harnessId: input.runHarnessId, modelSlug };
  }
  return {
    kind: "judge",
    harnessId: effective.harnessId,
    modelSlug: effective.model,
  };
}

/**
 * What the harness catalog says about the facts Automatic's FIRST candidate is
 * decided on, as one comparable value.
 *
 * `autoJudge.get`'s `effective` is not a stored fact: under Automatic the host
 * computes it per read from the Traycer harness row (`readAutomaticJudge`:
 * enabled, available, not signed out) and the Traycer catalog. The row half
 * is exactly what `agent.gui.listHarnesses` carries, so a change in this value
 * is the client-visible moment the host's answer can change - including the
 * first probe settling on a cold host, which moves the row from
 * pending-and-unavailable to available.
 *
 * - `traycer-ready` - the row the host would start Automatic's judge on.
 * - `traycer-not-ready` - disabled, unavailable (settled or not yet probed),
 *   or signed out: the host answers `fallback`.
 * - `traycer-absent` - no Traycer row in this catalog at all.
 *
 * The same reading as the host's: `available` already carries the LAST SETTLED
 * verdict while a probe re-runs, so a re-probe of a green row stays ready,
 * and `unauthenticated` is the only definitive signed-out status.
 */
export type AutomaticJudgeInputs =
  | "traycer-ready"
  | "traycer-not-ready"
  | "traycer-absent";

export function automaticJudgeInputs(
  harnesses: ReadonlyArray<GuiHarnessOption>,
): AutomaticJudgeInputs {
  const row = harnesses.find(
    (candidate) => candidate.id === TRAYCER_JUDGE_HARNESS_ID,
  );
  if (row === undefined) return "traycer-absent";
  return row.enabled && row.available && row.authStatus !== "unauthenticated"
    ? "traycer-ready"
    : "traycer-not-ready";
}

/**
 * The billing shape of the host's stored judge selection. `null` - the record
 * is unset - resolves to `traycer`, because that is exactly what the host
 * falls back to, and it is what makes auto mode cost credits before anyone
 * opens Settings.
 */
export function autoJudgeBillingFor(
  harnessId: string | null,
): AutoJudgeSelectionBilling {
  if (harnessId === null || harnessId === TRAYCER_JUDGE_HARNESS_ID) {
    return TRAYCER_BILLING;
  }
  return {
    kind: "provider",
    harnessId,
    harnessLabel: judgeHarnessLabel(harnessId),
  };
}

/**
 * The billing shape for a RUN, which is not the same question as the host's
 * stored judge selection.
 *
 * `isProviderNative` is the precedence fact: a provider set to its own
 * classifier bypasses Traycer's judge and the account policy entirely
 * (`isProviderJudgedExecution` on the host reads the provider's `autoJudge`
 * alone), so the host-wide selection describes a call that will not be made.
 * Deriving the composer's disclosure from that selection alone is how the Auto
 * row came to promise Traycer credits - or another vendor's account - for a
 * command the provider was about to review for free.
 *
 * Takes the decided boolean rather than the provider row, so the precedence
 * rule is one branch here and the LOOKUP is
 * {@link providerRunsItsOwnJudge}'s job. `null` is an `unknown` target: the
 * row says nothing rather than guess.
 */
export function autoJudgeBillingForRun(input: {
  readonly runHarnessId: string | null;
  readonly isProviderNative: boolean;
  /** Which judge the host would call, from {@link autoJudgeTarget}. */
  readonly target: AutoJudgeTarget;
  /**
   * The target model's display label, or `null` when its harness catalog has
   * no row for the slug (the slug itself is shown then).
   */
  readonly judgeModelLabel: string | null;
  /**
   * The label of the effort the judge runs at, from
   * {@link autoJudgeEffortLabel}; `null` when there is none to name.
   */
  readonly judgeEffortLabel: string | null;
  /**
   * A CLIENT-DETECTED reason the stored judge cannot run - today an explicit
   * profile its provider no longer offers, or a model its harness no longer
   * lists.
   *
   * A SEPARATE input rather than a synthesized `blocked` value, because
   * `AutoJudgeBlocked.reason` has no member for either cause and inventing one
   * would put a reason on the wire's type that no host ever sends. The host
   * cannot report either at all - both are client-side comparisons of the
   * stored record against what the client currently has on hand: the
   * `profileId` against `providers.list` (`judgeProfileUnavailable`), and the
   * model slug against that harness's own catalog (`judgeModelUnavailable`).
   *
   * ONE channel rather than a flag per cause, because the user-visible answer
   * is identical for every cause - a second arm would be a second way to say
   * one thing. It arrives here and is folded in once, where the precedence
   * already lives.
   */
  readonly judgeRecordUnrunnable: boolean;
}): AutoJudgeBilling | null {
  const { runHarnessId, isProviderNative, target, judgeRecordUnrunnable } =
    input;
  // Precedence, and the order is the whole content of this function.
  //
  // Provider-native FIRST: that provider's classifier decides inside the agent
  // and Traycer's judge is bypassed, so a blocker on Traycer's judge describes
  // a call that was not going to happen either way. Reporting "blocked" there
  // would tell a user nothing reviews their commands when something does.
  if (isProviderNative && runHarnessId !== null) {
    return {
      kind: "provider-native",
      harnessId: runHarnessId,
      harnessLabel: judgeHarnessLabel(runHarnessId),
    };
  }
  // Then the host's own "no judge can run". The stored selection may still be
  // readable and still name a harness - which is exactly why it must not be
  // billed: every command escalates to the human and no pocket is touched.
  if (target.kind === "none") return BLOCKED_BILLING;
  // Then the client-side equivalent, AFTER the provider-native arm for exactly
  // the same reason the host's blocker is: a provider running its own
  // classifier does not consult Traycer's stored judge, so a vanished profile
  // on that record describes a call that was never going to happen.
  if (judgeRecordUnrunnable) return BLOCKED_BILLING;
  if (target.kind === "unknown") return null;
  const modelLabel = input.judgeModelLabel ?? target.modelSlug;
  const effortLabel = input.judgeEffortLabel;
  const pocket = autoJudgeBillingFor(target.harnessId);
  return pocket.kind === "traycer"
    ? { kind: "traycer", modelLabel, effortLabel }
    : { ...pocket, modelLabel, effortLabel };
}

/**
 * Whether a negotiated method version has reached `line`: the same major, at
 * or past its minor.
 *
 * Pinned to the major like every other version predicate in the tree: a later
 * major's relationship to a field one minor added is not knowable from here.
 * `null` - no handshake yet - reads as NOT reached, the safe direction.
 */
export function negotiatedLineReaches(
  version: SchemaVersion | null,
  line: SchemaVersion,
): boolean {
  return (
    version !== null &&
    version.major === line.major &&
    version.minor >= line.minor
  );
}

/**
 * Whether the negotiated `autoJudge.get` line is one whose host runs the judge
 * at a reasoning effort of its own (`1.2`, where the selection carries one and
 * the host defaults to the model's lowest). Below it the host runs the model's
 * own default, so no LABEL - the composer's Auto row or Settings' "Now:" line -
 * may name an effort it does not apply.
 */
export function autoJudgeGetKnowsReasoningEffort(
  version: SchemaVersion | null,
): boolean {
  return negotiatedLineReaches(version, autoJudgeGetV12.schemaVersion);
}

/**
 * Whether the negotiated `autoJudge.set` line can STORE a reasoning effort
 * (`1.2`, the line that added the field). Below it the request upgrade resets
 * the effort to the model's default, so Settings' Effort FIELD would write
 * something the host silently discards; the field is hidden instead.
 */
export function autoJudgeSetStoresReasoningEffort(
  version: SchemaVersion | null,
): boolean {
  return negotiatedLineReaches(version, autoJudgeSetV12.schemaVersion);
}

/**
 * The display label of the effort the judge runs `target`'s model at:
 * the stored selection's effort when the target IS the stored judge and the
 * model still advertises that effort, else the lowest the model advertises
 * (the host's default). The same protocol rule the host resolves with
 * (`effectiveJudgeReasoningEffort`), so the two cannot disagree.
 *
 * `null` for every "nothing to name": the target is not a judge, the host
 * predates judge efforts, the catalog has not answered, or the model
 * advertises no efforts.
 */
export function autoJudgeEffortLabel(input: {
  readonly target: AutoJudgeTarget;
  readonly selection: AutoJudgeSelection | null;
  readonly hostKnowsEffort: boolean;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
}): string | null {
  const { target, selection } = input;
  if (target.kind !== "judge" || !input.hostKnowsEffort) return null;
  if (input.models === undefined) return null;
  const requested =
    selection !== null &&
    selection.harnessId === target.harnessId &&
    selection.model === target.modelSlug
      ? selection.reasoningEffort
      : null;
  return (
    effectiveJudgeReasoningEffort(input.models, target.modelSlug, requested)
      ?.label ?? null
  );
}

/**
 * Whether `harnessId`'s provider is configured to review its own commands on
 * this host.
 *
 * `undefined` providers - the catalog has not answered yet, or the host
 * predates `providers.list@9.1` - read as `false`, which is the same direction
 * `providerAutoJudgeFor` takes and for the same reason: telling a user their
 * commands are reviewed by a classifier that is not in the loop is the worse
 * error. It means the disclosure is briefly the pre-fold one on a cold cache,
 * which is what it said before this existed.
 */
export function providerRunsItsOwnJudge(input: {
  readonly harnessId: GuiHarnessId | null;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
}): boolean {
  const { harnessId, providers, harnesses } = input;
  if (harnessId === null || providers === undefined) return false;
  if (harnesses === undefined) return false;
  // BOTH halves, and the stored one alone is not enough. `autoJudge` is a
  // PREFERENCE persisted in `provider-overrides.json`; `nativeAutoJudge` is
  // whether this harness currently has a classifier to delegate to at all
  // ("Whether this harness has a provider-native auto-mode classifier Traycer
  // can delegate to instead of running its own judge"). A preference outlives
  // the capability - the override survives a host downgrade, a provider losing
  // the feature, or a build that never had it - and the host resolves the pair,
  // falling back to its own judge when the capability is gone.
  //
  // Trusting the override alone also made this disagree with our OWN Settings
  // surface: `ProviderAutoJudgeSection` renders the switch only for a row with
  // `nativeAutoJudge`, so such a provider shows the read-only "Traycer's judge"
  // line there while the composer claimed its classifier reviews for free.
  // Absent capability reads `false`, matching every other unknown on this path.
  if (!harnessHasNativeAutoJudge(harnessId, harnesses)) return false;
  const providerId = guiHarnessIdToProviderId(harnessId);
  if (providerId === null) return false;
  const state = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (state === undefined) return false;
  return providerAutoJudgeFor(state) === "provider";
}

/**
 * Whether this harness currently has a classifier of its own to delegate to.
 *
 * Extracted from {@link providerRunsItsOwnJudge} rather than restated, because
 * a second caller now needs the SAME question for a different purpose: it is
 * the condition under which the stored preference matters at all, and therefore
 * the condition under which a `providers.list` line too old to report that
 * preference makes the answer UNKNOWN rather than `false`. Two copies of it
 * would let the disclosure and its own unknown-check disagree about which
 * harnesses they are talking about.
 */
export function harnessHasNativeAutoJudge(
  harnessId: GuiHarnessId | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): boolean {
  if (harnessId === null || harnesses === undefined) return false;
  const row = harnesses.find((candidate) => candidate.id === harnessId);
  return row !== undefined && row.nativeAutoJudge;
}

function judgeHarnessLabel(harnessId: string): string {
  const provider = ORDERED_PROVIDERS.find(
    (candidate) => candidate.harnessId === harnessId,
  );
  if (provider === undefined) return harnessId;
  return PROVIDER_DISPLAY_NAMES[provider.providerId];
}

/**
 * The measured order of magnitude of Copilot premium requests an hour of Auto
 * mode spends - Traycer's own call rate over real sessions, not a derivation
 * from one call per command (a reviewed command can take two calls, or none on
 * a cache hit). Quoted by the composer's meta line below and by Settings ▸
 * Permissions ▸ Judge, so the two cannot drift.
 */
export const COPILOT_PREMIUM_REQUESTS_PER_HOUR = "60–350";

/**
 * The one-line disclosure on the composer's Auto row, so a user who never
 * opens Settings still learns which model reviews and which pocket is charged
 * BEFORE turning the mode on.
 */
export function autoJudgeMetaLine(billing: AutoJudgeBilling): string {
  switch (billing.kind) {
    case "traycer":
      return `Reviewed by ${judgeModelWithEffort(billing)} on Traycer · uses credits`;
    case "provider":
      // The metered case is named with its range, whether the user picked
      // Copilot or Automatic fell back to a Copilot conversation.
      if (billing.harnessId === COPILOT_JUDGE_HARNESS_ID) {
        return `Reviewed by ${judgeModelWithEffort(billing)} on Copilot · uses premium requests (${COPILOT_PREMIUM_REQUESTS_PER_HOUR} per hour)`;
      }
      return `Reviewed by ${judgeModelWithEffort(billing)} on ${billing.harnessLabel} · your account`;
    case "provider-native":
      return `Reviewed by ${billing.harnessLabel}'s built-in classifier · no extra cost`;
    // Says what HAPPENS, not what is missing: a user about to turn Auto on
    // needs to know every command will come to them.
    case "blocked":
      return "No judge available on this machine · asks you instead";
  }
}

/** "Sonnet 5 (Low)" - the model, and the effort it reviews at when named. */
function judgeModelWithEffort(billing: {
  readonly modelLabel: string;
  readonly effortLabel: string | null;
}): string {
  return billing.effortLabel === null
    ? billing.modelLabel
    : `${billing.modelLabel} (${billing.effortLabel})`;
}

/**
 * Why the composer's Auto row is disabled for the turn running now, or `null`
 * when it is not.
 *
 * A flip into Auto mid-turn takes effect at once when Traycer's judge reviews
 * (the host binds it at its own approval seam), so the row stays live and the
 * `AUTO_MID_TURN_NOTICE` says so. It cannot when the run's own provider
 * reviews: that classifier decides inside a session whose mode was fixed when
 * the turn was spawned, and the host refuses the flip
 * (`AUTO_MODE_PROVIDER_JUDGE_NEEDS_NEW_TURN`) rather than quietly run
 * Traycer's judge on a provider the user switched it off for. The row is
 * disabled with this sentence instead, so the refusal is something the user
 * reads before choosing, never a toast after.
 *
 * Only a flip INTO Auto is locked. A turn already in Auto keeps its judge,
 * whichever it is.
 *
 * A `null` billing - the reads that say which judge reviews have not settled
 * - locks the row too, with the sentence below rather than the notice. The
 * host is the gate that cannot be bypassed; this row is the explanation, and
 * an explanation that says "switches now" for a flip the host is about to
 * refuse is the toast-after-the-fact this lock exists to prevent. The window
 * is short (the catalog reads the row already waits on), and a person who
 * meets it sees why the row is waiting rather than a promise it cannot keep.
 */
export function autoModeMidTurnLock(input: {
  readonly turnActive: boolean;
  /** Whether the mode on display is already `auto`. */
  readonly currentModeIsAuto: boolean;
  readonly judgeBilling: AutoJudgeBilling | null;
}): string | null {
  if (!input.turnActive || input.currentModeIsAuto) return null;
  if (input.judgeBilling === null) return AUTO_MID_TURN_UNRESOLVED_LOCK;
  if (input.judgeBilling.kind !== "provider-native") return null;
  return `${input.judgeBilling.harnessLabel}'s built-in classifier starts with your next turn. To switch now, pick Traycer's judge in Permission settings.`;
}

/**
 * The Auto row's sentence while a turn runs and which judge would review it
 * is still being read. Exported for the picker tests, which pin the copy.
 */
export const AUTO_MID_TURN_UNRESOLVED_LOCK =
  "Still checking which judge reviews this conversation. Auto can be switched on once that's known, or with your next turn.";
