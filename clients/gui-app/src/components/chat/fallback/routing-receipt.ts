import type {
  ProviderNoticeDetail,
  ProviderNoticeReceipt,
  ProviderNoticeReceiptStep,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { formatWaitTime } from "@/lib/relative-time";
import {
  fallbackHarnessForProviderLabel,
  type FallbackModelLabelResolver,
} from "./fallback-identity";

/**
 * Whether a receipt crosses providers - and so names the provider on every
 * line. The route line's rule, for the same reason: within one provider it is
 * the same word on every line, and a receipt that names it anyway buries the
 * part that changed.
 */
export function receiptCrossesProviders(
  steps: ReadonlyArray<ProviderNoticeReceiptStep>,
): boolean {
  return new Set(steps.map((step) => step.providerLabel)).size > 1;
}

/**
 * What one receipt step did, in the user's words: "Switched to Fable · Surya",
 * "Retried Fable · Surya", "Waited until 1:02 am for Personal 3".
 *
 * A wait line says what the wait was FOR and never that it resumed: the host
 * records a wait whose resume it refused (the account or model became unusable
 * before the deadline) as a `wait` step too, with `resumedAt` the time the
 * wait fired. What happened next is the row's `endedLabel` - the resumed
 * attempt's failure, or the refusal sentence - so the line claiming a resume
 * would contradict its own ending column.
 *
 * The step's `modelLabel` is the raw slug - the host does not read the
 * catalogue on the settle path - so it is named through the same resolver
 * every other routing surface uses, keyed by the harness its provider label
 * maps back to. A provider this build does not know leaves the slug a slug.
 * `providerLabel` and `profileLabel` are the host's display strings and are
 * printed as they are.
 *
 * `unknown` is a kind a newer host wrote that this build has no sentence for
 * (the wire reads it so rather than rejecting the whole message). It claims
 * no move - only that something was tried, and where - and names the provider
 * whatever the rest of the receipt does, because the provider-once rule rests
 * on knowing what each step was. The row's `endedLabel` still says how it
 * ended.
 */
export function receiptStepText(
  step: ProviderNoticeReceiptStep,
  context: {
    readonly modelLabelFor: FallbackModelLabelResolver;
    readonly crossesProviders: boolean;
    readonly now: number;
  },
): string {
  if (step.kind === "wait") {
    return step.resumedAt === null
      ? `Waited for the limit to reset on ${step.profileLabel}`
      : `Waited until ${formatWaitTime(step.resumedAt, context.now)} for ${step.profileLabel}`;
  }
  const harnessId = fallbackHarnessForProviderLabel(step.providerLabel);
  const model =
    harnessId === null
      ? step.modelLabel
      : context.modelLabelFor(harnessId, step.modelLabel);
  const tuple = context.crossesProviders
    ? `${step.providerLabel} · ${model} · ${step.profileLabel}`
    : `${model} · ${step.profileLabel}`;
  switch (step.kind) {
    case "switch":
      return `Switched to ${tuple}`;
    case "retry":
      return `Retried ${tuple}`;
    case "unknown":
      return `Tried ${step.providerLabel} · ${model} on ${step.profileLabel}`;
  }
}

/** The report's own label for the receipt's cause line. */
const REPORT_CAUSE_LABEL = "Cause";

/**
 * The settled notice as a bug report reads it: the raw record, one row per
 * line, appended to the error the report already carries.
 *
 * This is what the settled card's "Details for a bug report" disclosure used
 * to draw (clutter cuts, 2026-09-27: the debug icon is now the card's one
 * bug-report affordance). RAW on purpose, unlike {@link receiptStepText}: the
 * step's `kind` as written, the model slug unresolved, `resumedAt` as an ISO
 * instant rather than a local clock time - whoever reads the report is
 * matching it against host logs, not deciding what to do next.
 *
 * Every string here is host-RENDERED (see `providerNoticeReceiptStepSchema`),
 * never an id, and it travels only in the PRIVATE diagnostics cause - the
 * public prefill stays null-bodied, as it does for the error it rides beside.
 *
 * ## One fact, one line
 *
 * The host's detail rows are the raw record and win wherever they say the
 * same thing (drive, 2026-09-27: "Cause: Every step was tried" printed twice,
 * and each Step line restated the route its Hop row gave in full):
 *
 * - The receipt's cause is dropped when a row already carries it, by label or
 *   by value. It stays for a host that sent no such row.
 * - A Step line keeps its number, kind, account, resume time and ending - what
 *   the rows do not carry - and drops the provider and raw slug when a row
 *   already names that step's `harness/model`. A notice without such rows (an
 *   older host, a pruned record) keeps them.
 * - Backstop: an exact duplicate line is written once, first occurrence
 *   winning, so a future row cannot bring this back.
 *
 * Rows are matched by VALUE, never by the host's row labels ("Tried",
 * "Hop 1", "Failed on"): those are host-only literals this client does not
 * import, and a renamed row must not quietly bring the duplicate back.
 */
export function routingSettledReportText(notice: {
  readonly title: string;
  readonly message: string | null;
  readonly details: ReadonlyArray<ProviderNoticeDetail>;
  readonly receipt: ProviderNoticeReceipt;
}): string {
  const lines = [`Routing: ${notice.title}`];
  if (notice.message !== null && notice.message.length > 0) {
    lines.push(notice.message);
  }
  const causeLabel = notice.receipt.causeLabel;
  const causeCarried = notice.details.some(
    (detail) =>
      detail.label === REPORT_CAUSE_LABEL || detail.value === causeLabel,
  );
  if (!causeCarried) lines.push(`${REPORT_CAUSE_LABEL}: ${causeLabel}`);
  if (notice.receipt.steps.length === 0) {
    lines.push("Steps: none");
  }
  notice.receipt.steps.forEach((step, index) => {
    const fields = [
      step.kind,
      ...(detailsNameStepModel(step, notice.details)
        ? []
        : [step.providerLabel, step.modelLabel]),
      step.profileLabel,
      ...(step.resumedAt === null
        ? []
        : [`resumed at ${reportInstant(step.resumedAt)}`]),
      `ended: ${step.endedLabel}`,
    ];
    lines.push(`Step ${index + 1}: ${fields.join(" · ")}`);
  });
  for (const detail of notice.details) {
    lines.push(`${detail.label}: ${detail.value}`);
  }
  return [...new Set(lines)].join("\n");
}

/**
 * Whether a detail row already names this step's provider and raw model.
 *
 * The host writes a tuple into its rows as `harness/model`, then " (account)"
 * for a managed account ("claude/sonnet (Surya 2)"), and joins them with ", "
 * and " → ". So the step is named where `harness/model` stands as a whole
 * term: nothing but a space or the row's start before it, nothing but a
 * space, a comma or the row's end after it - "claude/sonnet" never matches
 * inside "claude/sonnet-4". A provider this build cannot map to a harness is
 * never matched, and its line keeps everything.
 */
function detailsNameStepModel(
  step: ProviderNoticeReceiptStep,
  details: ReadonlyArray<ProviderNoticeDetail>,
): boolean {
  const harnessId = fallbackHarnessForProviderLabel(step.providerLabel);
  if (harnessId === null) return false;
  const term = `${harnessId}/${step.modelLabel}`;
  return details.some((detail) => containsWholeTerm(detail.value, term));
}

function containsWholeTerm(text: string, term: string): boolean {
  for (
    let at = text.indexOf(term);
    at !== -1;
    at = text.indexOf(term, at + 1)
  ) {
    // `charAt` answers "" past either end, which counts as a boundary.
    const before = text.charAt(at - 1);
    const after = text.charAt(at + term.length);
    if (/^\s?$/.test(before) && /^[\s,]?$/.test(after)) return true;
  }
  return false;
}

/**
 * An epoch-ms instant as ISO, or the raw number where `Date` cannot represent
 * it - `toISOString` THROWS out of range, and this runs inside the report
 * click, where a throw would lose the whole report over one row.
 */
function reportInstant(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? String(epochMs) : date.toISOString();
}
