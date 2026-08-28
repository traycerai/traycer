import { useRef, useState, type ReactNode } from "react";
import { FilterIcon } from "lucide-react";

import type { GithubMentionRepository } from "@traycer/protocol/host/mention-schemas";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  asIssueMentionFilter,
  asPullRequestMentionFilter,
  githubRepositoryQualification,
  isDefaultGithubMentionFilter,
  withGithubMentionRepository,
  type GithubMentionFilter,
} from "@/lib/composer/mentions";
import type { MentionStepChromeFilter } from "@/lib/composer/mentions";
import {
  restoreUnrepresentedRepositorySelection,
  selectGithubMentionFilter,
  useGithubMentionFilterStore,
} from "@/stores/composer/github-mention-filter-store";
import { cn } from "@/lib/utils";

/**
 * The funnel in the PR/Issue section's top bar.
 *
 * Focus is the whole design problem here, and it is solved at this layer
 * rather than in the editor:
 *
 * - `modal={false}` - a modal Radix popover installs outside-inert and a
 *   scroll lock, which would fight the mention menu's own `RemoveScroll`.
 * - The popover TAKES REAL FOCUS. The groups are Radix `RadioGroup`s, which is
 *   what actually supplies the documented keyboard model - roving focus, arrow
 *   navigation, and Space activation - rather than plain buttons, which have
 *   none of it and which activate on KEYUP (so a Space handled as a
 *   printable-character close would unmount the button before its own click
 *   ever landed).
 *   While the popover holds focus the editor's ProseMirror `handleKeyDown`
 *   never sees a key at all, so Escape is contained by Radix's own layer and
 *   the mention menu behind it stays open. That is verified behaviour, not an
 *   assumption: the tiptap suggestion session is document-state-driven and
 *   nothing in the app exits it on editor blur.
 * - `onCloseAutoFocus` is overridden because Radix's default restores focus to
 *   the TRIGGER, which would strand the caret outside the composer. The
 *   restore is DEFERRED: the content unmounts after the handler runs, and a
 *   focus set synchronously inside it is dropped when the focused node goes.
 *
 * Selections apply instantly and the popover stays open, so several groups can
 * be adjusted in one visit.
 */

export interface GithubMentionFilterPopoverProps {
  readonly filter: MentionStepChromeFilter;
  /**
   * Returns focus (and the caret) to the composer when the popover closes,
   * inserting `resumeText` at the caret when the close was caused by the user
   * typing.
   *
   * The keystroke that means "I am done filtering, back to typing" is consumed
   * by the radio group before the popover can close, so it has to be handed
   * over explicitly rather than replayed. One call rather than two so the
   * character lands in the same focus operation that restores the caret.
   */
  readonly onReturnFocus: (resumeText: string | null) => void;
}

