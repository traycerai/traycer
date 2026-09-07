import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

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
  /** Reads content out of, and conditionally clears, the canonical owner of this surface (chat draft store / landing draft runtime / new- conversation modal draft) - not the live editor. */
  readonly source: PromptStashSourceAdapter;
  /** Exact-destination restore: capture identity before materialization, then only insert/consume when that same destination still accepts the write. */
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
  // Layout effect, not `useEffect`: a passive effect can defer past an IndexedDB continuation and leave post-save adapters stale. Direct render writes are banned by `react-hooks/refs`.
  const sourceRef = useRef(source);
  const destinationRef = useRef(destination);
  useLayoutEffect(() => {
    sourceRef.current = source;
  }, [source]);
  useLayoutEffect(() => {
    destinationRef.current = destination;
  }, [destination]);
  // Layout effect: retire this instance on unmount so a fire-and-forget save cannot ABA-clear a newer occupant's draft. Reset retiredRef on setup for Strict Mode.
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
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        content: snapshot.content,
        readHashImage,
      });
      // Clearing before this await would turn a quota or byte-resolution failure into prompt loss; clearing unconditionally after it would erase edits made while this await was in flight, so the source only clears if it still matches the token captured before the save.
      await save(entrySnapshot);
      if (retiredRef.current) {
        // The durable stash is already committed; whatever now occupies this identity/revision belongs to a different (possibly reopened) instance, so never clear it and never surface feedback for a composer that is gone.
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
        // Materialize through whichever adapter generation is current right now - a destination-owned `materialize` (landing) has no freshness requirement of its own, since `importAndInsert` below is always invoked through `destinationRef.current` read AFTER this await, picking up any switch/remount that happened during it.
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
        // `release` must run exactly once no matter how insertion finishes - accepted, stale, or thrown.
        // A throw from `importAndInsert` would otherwise jump straight to the catch below and skip it, leaking a still-held reservation (e.g.
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
        // A blob that's missing or fails byte-level validation makes this row genuinely unrestorable, not just a one-off failure - flip it to the unavailable state now instead of waiting for the next repository load, so retrying Insert doesn't repeat the same failed read.
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

/** never repeated with the title. */
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

/** Paired with the "Could not restore this prompt" toast title. */
function restoreFailureDescription(error: unknown): string {
  if (error instanceof PromptStashCorruptBlobError) {
    return "An attached image is damaged. The stash was kept intact.";
  }
  if (error instanceof PromptStashMissingBlobError) {
    return "An attached image could not be read. The stash was kept intact.";
  }
  return "The stash was kept intact. Try again after storage recovers.";
}
