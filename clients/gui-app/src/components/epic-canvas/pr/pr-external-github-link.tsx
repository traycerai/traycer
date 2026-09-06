import { useCallback, type MouseEvent, type ReactNode } from "react";
import { useOpenLinkWithPending } from "@/lib/links/open-link";
import { onMiddleClick } from "@/lib/dom/on-middle-click";

/**
 * Every external GitHub anchor on the PR surfaces, in one place.
 *
 * Routed through {@link useOpenLinkWithPending} rather than left as a bare
 * `target="_blank"` link: a plain anchor opens a second, unmanaged browser
 * surface instead of honouring the user's `github` link setting (A1). The
 * `href` stays for anchor semantics (copy link, hover preview, middle-click
 * intent); `target`/`rel` go, because the click never navigates natively.
 *
 * A click landing while the OS handoff is still in flight is dropped, and the
 * anchor reports `aria-disabled` meanwhile: each call fires a fresh bridge
 * request, so a double click would otherwise open the browser twice (R10).
 */
export function PrExternalGitHubLink(props: {
  readonly href: string;
  readonly className: string;
  /** `undefined` for anchors no test targets by id. */
  readonly testId: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const { isPending, openLink } = useOpenLinkWithPending();
  const { href } = props;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      if (isPending) return;
      void openLink(href, "github", event);
    },
    [href, isPending, openLink],
  );

  return (
    <a
      href={href}
      aria-disabled={isPending}
      className={props.className}
      data-testid={props.testId}
      onClick={handleClick}
      onAuxClick={onMiddleClick(handleClick)}
    >
      {props.children}
    </a>
  );
}
