/**
 * FILE LINKS ARE NOT LINKS HERE, and that is the honest answer rather than a shortcut.
 * The alternative was worse in both directions: with no `MarkdownLinkContext` the shared anchor calls `preventDefault()` and then optional-calls a null policy, so the link looks live and silently does nothing; and a policy that merely declines would toast "couldn't open link" on every click, which is the same dead link with noise.
 */
import type { ReactNode } from "react";
import { MarkdownAnchor } from "@/markdown/components/markdown-anchor";
import { classifyHref } from "@/markdown/links/classify-href";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export function CommGraphMarkdownAnchor(props: Record<string, unknown>) {
  const href = typeof props.href === "string" ? props.href : undefined;
  const children = props.children as ReactNode;
  if (href !== undefined && classifyHref(href).kind === "file") {
    return (
      // The href goes in the hint so the path itself stays recoverable.
      // The app mounts a `TooltipProvider` at its root, so the wrapper is always renderable here.
      <TooltipWrapper
        label={`${href} - file links can't be resolved here; this panel isn't bound to a workspace`}
        side="bottom"
        sideOffset={4}
        align="center"
      >
        <span
          data-testid="comm-graph-unresolvable-link"
          className="cursor-default underline decoration-dotted underline-offset-2 opacity-70"
        >
          {children}
        </span>
      </TooltipWrapper>
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
