import type { ReactNode } from "react";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { Button } from "@/components/ui/button";
import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { hostLifecycleRunLine } from "@/lib/host/host-lifecycle-copy";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * The local host Overview's lifecycle link on the header fact line - "keeps
 * running after quit" - linking to Settings → General → "When you quit
 * Traycer". The same promise the tray shows, so a Linked user sees why the
 * host will stop and a Background user sees why it is still running. A host
 * started in a terminal reads "started in a terminal" instead, as the tray
 * does: no mode governs it.
 *
 * Renders nothing on a shell with no lifecycle bridge, or until it is read.
 * The leading middot is inside this render, so a null answer leaves no separator.
 */
export function HostLifecycleModeLine(): ReactNode {
  const viewQuery = useRunnerHostLifecycleQuery();
  const view = viewQuery.data;
  if (view === undefined) return null;
  const line = hostLifecycleRunLine(view);
  if (line === null) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="min-w-0 text-ui-xs text-muted-foreground">
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          onClick={() => {
            // Armed before navigating, as a search result's reveal is: the
            // watcher beside the panel outlet polls for the anchor until its
            // deadline, so the order of the two never matters.
            useSettingsSearchStore
              .getState()
              .requestReveal(
                "general",
                GENERAL.definitions.hostLifecycle.anchor,
              );
            navigateToSettingsSection("general");
          }}
          data-testid="host-overview-lifecycle-line"
        >
          {line}
        </Button>
      </span>
    </>
  );
}
