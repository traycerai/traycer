import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import {
  buildPromptStashSnapshot,
  materializePromptStashEntry,
  PromptStashImagePreparationError,
  PromptStashImageUnavailableError,
  type PromptStashImageResolver,
} from "@/lib/composer/prompt-stash-content";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationResult,
  PromptStashMaterializedContent,
} from "@/lib/composer/prompt-stash-destination";
import {
  PromptStashCapacityExceededError,
  PromptStashCorruptBlobError,
  PromptStashMissingBlobError,
} from "@/lib/composer/prompt-stash-repository";
import type {
  PromptStashEntry,
  PromptStashRow,
} from "@/lib/composer/prompt-stash-codec";
import type { PromptStashSourceAdapter } from "@/lib/composer/prompt-stash-source";
import { registerActivePromptStash } from "@/lib/commands/active-prompt-stash-registry";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";

interface UsePromptStashArgs {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly readHashImage: PromptStashImageResolver;
  /**
   * Reads content out of, and conditionally clears, the canonical owner of
   * this surface (chat draft store / landing draft runtime / new-
   * conversation modal draft) - not the live editor. `stashCurrentAsync`
   * captures a token before the durable save and only clears when the owner
   * still matches it afterward, so edits made during the save are kept.
   */
  readonly source: PromptStashSourceAdapter;
  /**
   * Exact-destination restore: capture identity before materialization, then
   * only insert/consume when that same destination still accepts the write.
   */
  readonly destination: PromptStashDestinationAdapter;
}

export interface PromptStashController {
  readonly rows: ReadonlyArray<PromptStashRow>;
  readonly busyEntryId: string | null;
  readonly saving: boolean;
  readonly pulseEpoch: number;
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly editorHasFocus: () => boolean;
  readonly focusEditor: () => void;
  readonly stashCurrent: () => void;
  readonly restore: (entry: PromptStashEntry) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
}

