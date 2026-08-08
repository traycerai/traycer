import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RepoBranchPrefixState } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useWorktreeSetRepoBranchPrefixFor } from "@/hooks/worktree/use-worktree-set-repo-branch-prefix-mutation";
import { worktreeBranchPrefixError } from "@/lib/worktree/worktree-branch-prefix-validation";
import { resolveEffectiveBranchPrefix } from "@/lib/worktree/effective-branch-prefix";
import { pickFriendlyBranchSuffix } from "@/lib/worktree/random-friendly-name";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { cn } from "@/lib/utils";

const SET_REPO_BRANCH_PREFIX_METHOD = "worktree.setRepoBranchPrefix";

/**
 * The "Branch prefix" section of the Environment dialog - the layered-setting
 * redesign of the old unlabeled-switch card (core-flows/worktree-environment-
 * layered-settings). Users configure a PREFIX only; the full worktree branch
 * is always `prefix + generated name`, shown as a compact preview (prefix
 * emphasized, tail muted). Always targets `workspacePath` - the exact source
 * checkout shown in the picker - never a staged/existing worktree's own file
 * (unlike the scripts editor in the same dialog, which follows the resolved
 * target).
 *
 * Renders one of five bodies (`<BranchNamingShell>` supplies the shared
 * eyebrow + repository identity around all of them), gated in this priority
 * order:
 *  1. Unsupported host (`!supported`) - read-only, no edit affordance at all.
 *  2. Malformed stored file (`status: "malformed"`) - the host REFUSES to
 *     merge-write onto unparseable JSON (`writeAuthorizedEnvironmentPatch`),
 *     so offering an editor here would always fail; show the warning only.
 *  3. Editing (local `mode`) - a fresh draft (no saved value yet) or an
 *     edit of an already-saved value; the two-column choice selector only
 *     appears for the fresh-draft path (see `editingFromExisting` below).
 *  4. Saved override present (`status: "present"`, viewing) - summary +
 *     Edit/Remove. A `"present"` value that fails client validation still
 *     renders here (with a warning) rather than as state 2, because the JSON
 *     itself is valid - the host CAN accept a repair write.
 *  5. Inherited (`status: "absent"`, viewing) - the two explicit choice rows.
 */
