/**
 * Anchor rendering for message bodies in the comm-graph detail panels.
 *
 * FILE LINKS ARE NOT LINKS HERE, and that is the honest answer rather than a
 * shortcut. Chat can resolve `[source](./src/a.ts)` because a chat tile knows
 * its own worktree roots; this panel cannot. It is epic-scoped and fans in
 * across hosts, so a relative path in a captured message belongs to whichever
 * agent sent it, on whichever host, with whichever worktree binding - none of
 * which this surface has.
 *
 * The alternative was worse in both directions: with no `MarkdownLinkContext`
 * the shared anchor calls `preventDefault()` and then optional-calls a null
 * policy, so the link looks live and silently does nothing; and a policy that
 * merely declines would toast "couldn't open link" on every click, which is the
 * same dead link with noise. So the link is rendered as what it is - the path
 * text, marked as unresolvable - and the reader can still read and copy it.
 *
 * External links are untouched: those the shared anchor CAN open (through the
 * runner host), with no surface policy needed.
 */
import type { ReactNode } from "react";
import { MarkdownAnchor } from "@/markdown/components/markdown-anchor";
import { classifyHref } from "@/markdown/links/classify-href";

export function CommGraphMarkdownAnchor(props: Record<string, unknown>) {
  const href = typeof props.href === "string" ? props.href : undefined;
  const children = props.children as ReactNode;
  if (href !== undefined && classifyHref(href).kind === "file") {
    return (
      // A native `title` rather than a Radix tooltip: this renders deep inside
      // a markdown body on several surfaces, and a row should not require a
      // `TooltipProvider` ancestor to render its own text. The href goes in the
      // hint so the path itself stays recoverable.
      <span
        data-testid="comm-graph-unresolvable-link"
        title={`${href} - file links can't be resolved here; this panel isn't bound to a workspace`}
        className="cursor-default underline decoration-dotted underline-offset-2 opacity-70"
      >
        {children}
      </span>
    );
  }
  return (
    <MarkdownAnchor
      href={href}
      title={typeof props.title === "string" ? props.title : undefined}
      className={
        typeof props.className === "string" ? props.className : undefined
      }
    >
      {children}
    </MarkdownAnchor>
  );
}
