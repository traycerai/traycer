/**
 * Matching a worktree path the client HOLDS against the spelling the host
 * ANSWERS or PUBLISHES under.
 *
 * The host keys every worktree by the lexical `path.resolve` of its path, and
 * a selection-mode `worktree.listAllForHost` row carries `path.resolve` of the
 * REQUESTED spelling (traycer-host `WorktreeService.getManagedWorktreeAtPath`,
 * which the per-path `worktree.changed` frames then echo). For every path the
 * client took from a listing row that is the requested string itself, so exact
 * equality is the rule and the fast path.
 *
 * It is not guaranteed for a path taken from a BINDING: an explicit
 * `worktree.import` entry is persisted exactly as the caller sent it, so a
 * CLI-typed `/…/worktrees/<group>/<slug>/` binds with its trailing slash while
 * the host answers and publishes without it. Those are the only spellings the
 * fallback here exists for.
 */

/**
 * The host's lexical key for an ABSOLUTE path - what Node's `path.resolve`
 * does to it - or `null` when that cannot be decided from the string alone (a
 * relative path resolves against the host's own cwd; a UNC path has its own
 * root rules). Mirrors only equivalences `path.resolve` itself applies:
 * repeated separators, `.` and `..` segments, a trailing separator, and on a
 * drive-letter path `/` for `\`. So two paths this calls equal are equal to the
 * host too; the reverse need not hold, and a miss only means no match.
 */
export function lexicalWorktreePathKey(worktreePath: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(worktreePath)) {
    const segments = resolvedSegments(worktreePath.slice(3).split(/[\\/]/));
    return `${worktreePath.slice(0, 2)}\\${segments.join("\\")}`;
  }
  if (worktreePath.startsWith("/")) {
    return `/${resolvedSegments(worktreePath.split("/")).join("/")}`;
  }
  return null;
}

function resolvedSegments(parts: readonly string[]): readonly string[] {
  const segments: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments;
}

/**
 * Whether `candidate` names the same worktree as any of `paths`: byte-equal,
 * or equal under {@link lexicalWorktreePathKey}.
 */
export function worktreePathMatcher(
  paths: ReadonlySet<string>,
): (candidate: string) => boolean {
  const keys = new Set<string>();
  for (const worktreePath of paths) {
    const key = lexicalWorktreePathKey(worktreePath);
    if (key !== null) keys.add(key);
  }
  return (candidate) => {
    if (paths.has(candidate)) return true;
    if (keys.size === 0) return false;
    const key = lexicalWorktreePathKey(candidate);
    return key !== null && keys.has(key);
  };
}

/**
 * Selection-mode rows grouped under the path each was REQUESTED as: the row
 * whose `worktreePath` is byte-equal to the request, else the rows equal to it
 * under {@link lexicalWorktreePathKey}, else none (the host omits a path it
 * cannot find on disk). A request the host deduplicated with another spelling
 * of the same worktree gets that worktree's row too.
 */
export function rowsByRequestedPath<
  Row extends { readonly worktreePath: string },
>(
  requestedPaths: readonly string[],
  rows: readonly Row[],
): ReadonlyMap<string, readonly Row[]> {
  const byExact = groupBy(rows, (row) => row.worktreePath);
  const byLexical = groupBy(rows, (row) =>
    lexicalWorktreePathKey(row.worktreePath),
  );
  const byRequested = new Map<string, readonly Row[]>();
  for (const requested of requestedPaths) {
    const exact = byExact.get(requested);
    if (exact !== undefined) {
      byRequested.set(requested, exact);
      continue;
    }
    const key = lexicalWorktreePathKey(requested);
    byRequested.set(requested, key === null ? [] : (byLexical.get(key) ?? []));
  }
  return byRequested;
}

function groupBy<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string | null,
): ReadonlyMap<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [row]);
    else bucket.push(row);
  }
  return grouped;
}