export function RepoBranchPrefixSection(props: {
  readonly workspacePath: string;
  readonly repoIdentifier: {
    readonly owner: string;
    readonly repo: string;
  } | null;
  readonly repoBranchPrefixState: RepoBranchPrefixState;
  readonly epicId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  // The picker's actual current proposal for this workspace - `resolved
  // .branchName` when a staged `type: "new"` branch exists, else `null`.
  // Takes priority over any composed illustrative preview in every viewing
  // state EXCEPT while `activeRegenerateCandidate` is set (below): the
  // effective-branch row must show the TRUTH of what's staged when one
  // exists, not an unrelated fabricated example.
  readonly currentProposedBranchName: string | null;
  // Non-null exactly while the caller's post-save/remove regeneration offer
  // ("Keep current" / "Use new prefix") is visible, carrying the SAME exact
  // candidate that offer would stage. Takes priority over
  // `currentProposedBranchName` for the whole time the offer is up: showing
  // the old proposal here while the offer proposes to replace it with a
  // different, invisible value would make "what's displayed" and "what gets
  // staged" diverge at the exact moment the user decides. `null` resumes the
  // ordinary `currentProposedBranchName` precedence (including immediately
  // after "Keep current").
  readonly activeRegenerateCandidate: string | null;
  // Composes the branch name `prefixState` would produce at `suffix`, via
  // the same production composition path real branch staging uses
  // (`default-branch-name.ts`: multi-repo repository slugging + truncation
  // included). `null` only if the host never resolved this workspace into
  // the picker's summary list (defensively handled, not expected in
  // practice - this section only renders for a workspace the picker itself
  // opened Environment for).
  readonly composeCandidateBranch: (
    prefixState: RepoBranchPrefixState,
    suffix: string,
  ) => string | null;
  // Reports the section's current cancel-editing handler (`null` whenever
  // it isn't actively editing) so the containing dialog can intercept
  // Escape at the Radix dismissable-layer boundary instead of letting it
  // fall through to the dialog's own dismiss (which Radix's capture-phase
  // document listener would otherwise win before any bubbling `onKeyDown`
  // inside this section ever ran).
  readonly onEditingCancelAvailable: (cancel: (() => void) | null) => void;
  // Called ONLY when the host actually persisted the write (`updated: true`)
  // - never for a non-git/no-op response - with the newly-saved state AND
  // the exact candidate branch name that was displayed as "Effective
  // branch" at that moment (`null` if `composeCandidateBranch` couldn't
  // resolve one). The caller stages this captured string directly for "Use
  // new prefix" rather than recomputing - recomputing would hand back a
  // different random suffix than whatever was just shown.
  readonly onSaved: (
    newState: RepoBranchPrefixState,
    candidateBranchName: string | null,
  ) => void;
}): ReactNode {
  const globalPrefix = useSettingsStore((s) => s.worktreeBranchPrefix);
  const hostId = props.hostClient?.getActiveHostId() ?? null;
  const supported = useHostSupportsMethod(
    hostId,
    SET_REPO_BRANCH_PREFIX_METHOD,
  );
  const saveMutation = useWorktreeSetRepoBranchPrefixFor(props.hostClient);

  // Holds the state a save/remove just persisted, so the UI can render the
  // resulting frame (saved summary, or back to inherited) immediately rather
  // than waiting on the `worktree.listByWorkspacePaths` invalidation this
  // mutation triggers to refetch and flow back down through `props`. Once
  // set it permanently shadows `props.repoBranchPrefixState` for the rest of
  // this mount (the dialog fully remounts per open/workspace via `key`), which
  // is safe because it always equals what that refetch will confirm.
  const [optimisticState, setOptimisticState] =
    useState<RepoBranchPrefixState | null>(null);
  const repoState = optimisticState ?? props.repoBranchPrefixState;

  const [mode, setMode] = useState<"viewing" | "editing">("viewing");
  const [draft, setDraft] = useState("");
  // The async "this folder isn't a git repository (or is no longer one)"
  // outcome - distinct from client-side draft validation, which is derived
  // fresh from `draft` on every render instead of tracked in state.
  const [saveFailedNote, setSaveFailedNote] = useState<string | null>(null);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  // A fresh illustrative suffix per mount, held stable while the user reads
  // or edits - mirrors the global Settings editor's `previewSuffix`
  // (`worktree-branch-prefix-section.tsx`), except now fed through
  // `composeCandidateBranch` (the real composition path) instead of naive
  // string concatenation, so multi-repo slugging/truncation are respected
  // and the exact same suffix is reused for both the live preview and
  // whatever gets captured for "Use new prefix" at Apply/Remove time.
  const [previewSuffix] = useState(() => pickFriendlyBranchSuffix());
  const uid = useId();
  // Set right before a transition that swaps the visible body (Cancel,
  // successful Apply, successful Remove) so the resulting view's own mount
  // captures `true` and moves focus to its stable landing control - but NOT
  // on a cold/initial mount (the dialog opening must never steal focus).
  // Never reset back to `false`: each transition mounts a genuinely NEW view
  // instance (Inherited/Saved/Editing are mutually-exclusive branches), so a
  // fresh mount's own `useState(() => ...)` capture of this value is only
  // ever read once, at the moment it's actually true.
  const [pendingFocusRestore, setPendingFocusRestore] = useState(false);

  const effective = resolveEffectiveBranchPrefix(
    repoState,
    globalPrefix,
    props.workspacePath,
  );
  const repoLabel =
    props.repoIdentifier !== null
      ? `${props.repoIdentifier.owner}/${props.repoIdentifier.repo}`
      : lastPathSegment(props.workspacePath);
  const draftError =
    mode === "editing" ? worktreeBranchPrefixError(draft) : null;
  const currentSavedValue =
    repoState.status === "present" ? repoState.value : null;
  const dirty = currentSavedValue === null || draft !== currentSavedValue;
  const applyDisabled = draftError !== null || saveMutation.isPending || !dirty;
  const globalDisplay = globalPrefix.length > 0 ? globalPrefix : "No prefix";
  // The truthful full-branch preview for every non-editing view (and the
  // invalid-draft fallback while editing): the active regeneration offer's
  // candidate while one is up (see `activeRegenerateCandidate`'s doc
  // comment), else the picker's actual staged proposal, else an illustrative
  // candidate composed via the real production path, else (only if that
  // composition couldn't resolve this workspace at all) the bare
  // prefix+suffix as a last resort. This is NOT the value the user edits -
  // they edit the prefix; the preview shows prefix + generated name.
  const currentEffectiveBranch = resolveCurrentEffectiveBranch(
    props.activeRegenerateCandidate,
    props.currentProposedBranchName,
    props.composeCandidateBranch(repoState, previewSuffix),
    `${effective.value}${previewSuffix}`,
  );
  // Real staged name (or a regeneration candidate about to be staged) vs an
  // illustrative example. Drives the short preview label without extra prose.
  const hasStagedBranchPreview =
    props.activeRegenerateCandidate !== null ||
    props.currentProposedBranchName !== null;
  const viewingPreviewLabel = hasStagedBranchPreview
    ? "Staged branch"
    : "Example";

  const cancelEditing = useCallback((): void => {
    setPendingFocusRestore(true);
    setMode("viewing");
    setSaveFailedNote(null);
  }, []);

  // Registers/unregisters `cancelEditing` with the containing dialog so its
  // `onEscapeKeyDown` can reach it - see the `onEditingCancelAvailable` doc
  // comment above. Destructured to a local so the effect's dependency array
  // can name it directly instead of deep-reading `props.x`.
  const { onEditingCancelAvailable } = props;
  useEffect(() => {
    onEditingCancelAvailable(mode === "editing" ? cancelEditing : null);
    return () => onEditingCancelAvailable(null);
  }, [mode, cancelEditing, onEditingCancelAvailable]);

  const enterEditing = (seed: string): void => {
    setDraft(seed);
    setSaveFailedNote(null);
    setMode("editing");
  };

  const handleApply = (): void => {
    if (applyDisabled) return;
    setSaveFailedNote(null);
    // Computed with the SAME inputs (`draft`, `previewSuffix`) the editing
    // view's own live preview just used to render "Effective branch" -
    // guarantees the candidate captured here is exactly what was on screen.
    const candidate = props.composeCandidateBranch(
      { status: "present", value: draft },
      previewSuffix,
    );
    saveMutation.mutate(
      {
        epicId: props.epicId,
        workspacePath: props.workspacePath,
        branchPrefix: draft,
      },
      {
        onSuccess: (data) => {
          if (!data.updated) {
            setSaveFailedNote(
              "Couldn't save — this folder isn't a git repository (or is no longer one).",
            );
            return;
          }
          const newState: RepoBranchPrefixState = {
            status: "present",
            value: draft,
          };
          setOptimisticState(newState);
          setPendingFocusRestore(true);
          setMode("viewing");
          props.onSaved(newState, candidate);
        },
      },
    );
  };

  const handleRemove = (): void => {
    const candidate = props.composeCandidateBranch(
      { status: "absent" },
      previewSuffix,
    );
    saveMutation.mutate(
      {
        epicId: props.epicId,
        workspacePath: props.workspacePath,
        branchPrefix: null,
      },
      {
        onSuccess: (data) => {
          setConfirmRemoveOpen(false);
          if (!data.updated) {
            setSaveFailedNote(
              "Couldn't remove — this folder isn't a git repository (or is no longer one).",
            );
            return;
          }
          const newState: RepoBranchPrefixState = { status: "absent" };
          setOptimisticState(newState);
          setPendingFocusRestore(true);
          props.onSaved(newState, candidate);
        },
      },
    );
  };

  return (
    <BranchNamingShell repoLabel={repoLabel}>
      {selectBranchNamingBody({
        supported,
        repoState,
        mode,
        globalDisplay,
        viewingPreviewLabel,
        currentEffectiveBranch,
        effectivePrefix: effective.value,
        effectiveWarning: effective.warning,
        draft,
        draftError,
        previewSuffix,
        composeCandidateBranch: props.composeCandidateBranch,
        hasStagedBranchPreview,
        uid,
        currentSavedValue,
        saveFailedNote,
        isPending: saveMutation.isPending,
        applyDisabled,
        confirmRemoveOpen,
        globalPrefix,
        pendingFocusRestore,
        onDraftChange: setDraft,
        onApply: handleApply,
        onCancel: cancelEditing,
        onOpenConfirmRemove: () => setConfirmRemoveOpen(true),
        onOpenChangeConfirmRemove: setConfirmRemoveOpen,
        onConfirmRemove: handleRemove,
        enterEditing,
      })}
    </BranchNamingShell>
  );
}

