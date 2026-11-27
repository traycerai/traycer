import { z } from "zod";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";

/**
 * The raw call to traycer-server's `POST /api/notification-feed/entry-states`
 * with the user bearer: the read and cleared state of the Traycer
 * notifications a phone is showing, from the signed-in person's own feed.
 * Transport-only, a sibling of `sandbox-control.ts`. The phone calls it
 * directly, whatever computer it is connected to; no host is involved.
 *
 * Never throws: transport failures, non-2xx answers and malformed bodies
 * collapse into a discriminated result.
 */

/** Ids one request may name; the server refuses more. */
export const NOTIFICATION_ENTRY_STATES_MAX_IDS = 100;

const ENTRY_STATES_FETCH_TIMEOUT_MS = 10_000;

/** A feed entry id: the hyphenated 36-character UUID shape, any case. */
const ENTRY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const entryIdSchema = z.string().regex(ENTRY_ID_PATTERN);

const entryStateSchema = z.discriminatedUnion("state", [
  z.object({
    entryId: entryIdSchema,
    state: z.literal("found"),
    readAt: z.number().int().nonnegative().nullable(),
    clearedAt: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    entryId: entryIdSchema,
    state: z.literal("notFound"),
  }),
]);

const entryStatesResponseSchema = z.object({
  entries: z.array(entryStateSchema),
});

/**
 * One stored entry's answer, its id in canonical lowercase form. `notFound`
 * covers an id the person's feed never held and a row retention removed.
 */
export type NotificationEntryState = z.infer<typeof entryStateSchema>;

/**
 * - `ok`            — one answer per distinct well-formed id asked, in the
 *                     order first asked. Malformed ids are never sent and
 *                     have no answer.
 * - `unavailable`   — the server has no entry-states route (404): nothing
 *                     can be learned, so nothing should be removed.
 * - `unauthorized`  — the bearer was rejected (401/403).
 * - `network-error` — transport/timeout, any other status, or a body that
 *                     is not exactly an answer to each id asked. `detail` is
 *                     a stable classification, never a server body.
 */
export type NotificationEntryStatesFetchResult =
  | {
      readonly kind: "ok";
      readonly entries: ReadonlyArray<NotificationEntryState>;
    }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error"; readonly detail: string };

type ChunkResult =
  | {
      readonly kind: "ok";
      readonly entries: ReadonlyArray<NotificationEntryState>;
    }
  | Exclude<NotificationEntryStatesFetchResult, { readonly kind: "ok" }>;

/**
 * `entryId` as the server answers it, lowercased, or `null` for a malformed id,
 * which is never sent and never answered.
 */
export function canonicalNotificationEntryId(entryId: string): string | null {
  return ENTRY_ID_PATTERN.test(entryId) ? entryId.toLowerCase() : null;
}

/**
 * The ids as the server will answer them: lowercased, malformed ones dropped,
 * de-duplicated in first-seen order.
 */
function canonicalNotificationEntryIds(entryIds: readonly string[]): string[] {
  const canonical = new Set<string>();
  for (const entryId of entryIds) {
    const id = canonicalNotificationEntryId(entryId);
    if (id !== null) canonical.add(id);
  }
  return [...canonical];
}

export async function fetchNotificationEntryStatesViaHttp(
  serverBaseUrl: string,
  bearerToken: string,
  entryIds: readonly string[],
): Promise<NotificationEntryStatesFetchResult> {
  const ids = canonicalNotificationEntryIds(entryIds);
  const url = new URL(
    "api/notification-feed/entry-states",
    serverBaseUrl.endsWith("/") ? serverBaseUrl : `${serverBaseUrl}/`,
  ).toString();
  const entries: NotificationEntryState[] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += NOTIFICATION_ENTRY_STATES_MAX_IDS
  ) {
    const chunk = ids.slice(offset, offset + NOTIFICATION_ENTRY_STATES_MAX_IDS);
    const result = await fetchChunk(url, bearerToken, chunk);
    if (result.kind !== "ok") return result;
    entries.push(...result.entries);
  }
  return { kind: "ok", entries };
}

async function fetchChunk(
  url: string,
  bearerToken: string,
  chunk: readonly string[],
): Promise<ChunkResult> {
  const abort = composeRequestAbort(null, ENTRY_STATES_FETCH_TIMEOUT_MS);
  let status: number;
  let body: unknown = null;
  try {
    const response = await untilAborted(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entryIds: chunk }),
        signal: abort.signal,
        // The bearer rides in a header: never follow a redirect.
        redirect: "manual",
      }),
      abort.signal,
    );
    status = response.status;
    if (status >= 200 && status < 300) {
      const text = await untilAborted(response.text(), abort.signal);
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
  } catch {
    return {
      kind: "network-error",
      detail: "the entry-states request did not complete",
    };
  } finally {
    abort.clear();
  }

  if (status === 404) return { kind: "unavailable" };
  if (status === 401 || status === 403) return { kind: "unauthorized" };
  if (status < 200 || status >= 300) {
    return {
      kind: "network-error",
      detail: `the server answered HTTP ${status}`,
    };
  }
  const parsed = entryStatesResponseSchema.safeParse(body);
  if (!parsed.success || !answersExactly(parsed.data.entries, chunk)) {
    return {
      kind: "network-error",
      detail: "the entry states did not match the contract",
    };
  }
  return { kind: "ok", entries: parsed.data.entries };
}

/** Each id asked answered once, in canonical form and in the order asked. */
function answersExactly(
  entries: ReadonlyArray<NotificationEntryState>,
  asked: readonly string[],
): boolean {
  return (
    entries.length === asked.length &&
    entries.every((entry, index) => entry.entryId === asked[index])
  );
}
