import type { QueryClient } from "@tanstack/react-query";
import { lastingHostRefusal } from "@/lib/host/lasting-host-refusal";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Who may read what a bot read retains through a later failure: the account
 * whose request fetched it.
 *
 * Only a fetch's own answer is marked, for the account the app read as when
 * that request started, so an answer that settles after an account change is
 * never the new account's. A write to the cache (`setQueryData`, a patch, an
 * optimistic write or its rollback) never marks: it does not re-authorize the
 * rows it carries over. A lasting refusal (signed out, no access, a host that
 * cannot serve the bot) takes the mark away, so a later recoverable failure -
 * a server error, a cloud drop, a host that does not answer - never shows
 * again rows the person lost access to. Scoped to the account because the
 * cache keys bot reads by host and method alone and an account change only
 * marks them stale.
 *
 * Each read holds at most one marked answer, its latest fetched one: an
 * earlier answer a write puts back is not readable again.
 */
const readableBy = new WeakMap<object, string | null>();
/** Per read: its marked answer. */
const markedAnswer = new WeakMap<object, object>();
/** Per read: the account its fetch in flight started under. */
const requestedBy = new WeakMap<object, string | null>();

/** The account the app reads as now; `null` signed out. */
function currentViewer(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

/** A host read of a bot method (`["host", hostId, "bot.<method>", …]`). */
export function isBotRead(queryKey: unknown): boolean {
  if (!Array.isArray(queryKey)) return false;
  const scope: unknown = queryKey[0];
  const method: unknown = queryKey[2];
  return (
    scope === "host" && typeof method === "string" && method.startsWith("bot.")
  );
}

function unmark(query: object): void {
  const marked = markedAnswer.get(query);
  if (marked !== undefined) readableBy.delete(marked);
  markedAnswer.delete(query);
}

/**
 * Install when the QueryClient is created, before any bot read can start:
 * the cache's own events run before any observer re-renders, so a view
 * drawn from an answer or a failure always sees its readability.
 */
export function installBotReadReadability(client: QueryClient): void {
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const queryKey: unknown = event.query.queryKey;
    if (!isBotRead(queryKey)) return;
    const query: object = event.query;
    const { action } = event;
    if (action.type === "fetch") {
      requestedBy.set(query, currentViewer());
      return;
    }
    if (action.type === "error") {
      if (lastingHostRefusal(action.error) !== null) unmark(query);
      return;
    }
    if (action.type !== "success" || action.manual === true) return;
    const data: unknown = event.query.state.data;
    if (typeof data !== "object" || data === null || !requestedBy.has(query)) {
      return;
    }
    unmark(query);
    readableBy.set(data, requestedBy.get(query) ?? null);
    markedAnswer.set(query, data);
  });
}

/** Whether `viewer` may read `data`, a bot read's retained answer. */
export function retainedReadableBy(
  data: unknown,
  viewer: string | null,
): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    readableBy.has(data) &&
    readableBy.get(data) === viewer
  );
}