/**
 * The priority-ordered body selection documented on {@link
 * RepoBranchPrefixSection} above, split out purely to keep that component's
 * own cyclomatic complexity down - every input here is already resolved by
 * the caller, so this is a straight dispatch with no independent state.
 */
function selectBranchNamingBody(input: {
  readonly supported: boolean;
  readonly repoState: RepoBranchPrefixState;
  readonly mode: "viewing" | "editing";
  readonly globalDisplay: string;
  readonly viewingPreviewLabel: string;
  readonly currentEffectiveBranch: string;
  readonly effectivePrefix: string;
  readonly effectiveWarning: string | null;
  readonly draft: string;
  readonly draftError: string | null;
  readonly previewSuffix: string;
  readonly composeCandidateBranch: (
    prefixState: RepoBranchPrefixState,
    suffix: string,
  ) => string | null;
  readonly hasStagedBranchPreview: boolean;
  readonly uid: string;
  readonly currentSavedValue: string | null;
  readonly saveFailedNote: string | null;
  readonly isPending: boolean;
  readonly applyDisabled: boolean;
  readonly confirmRemoveOpen: boolean;
  readonly globalPrefix: string;
  readonly pendingFocusRestore: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly onOpenConfirmRemove: () => void;
  readonly onOpenChangeConfirmRemove: (open: boolean) => void;
  readonly onConfirmRemove: () => void;
  readonly enterEditing: (seed: string) => void;
}): ReactNode {
  if (!input.supported) {
    return (
      <UnsupportedBranchNaming
        globalDisplay={input.globalDisplay}
        previewLabel={input.viewingPreviewLabel}
        previewBranch={input.currentEffectiveBranch}
        previewPrefix={input.effectivePrefix}
      />
    );
  }

  if (input.repoState.status === "malformed") {
    return (
      <MalformedBranchNaming
        warning={input.effectiveWarning}
        previewLabel={input.viewingPreviewLabel}
        previewBranch={input.currentEffectiveBranch}
        previewPrefix={input.effectivePrefix}
      />
    );
  }

  if (input.mode === "editing") {
    const draftCandidate =
      input.draftError === null
        ? input.composeCandidateBranch(
            { status: "present", value: input.draft },
            input.previewSuffix,
          )
        : null;
    const preview = editingPreview({
      draftError: input.draftError,
      draftCandidate,
      currentEffectiveBranch: input.currentEffectiveBranch,
      hasStagedBranchPreview: input.hasStagedBranchPreview,
      draftPrefix: input.draft,
      currentPrefix: input.effectivePrefix,
    });
    return (
      <EditingBranchNaming
        uid={input.uid}
        draft={input.draft}
        draftError={input.draftError}
        editingFromExisting={input.currentSavedValue !== null}
        globalDisplay={input.globalDisplay}
        previewLabel={preview.label}
        previewBranch={preview.value}
        previewPrefix={preview.prefix}
        saveFailedNote={input.saveFailedNote}
        isPending={input.isPending}
        applyDisabled={input.applyDisabled}
        onDraftChange={input.onDraftChange}
        onApply={input.onApply}
        onCancel={input.onCancel}
      />
    );
  }

  if (input.repoState.status === "present") {
    const repoState = input.repoState;
    return (
      <SavedBranchNaming
        savedValue={repoState.value}
        globalDisplay={input.globalDisplay}
        previewLabel={input.viewingPreviewLabel}
        previewBranch={input.currentEffectiveBranch}
        previewPrefix={input.effectivePrefix}
        warning={input.effectiveWarning}
        saveFailedNote={input.saveFailedNote}
        isPending={input.isPending}
        confirmRemoveOpen={input.confirmRemoveOpen}
        globalPrefix={input.globalPrefix}
        shouldFocusOnMount={input.pendingFocusRestore}
        onOpenConfirmRemove={input.onOpenConfirmRemove}
        onOpenChangeConfirmRemove={input.onOpenChangeConfirmRemove}
        onEdit={() => input.enterEditing(repoState.value)}
        onConfirmRemove={input.onConfirmRemove}
      />
    );
  }

  return (
    <InheritedBranchNaming
      uid={input.uid}
      globalDisplay={input.globalDisplay}
      previewLabel={input.viewingPreviewLabel}
      previewBranch={input.currentEffectiveBranch}
      previewPrefix={input.effectivePrefix}
      shouldFocusOnMount={input.pendingFocusRestore}
      onChooseOverride={() => input.enterEditing("")}
    />
  );
}

