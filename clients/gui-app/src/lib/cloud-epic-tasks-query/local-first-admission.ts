import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * The minor at which `epic.listTasks` gained `localFirstPhase` - the directive
 * that makes the initial leg a LOCAL read the host answers off this machine's
 * disk, and the one that lets it report `cloudPage: "pending"` so the
 * separately-authorized revalidation can take over.
 */
export const LIST_TASKS_LOCAL_FIRST_MINOR = 6;

/**
 * Whether the negotiated host actually honours the local-first initial leg.
 *
 * This is what keeps the widened admission from becoming a silent cloud spend,
 * and the mechanism is easy to miss because the REQUEST looks identical either
 * way: `dispatchScopedPageWithCurrentRequestContext` always sends
 * `localFirstPhase`, but a pre-`@1.6` peer parses it against a frozen request
 * schema that STRIPS the field (`lib/cloud-epic-tasks-query/query.ts`). What
 * that host then runs is the released one-shot cloud-backed list, on the
 * retained credential - and because its response cannot carry
 * `cloudPage: "pending"`, the revalidation gate that exists to prevent exactly
 * this spend is never consulted. The spend happens on the FIRST leg, under a
 * flag the host silently discarded.
 *
 * So an unverified session must decide before it constructs the request, from
 * the negotiated version rather than from anything in the response. Three
 * callers make that decision and share this one predicate so they cannot
 * drift: `useCloudEpicTasksQuery` (the component's own leg), the `/epics` and
 * epic-tab route loaders (the prefetch of that same leg), and the landing
 * composer (whether an unverified session may CREATE on this host at all - a
 * host on the local-first `listTasks` line is the host on the local-first
 * create line, and `epic.create` itself advertises no version to ask).
 *
 * FAILS CLOSED on both non-version answers, and they are different facts that
 * happen to warrant the same refusal here:
 *  - `false` - the host handshook and does not advertise the method at all.
 *  - `null` - unknown: no handshake yet, no bound host, or a name-only legacy
 *    manifest record. `useHostNegotiatedMethodVersion` keeps these separate
 *    precisely so a decision that could STRAND data does not assert absence
 *    without evidence; this one strands nothing, because the manifest arriving
 *    re-renders the hook and the query enables itself the moment the host says
 *    `1.6`.
 *
 * An authorized (`signed-in`) session never reaches this test - it may spend
 * the capability whatever the peer's minor is - so legacy behavior for the
 * signed-in cohort is unchanged.
 */
export function negotiatedListTasksServesLocalFirst(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return version.major === 1 && version.minor >= LIST_TASKS_LOCAL_FIRST_MINOR;
}
