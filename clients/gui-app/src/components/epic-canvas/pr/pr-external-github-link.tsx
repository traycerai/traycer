import { useCallback, type MouseEvent, type ReactNode } from "react";
import { useOpenLink } from "@/lib/links/open-link";

/**
 * Every external GitHub anchor on the PR surfaces, in one place.
 *
 * Routed through {@link useOpenLink} rather than left as a bare
 * `target="_blank"` link: a plain anchor opens a second, unmanaged browser
 * surface instead of honouring the user's `github` link setting (A1). The
 * `href` stays for anchor semantics (copy link, hover preview, middle-click
 * intent); `target`/`rel` go, because the click never navigates natively.
 */
export function PrExternalGitHubLink(props: {
  readonly href: string;
  readonly className: string;
  /** `undefined` for anchors no test targets by id. */
  readonly testId: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const openLink = useOpenLink();
  const { href } = props;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      openLink(href, "github", event);
    },
    [href, openLink],
  );

  return (
    <a
      href={href}
      className={props.className}
      data-testid={props.testId}
      onClick={handleClick}
    >
      {props.children}
    </a>
  );
}
