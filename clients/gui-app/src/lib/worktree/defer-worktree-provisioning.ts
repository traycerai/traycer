import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * The `epic.create` / `epic.createChat` minor that carries
 * `deferWorktreeProvisioning` (and therefore the whole async-provisioning
 * path). Both methods grew the field on the same minor of the same major.
 */
export const DEFER_WORKTREE_PROVISIONING_MINOR = 2;

/** The two creates that can carry the opt-in. */
export type DeferWorktreeProvisioningMethod = "epic.create" | "epic.createChat";

export interface DeferWorktreeProvisioningFacts {
  /** The PLACEMENT host - the machine this create is actually dispatched at. */
  readonly hostId: string;
  readonly method: DeferWorktreeProvisioningMethod;
  /** `initialMessage !== null` on the seed / request this submit is building. */
  readonly hasInitialMessage: boolean;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
  readonly worktreeIntent: WorktreeIntent | null;
}

/**
 * Whether this create should ship `deferWorktreeProvisioning: true` - the ONE
 * definition of the opt-in, shared by the landing composer and the in-epic
 * new-conversation modal so the two surfaces cannot drift.
 *
 * Four facts, three of them the host's own predicate (async worktree
 * provisioning §1) and the fourth the negotiated minor:
 *
 *  1. `initialMessage !== null`. Without one there is no queued row to seed, no
 *     setup card to anchor and nothing for the deferred drain to run.
 *  2. `workspaceMode !== "folderless"`. The resolver's folderless branch runs
 *     FIRST and resolves an empty intent whatever `worktreeIntent` holds, so
 *     that path stays synchronous by construction.
 *  3. At least one `kind: "worktree"` entry in the intent. A plain local-folder
 *     create has no `git worktree add` to move off the response path, so it
 *     ships no field and - crucially - holds nothing, which is what
 *     `heldForDeferredCreate` has to mean.
 *  4. The negotiated minor is >= `@1.2` for the method being dispatched.
 *
 * FAILS CLOSED on both non-version answers, which are different facts warranting
 * the same verdict here: `null` (no handshake yet, no bound client, or a
 * name-only legacy manifest record) and `false` (the host handshook and does not
 * advertise the method). Either way the field is not shipped, no marker entry is
 * held, and the create is provisioned synchronously - byte-identically to today.
 *
 * Shipping it against an older host would not itself be unsafe (the request leg
 * strips an unknown key against that minor's own request schema), but the
 * MARKER is not stripped, and holding an epic's binding listing for 150 s
 * against a host that provisioned inside the response is a hold with no
 * provisioning window to cover.
 */
export function shouldDeferWorktreeProvisioning(
  facts: DeferWorktreeProvisioningFacts,
): boolean {
  if (!facts.hasInitialMessage) return false;
  if (facts.workspaceMode === "folderless") return false;
  if (facts.worktreeIntent === null) return false;
  if (
    !facts.worktreeIntent.entries.some((entry) => entry.kind === "worktree")
  ) {
    return false;
  }
  const version = readNegotiatedMethodVersion(facts.hostId, facts.method);
  if (version === null || version === false) return false;
  return (
    version.major === 1 && version.minor >= DEFER_WORKTREE_PROVISIONING_MINOR
  );
}
