/**
 * The action half of the `html` viewer entry (D32).
 *
 * An `.html` epic file renders in the CODE viewer - the registry points the
 * `html` family at `WorkspaceFileRenderer`, the same component `text` uses -
 * and this is the affordance beside it. There is no preview arm: a sandboxed
 * iframe is explicitly out of scope, and an epic file is attacker-authored
 * content, so the one place it may run is a real browser tab on the host's
 * own machine.
 *
 * ## Why the tile hands the url to a browser TILE and never to a link
 *
 * `epic.openFileInBrowser` answers with a `127.0.0.1` url on the epic's own
 * token-scoped static server, which the ANSWERING host starts. That url
 * resolves on that host's machine and nowhere else, so `useOpenLink()` - whose
 * whole job is deciding in-app versus the user's own browser - has no honest
 * "external" answer for it. `useOpenBrowserUrl` is the tile-opening seam for
 * exactly this case: it goes through `useEpicTileNavigation().openTile` with a
 * browser-session tile ref, dedupes against a tab already showing the page,
 * and surfaces a reason instead of silently falling out to the OS browser.
 *
 * The bytes are never served from the cloud origin as `text/html` - a signed
 * url is a url on a SHARED storage host, and one epic's html running there
 * would be same-origin with every other tenant's.
 */
import { useCallback, type ReactNode } from "react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEpicOpenFileInBrowser } from "@/hooks/epic/use-epic-files";
import { useOpenBrowserUrl } from "@/lib/links/open-browser-url";

export interface HtmlOpenInBrowserActionProps {
  /**
   * The epic that OWNS the file - the manifest and the static server are both
   * scoped to it, and it is what the RPC addresses.
   */
  readonly fileEpicId: string;
  /** The manifest path, the second half of the same address. */
  readonly path: string;
  /**
   * The epic whose canvas the resulting browser tile lands on, and the canvas
   * tab it lands in. Separate from {@link fileEpicId} because a tile ref
   * carries its own epic id: they are the same epic today, and the surface
   * that opens the tab is the one that decides where the tab goes.
   */
  readonly epicId: string;
  readonly viewTabId: string;
}

export function HtmlOpenInBrowserAction(
  props: HtmlOpenInBrowserActionProps,
): ReactNode {
  const openInBrowser = useEpicOpenFileInBrowser(props.fileEpicId, props.path);
  const openBrowserUrl = useOpenBrowserUrl();

  const { mutate } = openInBrowser;
  const { epicId, fileEpicId, path, viewTabId } = props;
  const onClick = useCallback((): void => {
    mutate(
      { epicId: fileEpicId, path },
      {
        onSuccess: (response) => {
          openBrowserUrl({
            url: response.url,
            // A button press is a plain single open: no modifier reaches here,
            // so the intent must say so rather than inheriting a stale one.
            modifiers: { shift: false, alt: false, middle: false },
            epicId,
            viewTabId,
          });
        },
      },
    );
  }, [mutate, openBrowserUrl, epicId, fileEpicId, path, viewTabId]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={openInBrowser.isPending}
      onClick={onClick}
      data-testid="epic-file-open-in-browser"
    >
      {/* The label never changes while the request is in flight - the spinner
          sits beside it - so the button never renames itself mid-press. */}
      {openInBrowser.isPending ? (
        <AgentSpinningDots
          className="size-4"
          testId="epic-file-open-in-browser-spinner"
          variant={undefined}
        />
      ) : null}
      Open in browser
    </Button>
  );
}
