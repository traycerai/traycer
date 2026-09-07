import type { FileTreeRevealRequest } from "@/stores/file-tree/file-tree-reveal-store";

/**
 * Pure so the routing rules are testable without the panel's pin, bindings query, or stores. - `pin-host`: the panel resolves to another host; pin it to the file's. - `drop`: the request cannot be served - the file's host is pinned yet the panel still resolves elsewhere (the host cannot serve: dead, or since deregistered so the fleet guard cleared the pin), or the file's root is not a browsable root of this host (a synthesized out-of-root workspace, or a binding since removed).
 */
export type FileTreeRevealRoutingStep =
  | { readonly kind: "pin-host"; readonly hostId: string }
  | { readonly kind: "drop" }
  | { readonly kind: "wait" }
  | { readonly kind: "select-workspace"; readonly workspacePath: string }
  | { readonly kind: "ready" };

export interface FileTreeRevealRoutingInput {
  readonly request: FileTreeRevealRequest;
  /** Where the panel acts: the pin while it can serve, else `effective`. */
  readonly resolvedHostId: string | null;
  /** The stored pin, which survives its host's death. */
  readonly pinnedHostId: string | null;
  readonly rootsResolved: boolean;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly selectedWorkspacePath: string | null;
}

export function planFileTreeRevealRouting(
  input: FileTreeRevealRoutingInput,
): FileTreeRevealRoutingStep {
  const { request } = input;
  if (request.hostId !== input.resolvedHostId) {
    if (input.pinnedHostId === request.hostId) return { kind: "drop" };
    return { kind: "pin-host", hostId: request.hostId };
  }
  if (!input.rootsResolved) return { kind: "wait" };
  if (!input.workspaceRoots.includes(request.workspacePath)) {
    return { kind: "drop" };
  }
  if (input.selectedWorkspacePath !== request.workspacePath) {
    return { kind: "select-workspace", workspacePath: request.workspacePath };
  }
  return { kind: "ready" };
}
