/**
 * Locate-on-absent for a BOUND owner path: never delete the old binding until
 * at least one DISTINCT add has succeeded. Cancel / empty pick / all-adds-fail
 * leave the absent entry in place. A same-path re-pick is a no-op (entry stays).
 *
 * Pure over injected `add`/`remove` so unit tests can exercise the fallible
 * mutation outcomes without mounting the full selector.
 */
export type LocateReplaceBoundOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "noop-empty" }
  | { readonly kind: "noop-all-failed" }
  | { readonly kind: "same-path-only" }
  | {
      readonly kind: "replaced";
      readonly removedPath: string;
      readonly addedPaths: ReadonlyArray<string>;
    }
  /**
   * Adds landed but the old entry could NOT be dropped. Distinct from
   * `replaced` because the absent path is still bound: reporting it as removed
   * would have the caller commit a replacement that only half happened, while
   * the dead entry keeps blocking owner readiness and the UI says Locate is
   * done. The adds are real, so the caller still commits THOSE - the absent row
   * stays for a retry.
   */
  | {
      readonly kind: "replaced-stale-entry";
      readonly retainedPath: string;
      readonly addedPaths: ReadonlyArray<string>;
    };

export async function locateReplaceBoundFolder(args: {
  readonly absentPath: string;
  /**
   * `null` = user cancelled the picker. Non-null with empty `folders` is a
   * wire-valid empty pick that must not touch the binding.
   */
  readonly pick: {
    readonly folders: ReadonlyArray<{ readonly workspacePath: string }>;
  } | null;
  readonly add: (workspacePath: string) => Promise<boolean>;
  readonly remove: (workspacePath: string) => Promise<boolean>;
}): Promise<LocateReplaceBoundOutcome> {
  if (args.pick === null) return { kind: "cancelled" };
  if (args.pick.folders.length === 0) return { kind: "noop-empty" };

  // Distinct in BOTH senses: not the dead entry, and not a path this pick
  // already yielded. A picker is free to return the same folder twice (a
  // multi-select over two symlinked entries does), and without the second
  // filter each repeat issued its own binding write and its own failure
  // toast for a row that was already added.
  const seenPaths = new Set<string>();
  const distinct = args.pick.folders.filter((folder) => {
    if (folder.workspacePath === args.absentPath) return false;
    if (seenPaths.has(folder.workspacePath)) return false;
    seenPaths.add(folder.workspacePath);
    return true;
  });
  const hasSamePathPick = args.pick.folders.some(
    (folder) => folder.workspacePath === args.absentPath,
  );

  // Add DISTINCT paths first — never remove the dead entry until one lands.
  const addedPaths: string[] = [];
  for (const folder of distinct) {
    // Sequential: binding writes race on the single owner row.
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- sequential binding writes required
    const ok = await args.add(folder.workspacePath);
    if (ok) addedPaths.push(folder.workspacePath);
  }

  if (addedPaths.length > 0) {
    // The adds already succeeded, so the workspace is recoverable either way -
    // but the OUTCOME has to say which happened. Swallowing a failed remove
    // and still answering `replaced` reports a binding state that is not the
    // one on disk.
    const removed = await args.remove(args.absentPath);
    return removed
      ? { kind: "replaced", removedPath: args.absentPath, addedPaths }
      : {
          kind: "replaced-stale-entry",
          retainedPath: args.absentPath,
          addedPaths,
        };
  }

  // Same-path re-pick only: the binding entry is already that path — do not
  // delete-then-re-add (would risk a transient empty binding).
  if (hasSamePathPick) return { kind: "same-path-only" };

  return { kind: "noop-all-failed" };
}
