/**
 * The write predicate over an epic permission role, in the one place both the
 * lane adapters and the renderer can reach.
 *
 * It is three words of logic and it is worth a module because of the direction
 * it must fail in. The shared seam states the rule on the control event it
 * feeds: an adapter that cannot tell whether the caller may write must answer
 * `false`, because the consequence of a wrong `true` is a write queued against
 * an epic the user has lost access to. A copy of this predicate that drifted
 * open - by adding a role, or by reading `null` as "probably fine" - fails in
 * exactly that direction, and nothing downstream would notice until a mutation
 * was refused by the host.
 *
 * `null` is NOT "no access" in the wire's vocabulary; it is "the host cannot
 * currently attribute a role". Both readings are unwritable, which is why one
 * predicate can serve them, but a caller that needs to tell them apart must
 * read the role itself.
 */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Whether `role` may write to the epic.
 *
 * Written as an inclusion test over the two writable roles rather than as an
 * exclusion of `"viewer"`: a fourth role added to the enum lands as
 * non-writable, which is the safe default, where an exclusion test would grant
 * it write access silently.
 */
export function isWritablePermissionRole(role: PermissionRole | null): boolean {
  return role === "owner" || role === "editor";
}
