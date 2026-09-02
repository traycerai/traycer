import type { MouseEvent, ReactNode } from "react";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * Composer prose links leave through the one link seam (A6) like every other
 * app-rendered link - a bare anchor would navigate the renderer itself.
 * `applyMarks` is a plain function, so the hook lives in this one-element
 * component instead of at the call site (and in its own file, so the mark
 * renderer stays a component-free module).
 */
export function ComposerMarkLink(props: {
  readonly href: string;
  readonly children: ReactNode;
}): ReactNode {
  const openLink = useOpenLink();
  return (
    <a
      href={props.href}
      className="underline decoration-1 underline-offset-2"
      rel="noopener noreferrer"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void openLink(props.href, "markdown", event);
      }}
    >
      {props.children}
    </a>
  );
}
