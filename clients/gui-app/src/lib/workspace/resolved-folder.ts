import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `resolved`: the bound host knows this repo at `path`. The chip uses
 * `path` for `worktree.*` calls.
 *
 * `local-only`: the user added a non-git or unidentified folder on
 * this host; cross-host resolution doesn't apply.
 *
 * `unresolved`: stored on this device but the bound host doesn't
 * have the repo at `path`. Renders dimmed with a "Locate on this
 * host..." affordance.
 *
 * `name` is the folder basename - primary text on the folder row. Two
 * clones of the same repo at different paths land on the same
 * `owner/repo`, so the basename keeps rows visually distinct; the
 * full path goes in the sub-text.
 */
export type ResolvedFolder =
  | {
      readonly kind: "resolved";
      readonly path: string;
      readonly name: string;
      readonly repoIdentifier: TaskRepoIdentifier;
    }
  | {
      readonly kind: "local-only";
      readonly path: string;
      readonly name: string;
    }
  | {
      readonly kind: "unresolved";
      readonly path: string;
      readonly name: string;
      /** Null when a non-git folder is foreign/legacy and has no repo identity. */
      readonly repoIdentifier: TaskRepoIdentifier | null;
    };
