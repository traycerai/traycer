import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";

const RESET_TOOLTIP = `Reset to "${DEFAULT_WORKTREE_BRANCH_PREFIX}"`;
// Mirrors the agent-selection-guide editor's debounce-autosave convention
// (`agent-selection-guide-section.tsx`), scaled down for a plain-text field.
const SAVE_DEBOUNCE_MS = 500;
// Mirrors SegmentCopyButton's COPIED_RESET_MS - long enough to register as
// deliberate feedback, short enough to get out of the way.
const SAVED_FLASH_MS = 1600;

export function WorktreeBranchPrefixSection(): ReactNode {
  const saved = useSettingsStore((s) => s.worktreeBranchPrefix);
  const setWorktreeBranchPrefix = useSettingsStore(
    (s) => s.setWorktreeBranchPrefix,
  );
  // The draft is the single source of truth while editing - initialized from
  // the store only on mount, and never re-derived from it mid-edit (autosave
  // writing back to `saved` must never echo into the draft mid-typing: no
  // cursor jumps, no reverted characters). It's adopted from `saved` below
  // only once there is no local edit in flight, so an idle external write
  // (another window, rehydration, a reset triggered elsewhere) still reaches
  // this field instead of leaving it stuck on a stale value. A committed
  // draft is normalized to the trimmed saved value by that same adoption
  // (rather than kept raw) - comparing raw draft text against the trimmed
  // store value can never converge otherwise.
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  // True from the first keystroke of an edit until it resolves (a debounce
  // commits, blur/Enter flushes, or reset runs) - tracked explicitly rather
  // than inferred from string equality, since a trimmed commit means the
  // draft and the store can permanently differ by whitespace alone. A
  // pending debounce timer only ever exists while this is true (both are
  // set together in `onChange` and cleared together on commit/reset), so it
  // alone is enough to gate adoption below.
  const [hasLocalEdit, setHasLocalEdit] = useState(false);
  // Transient post-save confirmation (Flow 4: spinner while saving, a brief
  // check on success, then quiet chrome) - no permanently reserved status
  // line. Set only for the current user's own resolved edits/reset, not for
  // an adopted external write from elsewhere.
  const [justSaved, setJustSaved] = useState(false);
  const draftRef = useRef(draft);
  // `commitIfValid` is a fresh closure every render, but the debounce timer
  // below is scheduled once (in `onChange`) and keeps calling that same
  // stale closure - so reading the `hasLocalEdit` state variable inside it
  // would always see the value from the render before the edit started
  // (before `setHasLocalEdit(true)` had taken effect), never the current
  // one. Mirrored directly at every write site instead, so the debounce
  // path sees the same up-to-date value the blur/reset paths do.
  const hasLocalEditRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const savedFlashRef = useRef<number | null>(null);
  // A fresh example suffix per mount, held stable while typing so only the
  // prefix part of the live example changes (Flow 4: "the draft remains
  // stable while they edit" applies to the example too - a suffix that
  // re-rolled on every keystroke would be distracting noise, not signal).
  const [previewSuffix] = useState(() => pickFriendlyBranchSuffix());

  // Adjusted during render (React's documented way to sync state off a
  // changing external value) rather than in an Effect, so there's no extra
  // render/flash between the store update and the field reflecting it.
  if (!hasLocalEdit && saved !== draft) {
    setDraft(saved);
    setError(null);
  }

  // Refs can't be written during render (see above) - mirror `draft` into
  // `draftRef` here so the debounce timeout and the unmount cleanup below
  // always read the latest value without a stale closure.
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    return () => {
      if (savedFlashRef.current !== null) {
        window.clearTimeout(savedFlashRef.current);
      }
      if (debounceRef.current === null) return;
      window.clearTimeout(debounceRef.current);
      // React doesn't guarantee a blur before unmount (Escape, a
      // programmatic panel switch). Persist a still-pending valid draft
      // directly through the store - the component is gone, so this must
      // not call any local state setters.
      const trimmed = draftRef.current.trim();
      if (worktreeBranchPrefixError(trimmed) !== null) return;
      if (trimmed !== useSettingsStore.getState().worktreeBranchPrefix) {
        setWorktreeBranchPrefix(trimmed);
      }
    };
  }, [setWorktreeBranchPrefix]);

  const clearPendingDebounce = (): void => {
    if (debounceRef.current === null) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = null;
  };

  const clearSavedFlash = (): void => {
    if (savedFlashRef.current === null) return;
    window.clearTimeout(savedFlashRef.current);
    savedFlashRef.current = null;
  };

  const flashSaved = (): void => {
    clearSavedFlash();
    setJustSaved(true);
    savedFlashRef.current = window.setTimeout(() => {
      savedFlashRef.current = null;
      setJustSaved(false);
    }, SAVED_FLASH_MS);
  };

  // Reads the store imperatively (not the reactive `saved` closed over at
  // schedule time) so a debounce that fires after an external change - the
  // reset button, a rehydrate - still compares against the current value.
  const commitIfValid = (value: string): void => {
    const trimmed = value.trim();
    const validationError = worktreeBranchPrefixError(trimmed);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    // Captured before clearing: a normalization-only resolution (the
    // trimmed draft already equals the store, e.g. re-typing whitespace
    // around an unchanged value) still resolves a real pending edit and
    // must flash success - but an already-clean field's flush (blur with no
    // edit at all) must stay quiet.
    const hadLocalEdit = hasLocalEditRef.current;
    setError(null);
    setHasLocalEdit(false);
    hasLocalEditRef.current = false;
    if (trimmed !== useSettingsStore.getState().worktreeBranchPrefix) {
      setWorktreeBranchPrefix(trimmed);
    }
    if (hadLocalEdit) flashSaved();
  };

  const flush = (): void => {
    clearPendingDebounce();
    commitIfValid(draftRef.current);
  };

  const isDefault = saved === DEFAULT_WORKTREE_BRANCH_PREFIX;
  const previewPrefix = draft.trim();
  const previewBranch =
    previewPrefix.length > 0
      ? `${previewPrefix}${previewSuffix}`
      : previewSuffix;

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <div className="flex items-center gap-3.5 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-ui-sm font-medium text-foreground">
              Branch prefix
            </span>
            <span className="text-ui-xs text-muted-foreground">All hosts</span>
          </div>
          <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
            New branches start like{" "}
            <span className="font-medium text-foreground">{previewBranch}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex size-7 shrink-0 items-center justify-center">
            {!isDefault ? (
              <TooltipWrapper
                label={RESET_TOOLTIP}
                side="top"
                sideOffset={undefined}
                align={undefined}
              >
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={RESET_TOOLTIP}
                  onClick={() => {
                    clearPendingDebounce();
                    draftRef.current = DEFAULT_WORKTREE_BRANCH_PREFIX;
                    setDraft(DEFAULT_WORKTREE_BRANCH_PREFIX);
                    setError(null);
                    setHasLocalEdit(false);
                    hasLocalEditRef.current = false;
                    setWorktreeBranchPrefix(DEFAULT_WORKTREE_BRANCH_PREFIX);
                    flashSaved();
                  }}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </TooltipWrapper>
            ) : null}
          </div>
          <Input
            value={draft}
            aria-label="Branch prefix"
            aria-invalid={error !== null}
            placeholder="traycer/"
            className="h-8 w-44 font-mono text-ui-sm"
            onChange={(event) => {
              const next = event.target.value;
              draftRef.current = next;
              setDraft(next);
              setHasLocalEdit(true);
              hasLocalEditRef.current = true;
              clearSavedFlash();
              setJustSaved(false);
              const validationError = worktreeBranchPrefixError(next.trim());
              setError(validationError);
              clearPendingDebounce();
              if (validationError === null) {
                debounceRef.current = window.setTimeout(() => {
                  debounceRef.current = null;
                  commitIfValid(draftRef.current);
                }, SAVE_DEBOUNCE_MS);
              }
            }}
            onBlur={flush}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <WorktreeBranchPrefixIndicator
            error={error}
            saving={error === null && hasLocalEdit}
            justSaved={error === null && !hasLocalEdit && justSaved}
          />
        </div>
      </div>
      {error !== null ? (
        <p className="border-t border-border/40 px-3.5 py-2 text-ui-xs text-destructive">
          {error}
        </p>
      ) : null}
      <WorktreeBranchPrefixLiveStatus
        saving={error === null && hasLocalEdit}
        justSaved={error === null && !hasLocalEdit && justSaved}
      />
    </div>
  );
}

