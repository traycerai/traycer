import { type ReactNode } from "react";
import { FileWarning, Trash2 } from "lucide-react";
import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useWorkspaceReadFile } from "@/hooks/workspace/use-read-file-query";
import { TraycerMarkdown } from "@/markdown";
import { cn } from "@/lib/utils";
import {
  SKILL_ENTRY_FILE,
  stripSkillFrontmatter,
} from "./provider-skill-markdown";
import type { SkillRemovability } from "./provider-skill-removable";
import {
  SKILL_SOURCE_LABEL,
  SKILL_SOURCE_TONE,
} from "./provider-skill-source-badge";

/**
 * The expanded view of one skill: its full SKILL.md, rendered.
 *
 * The list row only ever had frontmatter (name + description), which is the
 * agent's INDEX of a skill, not the skill - the instructions it will actually
 * follow were unreadable from the app. This mirrors the plan card's expand
 * (`plan-segment.tsx`): same three-row dialog shape, same scrollable markdown
 * body, so the two "show me the whole document" surfaces behave alike.
 *
 * Content is read from disk on open rather than carried on the list response.
 * `providerSkillSchema` has no body field, and adding one would put every
 * skill's full text on every `providers.skills.list` - paid on each poll, for
 * a body that is read only when someone opens it.
 *
 * Mounted only while a skill is open (the caller renders it conditionally),
 * which is why `skill` is not nullable: an always-mounted version would have to
 * hold a disabled `useHostQuery` on every Skills tab render, and its host
 * dependency would then reach every consumer of the tab - including test
 * harnesses that mount the panel with no QueryClient at all.
 *
 * HOST DEPENDENCY: `workspace.readFile` treats `workspacePath` as the
 * containment root and does NOT require it to be a bound workspace, which is
 * what lets a skill directory under `~/.agents/skills` (or a provider data
 * home) be read at all. Hardening that resolver to accept only known roots
 * would break this surface; `SKILL.md` would then need its own read verb.
 */
export function ProviderSkillDetailDialog(props: {
  readonly skill: ProviderSkill;
  readonly removal: SkillRemovability;
  readonly removePending: boolean;
  /**
   * True while ANY skill mutation is in flight, not just this removal.
   *
   * Separate from `removePending` on purpose: every skill mutation shares one
   * `useMutation` observer, and a second `mutate()` on it replaces the first
   * call's `onSuccess`/`onError`, so starting a removal on top of a pending
   * create or import can swallow that operation's failure entirely. Removal is
   * therefore disabled by any of them - but the SPINNER stays on
   * `removePending`, or an unrelated create would make this button claim to be
   * doing the removing.
   */
  readonly removeDisabled: boolean;
  /**
   * A failed removal. Surfaced HERE rather than only on the tab behind this
   * dialog, which the user cannot see while it is open.
   */
  readonly removeError: string | null;
  readonly onRequestRemove: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const { skill, removal } = props;
  const fileQuery = useWorkspaceReadFile(skill.path, SKILL_ENTRY_FILE);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="grid max-h-[min(86dvh,calc(100dvh-2rem))] w-[min(92vw,52rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,52rem)]">
        <DialogHeader className="space-y-2 border-b border-border/40 px-5 py-4 text-left">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="min-w-0 truncate text-ui-lg">
              {skill.name}
            </DialogTitle>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-ui-xs",
                SKILL_SOURCE_TONE[skill.source],
              )}
            >
              {SKILL_SOURCE_LABEL[skill.source]}
            </span>
          </div>
          <DialogDescription className="text-ui-sm">
            {skill.description !== null && skill.description.length > 0
              ? skill.description
              : "No description in this skill's frontmatter."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {props.removeError === null ? null : (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
              {props.removeError}
            </div>
          )}
          <SkillBody
            pending={fileQuery.isPending}
            error={
              fileQuery.isError
                ? fileQuery.error.message
                : (fileQuery.data?.error ?? null)
            }
            content={fileQuery.data?.content ?? null}
            truncated={fileQuery.data?.truncated ?? false}
          />
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center gap-3 rounded-none border-t border-border/40 px-5 py-3 sm:justify-between">
          {/* The path stays the footer's primary content - it answers "which of
              the four roots is this one in?", which the name alone cannot. */}
          <StartTruncatedText className="block min-w-0 flex-1 font-mono text-ui-xs text-muted-foreground">
            {skill.path}
          </StartTruncatedText>
          {removal.kind === "blocked" ? (
            // Shrinkable and wrapping, not `shrink-0`: the reason is a full
            // sentence and would otherwise squeeze the path to nothing (or
            // overflow the footer outright) on a narrow dialog.
            <span className="min-w-0 text-right text-ui-xs text-muted-foreground">
              {removal.reason}
            </span>
          ) : null}
          {removal.kind === "removable" ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="shrink-0"
              disabled={props.removeDisabled}
              onClick={props.onRequestRemove}
            >
              {props.removePending ? (
                <MutedAgentSpinner />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillBody(props: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly content: string | null;
  readonly truncated: boolean;
}): ReactNode {
  if (props.pending) {
    return (
      <div className="flex items-center gap-2 py-4 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        Loading skill
      </div>
    );
  }
  // A readFile that resolves with `content: null` is the ordinary miss (no
  // SKILL.md, unreadable, outside the root) - it reports through `error`, not
  // by rejecting, so this arm must cover both shapes or a missing file would
  // render as an empty document.
  if (props.error !== null || props.content === null) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm text-amber-900 dark:text-amber-200">
        <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {props.error ?? `Could not read ${SKILL_ENTRY_FILE}.`}
        </span>
      </div>
    );
  }
  const body = stripSkillFrontmatter(props.content);
  return (
    <>
      {props.truncated ? (
        <p className="mb-3 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-ui-xs text-muted-foreground">
          This skill is large — showing the beginning of the file.
        </p>
      ) : null}
      {body.trim().length === 0 ? (
        <p className="py-3 text-ui-sm text-muted-foreground">
          This skill has frontmatter but no instructions.
        </p>
      ) : (
        <TraycerMarkdown
          className={null}
          proseSize="normal"
          components={null}
          remarkPlugins={null}
          rehypePlugins={null}
          quotable={false}
          isStreaming={false}
        >
          {body}
        </TraycerMarkdown>
      )}
    </>
  );
}
