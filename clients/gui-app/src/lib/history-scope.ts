import { z } from "zod";

export type HistoryScope = "all" | "tasks" | "messages";

export const historyScopeParamsSchema = z.object({
  historyScope: z.enum(["all", "tasks", "messages"]).optional(),
});

export function parseHistoryScope(raw: Record<string, unknown>): HistoryScope {
  return raw.historyScope === "tasks" || raw.historyScope === "messages"
    ? raw.historyScope
    : "all";
}

export function historyScopeToParams(scope: HistoryScope): {
  historyScope?: HistoryScope;
} {
  return { historyScope: scope === "all" ? undefined : scope };
}
