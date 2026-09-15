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
 * The two `null` sides are NOT symmetric, and treating them as if they were is
 * what let a real overwrite through. `updatedAt: null` means two different
 * things depending on which side it is on:
 *
 * - **`currentUpdatedAt === null`** is "cannot tell". The protocol sends it both
 *   for a policy that was never saved and for one the host is serving from a
 *   cache it could not refresh, so a `timestamp -> null` transition is not
 *   evidence of a change. Warning there would train the user to dismiss the one
 *   warning that means something.
 * - **`loadedAt === null` with a concrete `currentUpdatedAt`** is the opposite:
 *   the editor opened on no policy, and there is one now. That is a CREATION by
 *   another device, and saving over it destroys a record this window never saw.
 *   It is exactly the case the refetch on open was added to catch, and the
 *   symmetric `null` check was swallowing it.
 *
 * `null -> null` stays `false`: nothing appeared.
 *
 * The residual imprecision is deliberate. A host serving a STALE read can
 * report `updatedAt: null` while the account does have a policy, so a
 * subsequent good read can trip this warning for a record that was there all
 * along. The sentence the user sees - saving now replaces that version - is
 * true either way, and the alternative is the silent overwrite. (An
 * `unreadable` read cannot reach here at all: the row refuses to open the
 * editor on one.)
 */
export function autoPolicyChangedSinceLoad(
  loadedAt: string | null,
  currentUpdatedAt: string | null,
): boolean {
  if (currentUpdatedAt === null) return false;
  if (loadedAt === null) return true;
  return loadedAt !== currentUpdatedAt;
}
