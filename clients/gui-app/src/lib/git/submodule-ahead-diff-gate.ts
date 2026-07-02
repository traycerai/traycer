/**
 * The load-bearing gate for a submodule's "committed changes not recorded by
 * parent" (ahead-of-pin) diff.
 *
 * There is no GUI capability probe for host support, so an ahead-of-pin
 * `getFileDiff({ compareFromSha })` may only ever be issued from *current* v1.1
 * `submodules[].relation` metadata where `relation.state === "ahead"` (so the
 * recorded pin is present). The `compareFromSha` is therefore re-derived here
 * from fresh metadata on every render - never read from a persisted tile
 * payload. If fresh metadata no longer shows the submodule as `ahead` (an
 * old-host degrade downgrades to `submodules: []`, or the pin moved so the
 * file is no longer in `commitsAhead`), the gate closes and no request is made.
 * Otherwise the transport would silently strip `compareFromSha` for a v1.0 host
 * and return a wrong stage-based diff (plan §2.3).
 *
 * Pure and framework-free so the gating rule is exhaustively unit-testable.
 */
import type { CommitAheadFile, SubmoduleChangeset } from "@traycer/protocol/host";

/** The minimal fresh-metadata shape the gate needs: the nested `submodules[]`. */
export interface AheadDiffMetadata {
  readonly submodules: ReadonlyArray<SubmoduleChangeset>;
}

export type AheadDiffGate =
  /** Fresh metadata has not landed yet - show a loading state, issue nothing. */
  | { readonly status: "pending" }
  /**
   * Fresh metadata is present but does not currently support an ahead-of-pin
   * diff for this file (no matching submodule, not `ahead`, or the file is no
   * longer among the commits ahead). Issue nothing; surface a degraded state.
   */
  | { readonly status: "unavailable" }
  /**
   * Fresh metadata confirms the submodule is `ahead` and still lists this file.
   * `compareFromSha` / `submoduleHeadSha` come straight from that fresh relation.
   */
  | {
      readonly status: "ready";
      readonly compareFromSha: string;
      readonly submoduleHeadSha: string;
      readonly file: CommitAheadFile;
    };

/**
 * Resolve whether an ahead-of-pin diff for `(repoRoot, filePath)` may be issued,
 * using only the fresh v1.1 snapshot. `snapshot === null` means metadata is
 * still loading (`pending`). The submodule is matched by its canonical
 * `repoRoot`, which is exactly the tile's `runningDir`.
 */
export function resolveAheadDiffGate(
  snapshot: AheadDiffMetadata | null,
  repoRoot: string,
  filePath: string,
): AheadDiffGate {
  if (snapshot === null) return { status: "pending" };

  const submodule = snapshot.submodules.find(
    (candidate) => candidate.repoRoot === repoRoot,
  );
  if (submodule === undefined) return { status: "unavailable" };

  const { relation } = submodule;
  if (relation.state !== "ahead") return { status: "unavailable" };

  const file = relation.commitsAhead.files.find(
    (candidate) => candidate.path === filePath,
  );
  if (file === undefined) return { status: "unavailable" };

  return {
    status: "ready",
    compareFromSha: relation.recordedPinSha,
    submoduleHeadSha: relation.submoduleHeadSha,
    file,
  };
}
