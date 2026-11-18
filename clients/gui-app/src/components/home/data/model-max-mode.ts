import type { ModelOption } from "@/components/home/data/landing-options";
import { guiAgentModelMaxModeSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";

export type MaxModeContext =
  | {
      kind: "chat";
      tuple: {
        reasoningEffort: string | null;
        serviceTier: string | null;
      } | null;
    }
  | { kind: "judge"; reasoningEffort: string | null }
  | { kind: "none" };

const MAX_MODE_COPY =
  "Cursor lists this choice as Max Mode only, which uses a larger context window. On legacy request-based Cursor plans, Max Mode is billed at a higher rate.";

export function maxModeTooltipCopy(): string {
  return MAX_MODE_COPY;
}

/** The two toolbar values after the same normalization as a sent chat tuple. */
export function chatMaxModeContextForToolbar(
  reasoningEffort: string,
  serviceTier: string,
): MaxModeContext {
  const tier = serviceTier.trim();
  return {
    kind: "chat",
    tuple: {
      reasoningEffort: reasoningEffort.length === 0 ? null : reasoningEffort,
      serviceTier: tier.length === 0 ? null : tier,
    },
  };
}

function effectiveEffort(
  model: ModelOption,
  effort: string | null,
): string | null {
  return model.supportedReasoningEfforts.some((option) => option.id === effort)
    ? effort
    : null;
}

export function maxModeListedFor(
  model: ModelOption | null,
  context: MaxModeContext,
): boolean {
  if (model === null || model.harnessId !== "cursor" || context.kind === "none")
    return false;
  const parsed = guiAgentModelMaxModeSchema.safeParse(model.metadata.maxMode);
  if (!parsed.success) return false;
  const maxMode = parsed.data;
  if (context.kind === "judge") {
    const reasoningEffort = effectiveEffort(model, context.reasoningEffort);
    return maxMode.judge.some((key) => key.reasoningEffort === reasoningEffort);
  }
  if (context.tuple === null) return false;
  const reasoningEffort = effectiveEffort(model, context.tuple.reasoningEffort);
  const fast =
    maxMode.fastServiceTierId !== null &&
    context.tuple.serviceTier?.trim() === maxMode.fastServiceTierId;
  return maxMode.chat.some(
    (key) => key.reasoningEffort === reasoningEffort && key.fast === fast,
  );
}

export function maxModeOnlyRow(
  model: ModelOption,
  contextKind: MaxModeContext["kind"],
): boolean {
  if (model.harnessId !== "cursor" || contextKind === "none") return false;
  const parsed = guiAgentModelMaxModeSchema.safeParse(model.metadata.maxMode);
  if (!parsed.success) return false;
  const efforts = [
    null,
    ...model.supportedReasoningEfforts.map((option) => option.id),
  ];
  if (contextKind === "judge") {
    return efforts.every((reasoningEffort) =>
      parsed.data.judge.some((key) => key.reasoningEffort === reasoningEffort),
    );
  }
  const fastValues =
    parsed.data.fastServiceTierId === null ? [false] : [false, true];
  return efforts.every((reasoningEffort) =>
    fastValues.every((fast) =>
      parsed.data.chat.some(
        (key) => key.reasoningEffort === reasoningEffort && key.fast === fast,
      ),
    ),
  );
}
