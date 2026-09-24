/**
 * React reads over one open identity's store, the counterpart of the
 * artifact-body hooks in `epic-selectors.ts`.
 *
 * `useIdentityFileFragment(path)` takes the body LEASE itself, for the reason
 * `useEpicArtifactFragment` gives: the store's accessor is a pure read and
 * cannot open a lane from inside a selector, so a caller that read without
 * leasing would wait forever. The lease is a layout effect so the lane opens
 * before paint.
 */
import { useLayoutEffect } from "react";
import { useStore } from "zustand";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { useOpenIdentityHandle } from "@/providers/open-identity-context";
import type { OpenIdentityState } from "@/stores/identities/open-identity/store";
import type { IdentityFileBodyAvailability } from "@/stores/identities/open-identity/types";

export function useOpenIdentityState<T>(
  selector: (state: OpenIdentityState) => T,
): T {
  const handle = useOpenIdentityHandle();
  return useStore(handle.store, selector);
}

export function useIdentityFileBodyLease(path: string | null): void {
  const handle = useOpenIdentityHandle();
  useLayoutEffect(() => {
    if (path === null) return;
    return handle.acquireFileBodyLease(path);
  }, [handle, path]);
}

export function useIdentityFileFragment(
  path: string | null,
): Y.XmlFragment | null {
  const handle = useOpenIdentityHandle();
  useIdentityFileBodyLease(path);
  return useStore(handle.store, (state) => {
    // `bodyRevision` is what makes this selector re-run when the doc behind
    // the path changes: the fragment itself is not store state.
    void state.bodyRevision;
    return path === null ? null : handle.getFileFragment(path);
  });
}

export function useIdentityFileDoc(path: string | null): Y.Doc | null {
  const handle = useOpenIdentityHandle();
  useIdentityFileBodyLease(path);
  return useStore(handle.store, (state) => {
    void state.bodyRevision;
    return path === null ? null : handle.getFileDoc(path);
  });
}

export function useIdentityFileAwareness(
  path: string | null,
): Awareness | null {
  const handle = useOpenIdentityHandle();
  useIdentityFileBodyLease(path);
  return useStore(handle.store, (state) => {
    void state.bodyRevision;
    return path === null ? null : handle.getFileAwareness(path);
  });
}

export function useIdentityFileBodyAvailability(
  path: string | null,
): IdentityFileBodyAvailability | null {
  const handle = useOpenIdentityHandle();
  return useStore(handle.store, (state) =>
    path === null ? null : (state.bodyAvailabilityByPath[path] ?? null),
  );
}

export function useIdentityFileIsDirty(path: string | null): boolean {
  const handle = useOpenIdentityHandle();
  return useStore(handle.store, (state) =>
    path === null ? false : state.dirtyPaths.includes(path),
  );
}
