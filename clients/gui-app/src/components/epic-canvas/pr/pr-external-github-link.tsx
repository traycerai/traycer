import { useCallback, type MouseEvent, type ReactNode } from "react";
import { useLinkOpenInFlight } from "@/lib/links/use-link-open-in-flight";
import { onMiddleClick } from "@/lib/links/anchor-aux-click";

/**
 * Every external GitHub anchor on the PR surfaces, in one place.
 *
 * Routed through {@link useLinkOpenInFlight} rather than left as a bare
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
  const openLink = useLinkOpenInFlight();
  const { href } = props;
  const { open } = openLink;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      open(href, "github", event);
    },
    [href, open],
  );

  return (
    <a
      href={href}
      aria-disabled={openLink.pending}
      className={props.className}
      data-testid={props.testId}
      onClick={handleClick}
      onAuxClick={onMiddleClick(handleClick)}
    >
      {props.children}
    </a>
  );
}