export function usePromptStash(
  args: UsePromptStashArgs,
): PromptStashController {
  const { active, disabled, editorRef, readHashImage, source, destination } =
    args;
  const rows = usePromptStashStore((state) => state.rows);
  const markUnavailable = usePromptStashStore((state) => state.markUnavailable);
  const save = usePromptStashStore((state) => state.save);
  const removeFromStore = usePromptStashStore((state) => state.remove);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pulseEpoch, setPulseEpoch] = useState(0);
  const [menuOpen, setMenuOpenState] = useState(false);
  const stashInFlightRef = useRef(false);
  const busyEntryRef = useRef<string | null>(null);
  // Kept fresh via a LAYOUT effect, not a passive `useEffect`: layout effects
  // run synchronously in the same commit, before paint and before control
  // returns to the browser event loop, whereas passive effects are scheduled
  // and can be deferred past a promise continuation (e.g. `await save(...)`
  // resolving via IndexedDB) that lands in the same window. (Writing directly
  // during render - the usual "latest ref" pattern - is disallowed here by
  // `react-hooks/refs`, hence the layout effect instead.) This guarantees the
  // post-save `clearIfUnchanged` and post-materialize `importAndInsert` calls
  // always resolve the LATEST adapters - reflecting the current identity -
  // rather than a stale one closed over when the async work started.
  const sourceRef = useRef(source);
  const destinationRef = useRef(destination);
  useLayoutEffect(() => {
    sourceRef.current = source;
  }, [source]);
  useLayoutEffect(() => {
    destinationRef.current = destination;
  }, [destination]);
  // Hook-instance lifetime guard for the stash capture path. A stash save is
  // fire-and-forget from the caller's perspective (`stashCurrent` doesn't
  // await it), so it can still be in flight when this exact hook instance
  // unmounts - composer unmount/reopen (chat), surface detach/reattach
  // (landing), or close/reopen (modal) all mint a NEW hook instance for what
  // may be the same identity/revision pair. `sourceRef.current` stops
  // tracking `source` the moment this happens (the layout effect above no
  // longer runs), so a naive post-save `clearIfUnchanged` would run against
  // whatever adapter/closure was current right before unmount - which can
  // legitimately match a newer occupant's identity+revision (ABA) and erase
  // its content. Retirement must be a hard gate: the durable save is kept,
  // but this instance never touches a source or reports feedback again.
  //
  // LAYOUT effect, not passive: a passive cleanup can still be pending when
  // the `await save(...)` continuation (a promise microtask) resumes in the
  // same window, the same hazard `sourceRef`/`destinationRef` above are
  // guarded against - a passive-effect gate would leave a real window where
  // the retiring instance's own continuation reads `retiredRef.current` as
  // still `false`. The setup body resets the ref to `false`, not just the
  // initial `useRef` value: React 18 Strict Mode double-invokes mount effects
  // (setup, cleanup, setup) for the same still-mounted instance to surface
  // exactly this class of bug - without the reset, that simulated
  // cleanup would leave every real, live instance permanently retired.
  const retiredRef = useRef(false);
  useLayoutEffect(() => {
    retiredRef.current = false;
    return () => {
      retiredRef.current = true;
    };
  }, []);

  const editorHasFocus = useCallback(
    (): boolean => editorRef.current?.hasFocus() ?? false,
    [editorRef],
  );
  const focusEditor = useCallback(() => {
    editorRef.current?.focus();
  }, [editorRef]);

  const setMenuOpen = useCallback(
    (open: boolean) => {
      setMenuOpenState(open && rows.length > 0);
    },
    [rows.length],
  );

  const stashCurrentAsync = useCallback(async () => {
    if (disabled || stashInFlightRef.current) return;
    const editor = editorRef.current;
    if (editor === null || !editor.isReady()) return;
    const snapshot = sourceRef.current.capture();
    if (snapshot === null || !contentIsSubmittable(snapshot.content)) {
      setMenuOpenState((current) => rows.length > 0 && !current);
      return;
    }

    setMenuOpenState(false);
    stashInFlightRef.current = true;
    setSaving(true);
    try {
      const entrySnapshot = await buildPromptStashSnapshot({
        id: uuidv4(),
        createdAt: Date.now(),
        content: snapshot.content,
        readHashImage,
      });
      // The repository commits the manifest and every referenced image in one
      // IndexedDB transaction before any source is touched. Clearing before
      // this await would turn a quota or byte-resolution failure into prompt
      // loss; clearing unconditionally after it would erase edits made while
      // this await was in flight, so the source only clears if it still
      // matches the token captured before the save.
      await save(entrySnapshot);
      if (retiredRef.current) {
        // This hook instance unmounted while the save was in flight. The
        // durable stash is already committed; whatever now occupies this
        // identity/revision belongs to a different (possibly reopened)
        // instance, so never clear it and never surface feedback for a
        // composer that is gone.
        return;
      }
      const cleared = sourceRef.current.clearIfUnchanged(snapshot.token);
      setPulseEpoch((epoch) => epoch + 1);
      if (!cleared) {
        toast.success("Prompt stashed", {
          description: "Newer edits in the composer were kept.",
        });
      }
    } catch (error: unknown) {
      // A retired instance suppresses this too: a failure toast naming "this
      // prompt" or "the composer" is meaningless once that composer is gone,
      // and the durable save (if it got that far) already settled on its own.
      if (!retiredRef.current) {
        toast.error("Could not stash this prompt", {
          description: stashFailureDescription(error),
        });
      }
    } finally {
      stashInFlightRef.current = false;
      if (!retiredRef.current) setSaving(false);
    }
  }, [disabled, editorRef, rows.length, readHashImage, save]);

  const stashCurrent = useCallback(() => {
    void stashCurrentAsync();
  }, [stashCurrentAsync]);

  const restore = useCallback(
    async (entry: PromptStashEntry): Promise<boolean> => {
      if (busyEntryRef.current !== null || disabled) return false;
      // Capture the exact active destination before any blob materialization.
      // A later switch/remount/close must leave the stash intact.
      const identity = destinationRef.current.captureIdentity();
      if (identity === null) return false;
      busyEntryRef.current = entry.id;
      setBusyEntryId(entry.id);
      try {
        // Materialize through whichever adapter generation is current right
        // now - a destination-owned `materialize` (landing) has no
        // freshness requirement of its own, since `importAndInsert` below is
        // always invoked through `destinationRef.current` read AFTER this
        // await, picking up any switch/remount that happened during it. A
        // missing blob leaves both the source stash and current composer
        // untouched (propagates to the catch below).
        const materializer = destinationRef.current.materialize;
        const materialized: PromptStashMaterializedContent | null =
          materializer !== undefined
            ? await materializer(entry)
            : { content: await materializePromptStashEntry(entry) };
        if (materialized === null) {
          toast.error("Could not restore this prompt", {
            description:
              "The destination could not accept the prompt. The stash was kept intact.",
          });
          return false;
        }
        // `release` must run exactly once no matter how insertion finishes -
        // accepted, stale, or thrown. A throw from `importAndInsert`
        // would otherwise jump straight to the catch below and skip it,
        // leaking a still-held reservation (e.g. landing's measured budget).
        let result: PromptStashDestinationResult;
        try {
          result = await destinationRef.current.importAndInsert({
            identity,
            content: materialized.content,
          });
        } finally {
          materialized.release?.();
        }
        if (result.status === "stale") {
          // Destination disappeared, remounted, or switched while blobs were
          // reading. Never consume; never report success.
          return false;
        }
        focusEditor();
        // Immediate consume after accepted insertion (settled move semantics).
        // Consume failure leaves the inserted content plus a duplicate stash.
        try {
          await removeFromStore(entry.id);
        } catch {
          toast.warning("Prompt restored, but the stash copy remains", {
            description: "You can delete the duplicate after storage recovers.",
          });
        }
        return true;
      } catch (error: unknown) {
        // A blob that's missing or fails byte-level validation makes this
        // row genuinely unrestorable, not just a one-off failure - flip it
        // to the unavailable state now instead of waiting for the next
        // repository load, so retrying Insert doesn't repeat the same
        // failed read.
        if (
          error instanceof PromptStashMissingBlobError ||
          error instanceof PromptStashCorruptBlobError
        ) {
          markUnavailable(entry.id);
        }
        toast.error("Could not restore this prompt", {
          description: restoreFailureDescription(error),
        });
        return false;
      } finally {
        busyEntryRef.current = null;
        setBusyEntryId(null);
      }
    },
    [disabled, focusEditor, markUnavailable, removeFromStore],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (busyEntryRef.current !== null) return;
      busyEntryRef.current = id;
      setBusyEntryId(id);
      try {
        await removeFromStore(id);
      } catch {
        toast.error("Could not delete this stashed prompt", {
          description: "The prompt is still safely stored. Try again.",
        });
      } finally {
        busyEntryRef.current = null;
        setBusyEntryId(null);
      }
    },
    [removeFromStore],
  );

  const stashCurrentRef = useRef(stashCurrent);
  useEffect(() => {
    stashCurrentRef.current = stashCurrent;
  }, [stashCurrent]);
  useEffect(() => {
    if (!active) return;
    return registerActivePromptStash(() => {
      stashCurrentRef.current();
    });
  }, [active]);

  return {
    rows,
    busyEntryId,
    saving,
    pulseEpoch,
    menuOpen,
    setMenuOpen,
    editorHasFocus,
    focusEditor,
    stashCurrent,
    restore,
    remove,
  };
}