function BranchNamingShell(props: {
  readonly repoLabel: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="repo-branch-prefix-section"
    >
      <div>
        <p className="text-ui-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
          Branch prefix
        </p>
        <p className="mt-0.5 truncate text-ui-sm font-medium text-foreground">
          Repository · {props.repoLabel}
        </p>
      </div>
      <div className="flex flex-col gap-2.5" aria-live="polite">
        {props.children}
      </div>
    </div>
  );
}

function UnsupportedBranchNaming(props: {
  readonly globalDisplay: string;
  readonly previewLabel: string;
  readonly previewBranch: string;
  readonly previewPrefix: string;
}): ReactNode {
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="mt-px size-3.5 shrink-0 rounded-full border-[4px] border-primary"
        />
        <div className="min-w-0">
          <span className="block text-ui-sm font-medium text-foreground">
            Global default
          </span>
          <span className="block font-mono text-ui-xs text-muted-foreground">
            {props.globalDisplay}
          </span>
        </div>
      </div>
      <p
        className="text-ui-xs text-amber-950 dark:text-amber-100"
        data-testid="repo-branch-prefix-unsupported"
      >
        Repository prefixes require a newer Traycer host. Branches continue
        using the global default.
      </p>
      <BranchPreviewRow
        label={props.previewLabel}
        branch={props.previewBranch}
        prefix={props.previewPrefix}
      />
    </>
  );
}

