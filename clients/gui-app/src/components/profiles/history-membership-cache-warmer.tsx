import type { ReactNode } from "react";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { useHistoryQuery } from "@/hooks/home/use-history-query";

/**
 * Keeps the history membership cache warm app-wide so project-profile scoping
 * (tab-strip hide, switcher landing, auto-switch) works even before the user
 * visits a history surface. Shares the TanStack Query cache with the home and
 * /epics surfaces, so it adds no extra host fetch while those are mounted.
 * Host queries are null-gated, so it is safe to mount above host readiness.
 */
export function HistoryMembershipCacheWarmer(): ReactNode {
  useHistoryQuery({ search: DEFAULT_HISTORY_SEARCH, nowMs: null });
  return null;
}
