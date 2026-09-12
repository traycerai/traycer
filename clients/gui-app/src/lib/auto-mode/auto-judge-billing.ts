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
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { ORDERED_PROVIDERS } from "@/lib/provider-ordering";

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
  if (billing.harnessId === COPILOT_JUDGE_HARNESS_ID) {
    return "Judge calls are Copilot premium requests — one per command reviewed, so an hour of Auto mode can use 60–350 of your monthly allowance.";
  }
  return `Judge calls use your own ${billing.harnessLabel} account, once per command reviewed — on top of your chat replies.`;
}