// Visually hidden, screen-reader-only counterpart to the icon-only visual
// indicator above (which stays `aria-hidden`) - the approved design has no
// permanently reserved visual status text, but a saving/saved transition
// still needs to reach assistive tech. Mirrors the `sr-only` +
// `role="status"` + `aria-live="polite"` convention already used for
// `PrimaryChangeLiveRegion` in this same feature area.
function WorktreeBranchPrefixLiveStatus(props: {
  readonly saving: boolean;
  readonly justSaved: boolean;
}): ReactNode {
  let text: string | null = null;
  if (props.saving) {
    text = "Saving…";
  } else if (props.justSaved) {
    text = "Saved";
  }
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}

function WorktreeBranchPrefixIndicator(props: {
  readonly error: string | null;
  readonly saving: boolean;
  readonly justSaved: boolean;
}): ReactNode {
  if (props.error !== null) return null;
  if (props.saving) {
    return (
      <AgentSpinningDots
        className="text-muted-foreground"
        testId="worktree-branch-prefix-saving-spinner"
        variant={undefined}
      />
    );
  }
  if (props.justSaved) {
    return (
      <Check
        className="size-3.5 text-[var(--term-ansi-green)]"
        data-testid="worktree-branch-prefix-saved-check"
      />
    );
  }
  return null;
}
