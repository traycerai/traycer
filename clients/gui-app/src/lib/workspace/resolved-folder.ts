import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `resolved`: the bound host knows this repo at `path`.
 * The chip uses `path` for `worktree.*` calls.
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
