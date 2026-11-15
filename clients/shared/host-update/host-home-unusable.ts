/**
 * The canonical host home cannot be created because a regular file sits on its
 * path: Node reports ENOTDIR when an ancestor is the file, EEXIST when the
 * home itself is. Only the person can clear it, and nothing the update
 * machinery does would be safe over it, so it is a typed refusal rather than
 * the raw filesystem error. The message carries no path - it contains the
 * account's user name.
 */
export class UpdateHostHomeUnusableError extends Error {
  constructor(cause: unknown) {
    super("the host home folder cannot be created: a file is in the way", {
      cause,
    });
    this.name = "UpdateHostHomeUnusableError";
  }
}

export function isHostHomeBlockedByFile(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, "code");
  return code === "ENOTDIR" || code === "EEXIST";
}
