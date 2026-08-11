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

  const distinct = args.pick.folders.filter(
    (folder) => folder.workspacePath !== args.absentPath,
  );
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
    // Best-effort remove of the old path; adds already succeeded so the
    // workspace is recoverable even if remove fails.
    await args.remove(args.absentPath);
    return {
      kind: "replaced",
      removedPath: args.absentPath,
      addedPaths,
    };
  }

  // Same-path re-pick only: the binding entry is already that path — do not
  // delete-then-re-add (would risk a transient empty binding).
  if (hasSamePathPick) return { kind: "same-path-only" };

  return { kind: "noop-all-failed" };
}
