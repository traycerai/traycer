import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * Every external GitHub anchor on the PR surfaces, in one place.
 *
 * Routed through the RunnerHost bridge rather than left as a bare
 * `target="_blank"` link: in the desktop shell a plain anchor opens a second,
 * unmanaged browser surface instead of the user's actual browser. With no
 * RunnerHost bound (the web client) the handler is a NO-OP that deliberately
 * does not call `preventDefault`, so the anchor's own native new-tab
 * navigation still applies - the web client has no bridge to route through and
 * blocking it there would break the link outright.
 *
 * A click landing while the bridge request is still in flight is dropped:
 * `mutate` fires a fresh RunnerHost request per call, so a double click would
 * otherwise open the browser twice.
 */
export function PrExternalGitHubLink(props: {
  readonly href: string;
  readonly className: string;
  /** `undefined` for anchors no test targets by id. */
  readonly testId: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const isPending = openExternalLink.isPending;
  const { href } = props;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      if (runnerHost === null) return;
      event.preventDefault();
      if (isPending) return;
      openExternalLink.mutate(href);
    },
    [href, isPending, openExternalLink, runnerHost],
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={props.className}
      aria-disabled={isPending}
      data-testid={props.testId}
      onClick={handleClick}
    >
      {props.children}
    </a>
  );
}