/**
 * Paired with the "Could not stash this prompt" toast title, so the copy
 * here only needs the reason plus confirmation the composer was left alone
 * - never repeated with the title. Every branch fires strictly before
 * `save` is attempted (capacity is checked inside the save transaction;
 * compression/resolution failures throw before it even opens), so the
 * composer really is untouched in every case.
 */
function stashFailureDescription(error: unknown): string {
  if (error instanceof PromptStashCapacityExceededError) {
    return "The prompt stash is full. Delete an older stashed prompt to free space; this prompt was left in the composer.";
  }
  if (error instanceof PromptStashImagePreparationError) {
    return `${error.message} The composer was left unchanged.`;
  }
  if (error instanceof PromptStashImageUnavailableError) {
    return "An attached image is still syncing. Wait for it to finish and try again.";
  }
  return "The composer was left unchanged because durable storage did not complete.";
}

/**
 * Paired with the "Could not restore this prompt" toast title. Every branch
 * confirms the stash entry itself was preserved, not consumed.
 */
function restoreFailureDescription(error: unknown): string {
  if (error instanceof PromptStashCorruptBlobError) {
    return "An attached image is damaged. The stash was kept intact.";
  }
  if (error instanceof PromptStashMissingBlobError) {
    return "An attached image could not be read. The stash was kept intact.";
  }
  return "The stash was kept intact. Try again after storage recovers.";
}