function MalformedBranchNaming(props: {
  readonly warning: string | null;
  readonly previewLabel: string;
  readonly previewBranch: string;
  readonly previewPrefix: string;
}): ReactNode {
  return (
    <>
      <p
        role="alert"
        className="text-ui-xs text-destructive"
        data-testid="repo-branch-prefix-malformed"
      >
        {props.warning}
      </p>
      <BranchPreviewRow
        label={props.previewLabel}
        branch={props.previewBranch}
        prefix={props.previewPrefix}
      />
    </>
  );
}

function InheritedBranchNaming(props: {
  readonly uid: string;
  readonly globalDisplay: string;
  readonly previewLabel: string;
  readonly previewBranch: string;
  readonly previewPrefix: string;
  // Whether THIS mount is the result of a flagged transition (Cancel or a
  // confirmed Remove) rather than the dialog's cold/initial open - captured
  // ONCE via the lazy `useState` initializer below, since Inherited/Saved/
  // Editing are mutually-exclusive branches in the parent and every
  // transition between them mounts a genuinely fresh instance.
  readonly shouldFocusOnMount: boolean;
  readonly onChooseOverride: () => void;
}): ReactNode {
  const [focusOnMount] = useState(() => props.shouldFocusOnMount);
  const globalItemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    globalItemRef.current?.focus();
  }, [focusOnMount]);

  return (
    <>
      <RadioGroup
        value="global"
        aria-label="Branch prefix source"
        className="grid grid-cols-2 gap-2"
        onValueChange={(next) => {
          if (next === "override") props.onChooseOverride();
        }}
      >
        <label
          htmlFor={`${props.uid}-global`}
          data-testid="repo-branch-prefix-choice-global"
          className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-primary/50 bg-primary/5 px-2.5 py-2 transition-colors"
        >
          <RadioGroupItem
            ref={globalItemRef}
            id={`${props.uid}-global`}
            value="global"
            className="mt-0.5"
          />
          <div className="min-w-0">
            <span className="block text-ui-sm font-medium text-foreground">
              Global default
            </span>
            <span className="block truncate font-mono text-ui-xs text-muted-foreground">
              {props.globalDisplay}
            </span>
          </div>
        </label>
        <ChoiceRow
          id={`${props.uid}-override`}
          value="override"
          active={false}
          title="This repository"
          detail="Custom prefix"
        />
      </RadioGroup>
      <BranchPreviewRow
        label={props.previewLabel}
        branch={props.previewBranch}
        prefix={props.previewPrefix}
      />
    </>
  );
}

