/** Locate-on-absent for a bound owner path: never delete the old binding until at least one distinct add has
 * succeeded. */
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
  /** Distinct from `replaced` because the absent path is still bound. */
  | {
      readonly kind: "replaced-stale-entry";
      readonly retainedPath: string;
      readonly addedPaths: ReadonlyArray<string>;
    };

export async function locateReplaceBoundFolder(args: {
  readonly absentPath: string;
  /** Non-null with empty `folders` is a wire-valid empty pick that must not touch the binding. */
  readonly pick: {
    readonly folders: ReadonlyArray<{ readonly workspacePath: string }>;
  } | null;
  readonly add: (workspacePath: string) => Promise<boolean>;
  readonly remove: (workspacePath: string) => Promise<boolean>;
}): Promise<LocateReplaceBoundOutcome> {
  if (args.pick === null) return { kind: "cancelled" };
  if (args.pick.folders.length === 0) return { kind: "noop-empty" };

  // Distinct in both senses: not the dead entry, and not a path this pick already yielded.
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

  // Add distinct paths first - never remove the dead entry until one lands.
  const addedPaths: string[] = [];
  for (const folder of distinct) {
    // Sequential: binding writes race on the single owner row.
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- sequential binding writes required
    const ok = await args.add(folder.workspacePath);
    if (ok) addedPaths.push(folder.workspacePath);
  }

  if (addedPaths.length > 0) {
    // Swallowing a failed remove and still answering `replaced` reports a binding state that is not the one on
    // disk.
    const removed = await args.remove(args.absentPath);
    return removed
      ? { kind: "replaced", removedPath: args.absentPath, addedPaths }
      : {
          kind: "replaced-stale-entry",
          retainedPath: args.absentPath,
          addedPaths,
        };
  }

  // Same-path re-pick only: the binding entry is already that path - do not delete-then-re-add (would risk a
  // transient empty binding).
  if (hasSamePathPick) return { kind: "same-path-only" };

  return { kind: "noop-all-failed" };
}
