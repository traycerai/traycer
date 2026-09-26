import type { ProviderNoticeReceiptStep } from "@traycer/protocol/persistence/epic/content-blocks";
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