function EditingBranchNaming(props: {
  readonly uid: string;
  readonly draft: string;
  readonly draftError: string | null;
  readonly editingFromExisting: boolean;
  readonly globalDisplay: string;
  readonly previewLabel: string;
  readonly previewBranch: string;
  readonly previewPrefix: string;
  readonly saveFailedNote: string | null;
  readonly isPending: boolean;
  readonly applyDisabled: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  // Imperative focus (not the `autoFocus` JSX prop, which jsx-a11y forbids).
  // This component only mounts when `mode` flips to "editing", so a
  // mount-only effect fires exactly once per entry into the editor.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <>
      {props.editingFromExisting ? (
        <p className="text-ui-sm font-medium text-foreground">
          This repository
        </p>
      ) : (
        <RadioGroup
          value="override"
          aria-label="Branch prefix source"
          className="grid grid-cols-2 gap-2"
          onValueChange={(next) => {
            if (next === "global") props.onCancel();
          }}
        >
          <ChoiceRow
            id={`${props.uid}-global`}
            value="global"
            active={false}
            title="Global default"
            detail={props.globalDisplay}
          />
          <ChoiceRow
            id={`${props.uid}-override`}
            value="override"
            active
            title="This repository"
            detail="Custom prefix"
          />
        </RadioGroup>
      )}
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${props.uid}-prefix-input`}
          className="text-ui-xs text-muted-foreground"
        >
          Prefix
        </Label>
        <Input
          ref={inputRef}
          id={`${props.uid}-prefix-input`}
          value={props.draft}
          aria-invalid={props.draftError !== null}
          aria-describedby={
            props.draftError !== null ? `${props.uid}-prefix-error` : undefined
          }
          placeholder="traycer/"
          className="font-mono"
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onApply();
          }}
        />
        {props.draftError !== null ? (
          <p
            id={`${props.uid}-prefix-error`}
            role="alert"
            className="text-ui-xs text-destructive"
          >
            {props.draftError}
          </p>
        ) : null}
      </div>
      <BranchPreviewRow
        label={props.previewLabel}
        branch={props.previewBranch}
        prefix={props.previewPrefix}
      />
      <p className="text-ui-xs text-muted-foreground">
        Global default ·{" "}
        <span className="font-mono">{props.globalDisplay}</span>
      </p>
      {props.saveFailedNote !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {props.saveFailedNote}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.isPending}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.applyDisabled}
          onClick={props.onApply}
        >
          {props.isPending ? (
            <AgentSpinningDots
              className="text-current"
              testId="repo-branch-prefix-apply-spinner"
              variant={undefined}
            />
          ) : null}
          Save prefix
        </Button>
      </div>
    </>
  );
}

function SavedBranchNaming(props: {
  readonly savedValue: string;
  readonly globalDisplay: string;
  readonly previewLabel: string;
  readonly previewBranch: string;
  readonly previewPrefix: string;
  readonly warning: string | null;
  readonly saveFailedNote: string | null;
  readonly isPending: boolean;
  readonly confirmRemoveOpen: boolean;
  readonly globalPrefix: string;
  // See `InheritedBranchNaming`'s matching prop doc comment - same
  // capture-once-at-mount contract.
  readonly shouldFocusOnMount: boolean;
  readonly onOpenConfirmRemove: () => void;
  readonly onOpenChangeConfirmRemove: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly onConfirmRemove: () => void;
}): ReactNode {
  const [focusOnMount] = useState(() => props.shouldFocusOnMount);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Focus "Edit prefix" after Cancel (from editing an existing override)
  // or a successful Apply lands here - never on a cold/initial mount.
  useEffect(() => {
    if (!focusOnMount) return;
    editButtonRef.current?.focus();
  }, [focusOnMount]);

  return (
    <>
      <div
        className="flex items-start gap-2.5"
        data-testid="repo-branch-prefix-saved"
      >
        <span
          aria-hidden
          className="mt-1 size-3.5 shrink-0 rounded-full border-[4px] border-primary"
        />
        <div className="min-w-0">
          <span className="block text-ui-sm font-medium text-foreground">
            This repository
          </span>
          <span className="block font-mono text-ui-xs text-muted-foreground">
            {props.savedValue.length > 0 ? props.savedValue : "No prefix"}
          </span>
        </div>
      </div>
      <BranchPreviewRow
        label={props.previewLabel}
        branch={props.previewBranch}
        prefix={props.previewPrefix}
      />
      <p className="text-ui-xs text-muted-foreground">
        Global default ·{" "}
        <span className="font-mono">{props.globalDisplay}</span>
      </p>
      {props.warning !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {props.warning}
        </p>
      ) : null}
      {props.saveFailedNote !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {props.saveFailedNote}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={props.isPending}
          onClick={props.onOpenConfirmRemove}
        >
          Remove prefix
        </Button>
        <Button
          ref={editButtonRef}
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isPending}
          onClick={props.onEdit}
        >
          Edit prefix
        </Button>
      </div>
      <ConfirmDestructiveDialog
        open={props.confirmRemoveOpen}
        onOpenChange={props.onOpenChangeConfirmRemove}
        title="Remove repository prefix?"
        description={`This repository will go back to using the global default${
          props.globalPrefix.length > 0
            ? ` ("${props.globalPrefix}")`
            : " (no prefix)"
        }.`}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={props.isPending}
        onConfirm={props.onConfirmRemove}
      />
    </>
  );
}

function ChoiceRow(props: {
  readonly id: string;
  readonly value: "global" | "override";
  readonly active: boolean;
  readonly title: string;
  readonly detail: ReactNode;
}): ReactNode {
  return (
    <label
      htmlFor={props.id}
      data-testid={`repo-branch-prefix-choice-${props.value}`}
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 transition-colors",
        props.active
          ? "border-primary/50 bg-primary/5"
          : "border-border/50 hover:bg-muted/30",
      )}
    >
      <RadioGroupItem id={props.id} value={props.value} className="mt-0.5" />
      <div className="min-w-0">
        <span className="block text-ui-sm font-medium text-foreground">
          {props.title}
        </span>
        <span className="block truncate font-mono text-ui-xs text-muted-foreground">
          {props.detail}
        </span>
      </div>
    </label>
  );
}

/**
 * Full-branch preview for a prefix setting. Emphasizes the configurable
 * prefix and mutes the generated tail so the control reads as "prefix" rather
 * than "full branch name" - without an explanatory paragraph.
 */
function BranchPreviewRow(props: {
  readonly label: string;
  readonly branch: string;
  readonly prefix: string;
}): ReactNode {
  const split = splitBranchPreview(props.branch, props.prefix);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {props.label}
      </span>
      <code className="font-mono text-ui-sm wrap-anywhere text-right">
        {split.prefix.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{split.prefix}</span>
            <span className="text-muted-foreground">{split.rest}</span>
          </>
        ) : (
          <span className="text-foreground">{props.branch}</span>
        )}
      </code>
    </div>
  );
}

function splitBranchPreview(
  branch: string,
  prefix: string,
): { readonly prefix: string; readonly rest: string } {
  if (prefix.length > 0 && branch.startsWith(prefix)) {
    return { prefix, rest: branch.slice(prefix.length) };
  }
  return { prefix: "", rest: branch };
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) ?? path;
}

/**
 * An active regeneration-offer candidate always wins first (it must match
 * exactly what "Use new prefix" is about to stage). Otherwise the picker's
 * actual current proposal wins over an illustrative composed candidate,
 * which itself wins over the last-resort bare prefix+suffix (only reached if
 * `composeCandidateBranch` couldn't resolve this workspace at all - see its
 * doc comment).
 */
function resolveCurrentEffectiveBranch(
  activeRegenerateCandidate: string | null,
  currentProposedBranchName: string | null,
  composedCandidate: string | null,
  fallback: string,
): string {
  return (
    activeRegenerateCandidate ??
    currentProposedBranchName ??
    composedCandidate ??
    fallback
  );
}

/**
 * Editing preview: live draft example while the draft is valid, or the
 * unchanged current/staged value (relabeled) while invalid - see the ticket's
 * "preserve the currently saved effective result" requirement. Labels stay
 * short: Example / Staged branch / Current example / Current staged.
 */
function editingPreview(input: {
  readonly draftError: string | null;
  readonly draftCandidate: string | null;
  readonly currentEffectiveBranch: string;
  readonly hasStagedBranchPreview: boolean;
  readonly draftPrefix: string;
  readonly currentPrefix: string;
}): {
  readonly label: string;
  readonly value: string;
  readonly prefix: string;
} {
  if (input.draftError !== null) {
    return {
      label: input.hasStagedBranchPreview
        ? "Current staged"
        : "Current example",
      value: input.currentEffectiveBranch,
      prefix: input.currentPrefix,
    };
  }
  return {
    label: "Example",
    value: input.draftCandidate ?? input.currentEffectiveBranch,
    prefix: input.draftPrefix,
  };
}
