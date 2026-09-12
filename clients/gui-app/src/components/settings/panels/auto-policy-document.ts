/**
 * The account auto-mode policy as a DOCUMENT: the shape a fresh one starts
 * from, the size the server will accept, and the one question the editor asks
 * about staleness.
 *
 * Split out of `auto-policy-editor-dialog.tsx` because a module that exports a
 * component may export nothing else - fast refresh replaces the whole module,
 * so a helper living beside a component is re-created on every edit and
 * `react(only-export-components)` fails the build over it. These are also the
 * pieces worth testing without rendering anything.
 */
import type {
  AutoPolicyGetResponse,
  AutoPolicyReadState,
} from "@traycer/protocol/host/auto-mode/contracts";

/**
 * How far the host's answer can be trusted, with the one fallback an older
 * host forces spelled in exactly one place.
 *
 * `readState` rode into `autoPolicy.get@1.0` IN PLACE rather than on a minor of
 * its own, so the negotiated version does not say whether the host on the other
 * end fills it: a response without the property is a host whose resolver
 * predates it. `fresh` is the only honest answer for that host - it reproduces
 * this panel's behaviour before the field existed, and the two states it stands
 * in for ("stale", "unreadable") are ones that host cannot detect either. The
 * same shape as `providerAutoJudgeFor`'s `?? "traycer"`, for the same reason.
 */
export function autoPolicyReadStateFor(
  response: AutoPolicyGetResponse,
): AutoPolicyReadState {
  return response.readState ?? "fresh";
}

/**
 * The four headings the judge's prompt builder reads a policy under. Prefilled
 * for an empty policy and nothing more: the guidance about what belongs under
 * each one is the dialog's copy, not the document's, because every byte of the
 * document is prose the judge will read.
 *
 * Heading DEPTH does not matter to the parser (any `#`..`######` is accepted,
 * as are `Soft-deny` / `SOFT DENY` spellings), and text under no heading is
 * kept too, so a user who rewrites this from scratch loses nothing.
 */
export const AUTO_POLICY_TEMPLATE = `## Environment

## Allow

## Soft deny

## Hard deny
`;

/**
 * The server's cap on a policy body, in UTF-8 BYTES.
 *
 * Restated here because the authoritative constant lives in the closed-source
 * service and reaches no client contract - `autoPolicy.set` carries a plain
 * string. This is therefore a courtesy pre-flight, not the enforcement: the
 * server refuses an oversized body regardless, and this only spares the user a
 * round-trip and a toast for something the editor could see coming. Bytes, not
 * characters: `String.length` counts UTF-16 code units and would let a policy
 * written in a non-Latin script past a check the server then fails.
 */
export const AUTO_POLICY_MAX_BYTES = 64 * 1024;

export function autoPolicyByteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * Whether the record moved under the editor while it was open.
 *
 * `null` on either side answers `false`, and that is the load-bearing part: the
 * protocol sends `updatedAt: null` both for a policy that was never saved AND
 * for one the host is serving from a cache it could not refresh. Neither is
 * evidence of a change, and warning on "cannot tell" would train the user to
 * dismiss the one warning that means something.
 */
export function autoPolicyChangedSinceLoad(
  loadedAt: string | null,
  currentUpdatedAt: string | null,
): boolean {
  if (loadedAt === null || currentUpdatedAt === null) return false;
  return loadedAt !== currentUpdatedAt;
}