export function GithubMentionFilterPopover(
  props: GithubMentionFilterPopoverProps,
): ReactNode {
  const { filter: chrome, onReturnFocus } = props;
  const [open, setOpen] = useState(false);
  // Not state: this is a handoff between one event and the close that follows
  // it in the same interaction, and re-rendering on it would be noise.
  const resumeTypingRef = useRef<string | null>(null);
  // Whether the close now in progress came from an OUTSIDE interaction. Same
  // event-to-close handoff shape as `resumeTypingRef`: `onInteractOutside`
  // fires before Radix closes, `onCloseAutoFocus` consumes and resets it.
  const closedByOutsideInteractionRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setFilter = useGithubMentionFilterStore((state) => state.setFilter);
  // The STORED repository selection, read only so writes made through the
  // reconciled projection can keep an out-of-scope one alive (see
  // `applyKeepingHiddenSelection`). Selected down to the repository, which the
  // section-shape coercion carries by reference, so the subscription is
  // referentially stable across unrelated store writes.
  const storedRepository = useGithubMentionFilterStore(
    (state) =>
      selectGithubMentionFilter(state, chrome.epicId, chrome.section)
        .repository,
  );
  // The RECONCILED selection the list is applying, not the raw store. Reading
  // the store here would let the dot claim a filter is active while the list
  // shows everything.
  const filter = chrome.selected;
  const isDefault = isDefaultGithubMentionFilter(chrome.section, filter);

  const apply = (next: GithubMentionFilter): void => {
    // A landing composer has no task to key stickiness to, so its selection is
    // in-session only (the store drops that bucket from persistence). It is
    // still a real selection: a funnel that refused every click would be a
    // broken control, not a simpler one.
    setFilter({ epicId: chrome.epicId, section: chrome.section, filter: next });
  };

  // State/Involvement edits are made THROUGH the reconciled projection, whose
  // `repository` may be a display fallback for a selection the scope cannot
  // currently represent - written back verbatim, flipping State would delete
  // the selection the store promised to remember across a detach/re-attach.
  // The Repository group stays on the plain `apply`: its writes ARE
  // repository decisions, including the explicit clear.
  const applyKeepingHiddenSelection = (next: GithubMentionFilter): void => {
    apply(
      restoreUnrepresentedRepositorySelection(
        chrome.section,
        next,
        storedRepository,
        chrome.repositories,
      ),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <TooltipWrapper
        label={isDefault ? "Filter" : "Filter (active)"}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={isDefault ? "Filter" : "Filter (active)"}
            className="relative -my-1 text-muted-foreground/70 hover:text-foreground"
            onMouseDown={(event) => {
              // The composer must not lose focus to the mousedown itself; the
              // popover takes focus on open, deliberately and afterwards.
              event.preventDefault();
            }}
          >
            <FilterIcon className="size-3.5" />
            {isDefault ? null : (
              <span
                data-testid="github-mention-filter-dot"
                className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500"
              />
            )}
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[min(90vw,14rem)] gap-0 p-0"
        onOpenAutoFocus={undefined}
        onInteractOutside={(event) => {
          // An outside interaction moves focus where the user POINTED, and
          // returning the caret to the composer over it would steal focus
          // from the control they just chose - the next keystrokes would land
          // in the mention query instead of their target. The trigger is
          // exempt: closing from the funnel button is a return-to-composer
          // path, like Escape and the typing handoff.
          const target = event.target;
          if (target instanceof Node && triggerRef.current?.contains(target)) {
            return;
          }
          closedByOutsideInteractionRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          // Always prevented: Radix's default would focus the TRIGGER, which
          // is right for neither path - a return-to-composer close wants the
          // caret, and an outside click already focused its own target.
          event.preventDefault();
          const typed = resumeTypingRef.current;
          resumeTypingRef.current = null;
          if (closedByOutsideInteractionRef.current) {
            closedByOutsideInteractionRef.current = false;
            return;
          }
          queueMicrotask(() => {
            onReturnFocus(typed);
          });
        }}
        onKeyDown={(event) => {
          // A printable character means the user has gone back to querying:
          // close and hand the keystroke's intent back to the composer rather
          // than swallowing it inside a radio group.
          //
          // Space is NOT that. `event.key` for the space bar is `" "` - length
          // 1, no modifiers - so it reads as printable, but inside a radio
          // group it is the ACTIVATION key. Treating it as "resume typing"
          // both failed to select the option and dismissed the popover.
          if (event.key === " ") return;
          if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
          // The character is CARRIED rather than replayed. By the time this
          // runs the key event has already been delivered to the radio group,
          // and focus does not return to the editor until a microtask after
          // the content unmounts - so the editor never sees this keystroke and
          // the first letter of the resumed query was silently lost. Closing
          // is not enough; the character has to be handed over with it.
          resumeTypingRef.current = event.key;
          setOpen(false);
        }}
      >
        {chrome.section === "pull-requests" ? (
          <PullRequestGroups
            filter={filter}
            onApply={applyKeepingHiddenSelection}
          />
        ) : (
          <IssueGroups filter={filter} onApply={applyKeepingHiddenSelection} />
        )}
        {chrome.repositories.length > 1 ? (
          <FilterGroup
            label="Repository"
            value={
              filter.repository === null
                ? ALL_REPOSITORIES_VALUE
                : repositoryKey(filter.repository)
            }
            options={[
              { value: ALL_REPOSITORIES_VALUE, label: "All repositories" },
              ...chrome.repositories.map((repository) => ({
                value: repositoryKey(repository),
                label: repositoryLabel(repository, chrome.repositories),
              })),
            ]}
            onSelect={(value) => {
              // Resolved back to the repository OBJECT by key rather than
              // reconstructed from the label: two repos in scope can share a
              // `repo` name across owners, and only the full key tells them
              // apart.
              const repository =
                chrome.repositories.find(
                  (candidate) => repositoryKey(candidate) === value,
                ) ?? null;
              apply(
                withGithubMentionRepository(chrome.section, filter, repository),
              );
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// Sentinel for the "no repository filter" radio. A real key always has two
// slashes, so it cannot collide with one.
const ALL_REPOSITORIES_VALUE = "*";

function repositoryKey(repository: GithubMentionRepository): string {
  return `${repository.githubHost}/${repository.owner}/${repository.repo}`;
}

/**
 * The shortest label that is still unambiguous within THIS scope.
 *
 * Bare `repo` reads best and is right almost always, but the key above exists
 * precisely because a scope can hold `acme/api` and `contoso/api`, or the same
 * `owner/repo` on two GitHub hosts. Labelling every option `api` in that scope
 * leaves the user picking between two identical radios - the one case the key
 * was written to handle, made invisible in the UI. Widening happens per
 * collision rather than globally, so an ordinary single-owner scope keeps the
 * short labels.
 */
function repositoryLabel(
  repository: GithubMentionRepository,
  all: ReadonlyArray<GithubMentionRepository>,
): string {
  // The escalation itself is `githubRepositoryQualification`'s - ONE walk
  // decides how much of an identity a collision forces, here and on every row
  // surface, so the two cannot drift. Only the FORMAT diverges, deliberately:
  // a radio label leads with the name being chosen and parenthesizes the
  // host, where row surfaces print the `host/owner/repo` path being typed.
  const qualified = `${repository.owner}/${repository.repo}`;
  switch (githubRepositoryQualification(repository, all)) {
    case "none":
    case "repo":
      return repository.repo;
    case "owner-repo":
      return qualified;
    case "host-owner-repo":
      return `${qualified} (${repository.githubHost})`;
  }
}

const PULL_REQUEST_STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

const PULL_REQUEST_INVOLVEMENT_OPTIONS = [
  { value: "everyone", label: "Everyone" },
  { value: "review-requested", label: "Review requested" },
  { value: "assigned", label: "Assigned to me" },
  { value: "authored", label: "Authored by me" },
] as const;

const ISSUE_STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

const ISSUE_INVOLVEMENT_OPTIONS = [
  { value: "everyone", label: "Everyone" },
  { value: "assigned", label: "Assigned to me" },
  { value: "authored", label: "Authored by me" },
  { value: "mentions", label: "Mentions me" },
] as const;

interface GroupsProps {
  readonly filter: GithubMentionFilter;
  readonly onApply: (next: GithubMentionFilter) => void;
}

function PullRequestGroups(props: GroupsProps): ReactNode {
  const { filter, onApply } = props;
  const current = asPullRequestMentionFilter(filter);
  return (
    <>
      <FilterGroup
        label="State"
        value={current.state}
        options={PULL_REQUEST_STATE_OPTIONS}
        onSelect={(value) => {
          const state = PULL_REQUEST_STATE_OPTIONS.find(
            (option) => option.value === value,
          );
          if (state === undefined) return;
          onApply({ ...current, state: state.value });
        }}
      />
      <FilterGroup
        label="Involvement"
        value={current.involvement}
        options={PULL_REQUEST_INVOLVEMENT_OPTIONS}
        onSelect={(value) => {
          const involvement = PULL_REQUEST_INVOLVEMENT_OPTIONS.find(
            (option) => option.value === value,
          );
          if (involvement === undefined) return;
          onApply({ ...current, involvement: involvement.value });
        }}
      />
    </>
  );
}

function IssueGroups(props: GroupsProps): ReactNode {
  const { filter, onApply } = props;
  const current = asIssueMentionFilter(filter);
  return (
    <>
      <FilterGroup
        label="State"
        value={current.state}
        options={ISSUE_STATE_OPTIONS}
        onSelect={(value) => {
          const state = ISSUE_STATE_OPTIONS.find(
            (option) => option.value === value,
          );
          if (state === undefined) return;
          onApply({ ...current, state: state.value });
        }}
      />
      <FilterGroup
        label="Involvement"
        value={current.involvement}
        options={ISSUE_INVOLVEMENT_OPTIONS}
        onSelect={(value) => {
          const involvement = ISSUE_INVOLVEMENT_OPTIONS.find(
            (option) => option.value === value,
          );
          if (involvement === undefined) return;
          onApply({ ...current, involvement: involvement.value });
        }}
      />
    </>
  );
}

interface FilterGroupOption {
  readonly value: string;
  readonly label: string;
}

/**
 * One radio group, on the shared Radix primitive.
 *
 * The primitive is doing real work here, not decoration: it supplies roving
 * focus (one tab stop per group), arrow navigation within the group, and Space
 * activation - the keyboard model both the core flows and the tech plan
 * specify. Hand-rolled `role="radio"` buttons had none of it, and a native
 * button additionally activates on keyup rather than keydown.
 *
 * `onSelect` takes the raw string because that is what the DOM hands back; each
 * caller narrows it against its own option list rather than asserting, so a
 * value from the other section's group can never reach a filter.
 */
function FilterGroup(props: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<FilterGroupOption>;
  readonly onSelect: (value: string) => void;
}): ReactNode {
  return (
    <div className="border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="mb-1 text-overline font-medium uppercase text-muted-foreground/70">
        {props.label}
      </div>
      <RadioGroup
        aria-label={props.label}
        value={props.value}
        onValueChange={props.onSelect}
        className="gap-0.5"
      >
        {props.options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-ui-xs",
              "hover:bg-accent/40 has-[:focus-visible]:bg-accent/60",
              props.value === option.value
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            <RadioGroupItem value={option.value} className="size-3" />
            <span className="min-w-0 truncate">{option.label}</span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
