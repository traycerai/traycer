import type { QueryClient } from "@tanstack/react-query";
import { currentBotLifetime } from "@/lib/bots/bot-lifetime";
import { lastingHostRefusal } from "@/lib/host/lasting-host-refusal";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Who may read what a bot read retains through a later failure: the account
 * whose request fetched it, in the bot lifetime that fetch started in. Bot
 * data from an earlier lifetime is retired, not partitioned
 * (`bot-lifetime.ts`): after A, B, A, what A fetched before the first change
 * is withheld under a later failure until a fetch started since answers.
 *
 * Only a fetch's own answer is marked, for the account the app read as when
 * that fetch started, and only in the bot lifetime it started in
 * (`currentBotLifetime()`): no change of account since, A, B, A included. A
 * fetch's retry sends its request again later, under whichever account is
 * signed in then, so an answer that settles after an account change, its
 * retry's wait included, is marked for no one, and its rows are withheld
 * under a later failure until a fetch started since answers. A write to the
 * cache (`setQueryData`, a patch, an optimistic write or its rollback) never
 * marks: it does not re-authorize the rows it carries over. A lasting refusal (signed out, no access, a host that
 * cannot serve the bot) takes the mark away, so a later recoverable failure -
 * a server error, a cloud drop, a host that does not answer - never shows
 * again rows the person lost access to. Scoped to the account and the
 * lifetime because the cache keys bot reads by host and method alone and an
 * account change only marks them stale.
 *
 * Each read holds at most one marked answer, its latest fetched one, and
 * every fetched answer retires the one before it, marked or not: an earlier
 * answer a write puts back is not readable again.
 */
/** Per marked answer: who fetched it, and in which bot lifetime. */
const readableBy = new WeakMap<object, Requester>();
/** Per read: its marked answer. */
const markedAnswer = new WeakMap<object, object>();
/**
 * Who started a read's fetch in flight: the account, and the bot lifetime it
 * started in. The request context and the store change in one synchronous
 * step (`AuthService`), so a fetch records the account its request goes out
 * as.
 */
interface Requester {
  readonly viewer: string | null;
  readonly lifetime: number;
}
/** Per read: who started its fetch in flight. */
const requestedBy = new WeakMap<object, Requester>();

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
      requestedBy.set(query, {
        viewer: currentViewer(),
        lifetime: currentBotLifetime(),
      });
      return;
    }
    if (action.type === "error") {
      if (lastingHostRefusal(action.error) !== null) unmark(query);
      return;
    }
    if (action.type !== "success" || action.manual === true) return;
    // A fetched answer retires the one marked before it, before it is known
    // whether it is marked itself: an answer marked for no one leaves no
    // earlier mark behind, whether the cache kept that earlier object for an
    // equal answer or a write later puts it back.
    unmark(query);
    const data: unknown = event.query.state.data;
    const requester = requestedBy.get(query);
    if (
      typeof data !== "object" ||
      data === null ||
      requester === undefined ||
      requester.lifetime !== currentBotLifetime()
    ) {
      return;
    }
    readableBy.set(data, requester);
    markedAnswer.set(query, data);
  });
}

/**
 * Whether `viewer`, reading in bot lifetime `lifetime`, may read `data`, a
 * bot read's retained answer: only the account that fetched it, and only in
 * the lifetime it was fetched in.
 */
export function retainedReadableBy(
  data: unknown,
  viewer: string | null,
  lifetime: number,
): boolean {
  if (typeof data !== "object" || data === null) return false;
  const fetchedBy = readableBy.get(data);
  return (
    fetchedBy !== undefined &&
    fetchedBy.viewer === viewer &&
    fetchedBy.lifetime === lifetime
  );
}
