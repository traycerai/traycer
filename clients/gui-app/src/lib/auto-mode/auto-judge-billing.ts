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
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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

export type AutoJudgeBilling =
  | { readonly kind: "traycer" }
  | {
      readonly kind: "provider";
      readonly harnessId: string;
      readonly harnessLabel: string;
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
    };

const TRAYCER_BILLING: AutoJudgeBilling = { kind: "traycer" };

/**
 * The billing shape of the host's stored judge selection. `null` - the record
 * is unset - resolves to `traycer`, because that is exactly what the host
 * falls back to, and it is what makes auto mode cost credits before anyone
 * opens Settings.
 */
export function autoJudgeBillingFor(
  harnessId: string | null,
): AutoJudgeBilling {
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
}): AutoJudgeBilling {
  const { judgeHarnessId, runHarnessId, isProviderNative } = input;
  if (!isProviderNative || runHarnessId === null) {
    return autoJudgeBillingFor(judgeHarnessId);
  }
  return {
    kind: "provider-native",
    harnessId: runHarnessId,
    harnessLabel: judgeHarnessLabel(runHarnessId),
  };
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
}): boolean {
  const { harnessId, providers } = input;
  if (harnessId === null || providers === undefined) return false;
  const providerId = guiHarnessIdToProviderId(harnessId);
  if (providerId === null) return false;
  const state = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (state === undefined) return false;
  return providerAutoJudgeFor(state) === "provider";
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
  if (billing.harnessId === COPILOT_JUDGE_HARNESS_ID) {
    return "Judge calls are Copilot premium requests — one per command reviewed, so an hour of Auto mode can use 60–350 of your monthly allowance.";
  }
  return `Judge calls use your own ${billing.harnessLabel} account, once per command reviewed — on top of your chat replies.`;
}
