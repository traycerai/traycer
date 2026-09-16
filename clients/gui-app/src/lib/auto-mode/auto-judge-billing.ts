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
 */
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { AutoJudgeBlocked } from "@traycer/protocol/host/auto-mode/contracts";
import type {
  GuiHarnessId,
  GuiHarnessOption,
} from "@traycer/protocol/host/index";
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
  | AutoJudgeSelectionBilling
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
   * The host reported a `blocked` reason, so NO judge runs and nothing is
   * charged to anyone.
   *
   * It carries no harness, on purpose: the stored selection is still there and
   * still readable, but it names a judge that will not be called, and a label
   * on this row would invite the reader to believe otherwise. The Settings
   * surface already explains WHICH blocker and how to clear it
   * (`AutoJudgeBlockedStatus`); the composer's one line only has to stop
   * claiming a pocket.
   */
  | { readonly kind: "blocked" };

const TRAYCER_BILLING: AutoJudgeSelectionBilling = { kind: "traycer" };
const BLOCKED_BILLING: AutoJudgeBilling = { kind: "blocked" };

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
 * {@link providerRunsItsOwnJudge}'s job.
 */
export function autoJudgeBillingForRun(input: {
  readonly judgeHarnessId: string | null;
  readonly runHarnessId: string | null;
  readonly isProviderNative: boolean;
  /**
   * The host's `autoJudge.get` blocker, if it reported one. `undefined` is an
   * older host that has no such field, and reads the same as `null`.
   */
  readonly blocked: AutoJudgeBlocked | null | undefined;
  /**
   * The stored judge names an explicit profile its provider no longer offers.
   *
   * A SEPARATE input rather than a synthesized `blocked` value, because
   * `AutoJudgeBlocked.reason` has no missing-profile member and inventing one
   * would put a reason on the wire's type that no host ever sends. The host
   * cannot report this at all - it is a client-side comparison of the stored
   * `profileId` against what `providers.list` currently offers
   * (`judgeProfileUnavailable`) - so it arrives on its own channel and is
   * folded in here, once, where the precedence already lives.
   */
  readonly judgeProfileUnavailable: boolean;
}): AutoJudgeBilling {
  const {
    judgeHarnessId,
    runHarnessId,
    isProviderNative,
    blocked,
    judgeProfileUnavailable,
  } = input;
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
  // Then the blocker. The stored selection is still readable and still names a
  // harness - which is exactly why it must not be billed: the host has already
  // said it cannot run that judge, so every command escalates to the human and
  // no pocket is touched.
  if (blocked !== null && blocked !== undefined) return BLOCKED_BILLING;
  // Then the client-side equivalent, AFTER the provider-native arm for exactly
  // the same reason the host's blocker is: a provider running its own
  // classifier does not consult Traycer's stored judge, so a vanished profile
  // on that record describes a call that was never going to happen.
  if (judgeProfileUnavailable) return BLOCKED_BILLING;
  return autoJudgeBillingFor(judgeHarnessId);
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
 * The one-line disclosure on the composer's Auto row, so a user who never
 * opens Settings still learns which pocket is charged BEFORE turning the mode
 * on.
 */
export function autoJudgeMetaLine(billing: AutoJudgeBilling): string {
  if (billing.kind === "traycer") return "Uses your Traycer credits.";
  // Says what HAPPENS, not what is spent: "no judge" reads as a missing
  // setting, while a user about to turn Auto on needs to know the mode will
  // behave as if every command escalated. Same verb the approval card uses
  // when a judge could not run ("so it's asking you instead").
  if (billing.kind === "blocked") {
    return "No judge can run on this machine, so Auto mode will ask you.";
  }
  if (billing.kind === "provider-native") {
    return `Reviewed by ${billing.harnessLabel}'s own classifier — no extra cost.`;
  }
  return `Uses your ${billing.harnessLabel} account.`;
}

/**
 * The self-billing warning shown at selection time in Settings, or `null` when
 * the judge is Traycer's own and nothing of the user's is being spent.
 *
 * "On top of your chat replies" is the clause that must not be dropped: the
 * sharpest case is a user picking the SAME harness for chat and judge, which is
 * the natural thing to reach for and doubles the spend on one account.
 */
export function autoJudgeSelfBillingWarning(
  billing: AutoJudgeBilling,
): string | null {
  if (billing.kind === "traycer") return null;
  // Nothing extra is spent, so there is nothing to warn about. Unreachable
  // from Settings, whose picker builds its billing from the stored selection
  // alone - the branch exists so the union stays exhaustive if that changes.
  if (billing.kind === "provider-native") return null;
  // Nothing is spent when nothing runs.
  if (billing.kind === "blocked") return null;
  // NO PER-COMMAND CALL COUNT. Both sentences used to promise "one per command
  // reviewed", and the host's judge is not one call: `AutoJudgeService.runStages`
  // invokes the adapter for stage 1 and invokes it AGAIN for stage 2 whenever
  // stage 1 answers `yes` or `unsure`, while a cache hit can skip the call
  // altogether. A number a user can multiply is worse than no number when the
  // pipeline can spend two or zero.
  //
  // The claim that survives is the one the warning exists for: this spends the
  // user's own provider allowance rather than Traycer's, and it is spent on top
  // of the chat itself. The Copilot line keeps its ORDER-OF-MAGNITUDE range,
  // which was measured over real sessions rather than derived from one call per
  // command, and now says so.
  if (billing.harnessId === COPILOT_JUDGE_HARNESS_ID) {
    return "Judge calls are Copilot premium requests, charged to your monthly allowance — an hour of Auto mode can use 60–350 of it.";
  }
  return `Judge calls use your own ${billing.harnessLabel} account, on top of your chat replies — a reviewed command can take more than one call.`;
}
