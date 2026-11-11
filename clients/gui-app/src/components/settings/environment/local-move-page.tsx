import type { ReactNode } from "react";
import { MoveProgressOr } from "@/components/settings/environment/local-row-note";
import { SANDBOXES } from "@/components/settings/environment/sandboxes-page.definitions";
import { STORAGE } from "@/components/settings/environment/storage-page.definitions";
import { MCP_SERVERS } from "@/components/settings/panels/mcp-servers.definitions";
import { SKILLS } from "@/components/settings/panels/skills.definitions";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Button } from "@/components/ui/button";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

interface LocalMovePageCopy {
  readonly title: string;
  readonly description: string;
  /** What the page gives, in one line. */
  readonly gain: string;
  /** What moving the computer adds on it. */
  readonly afterMove: (hostName: string) => string;
}

function moveToUseHere(hostName: string): string {
  return `Move ${hostName} to Personal to add and use them here.`;
}

/**
 * The pages a computer that has not moved has none of: a cloud
 * configuration's. Under a Local pick each says what it gives and offers the
 * one move that gives it.
 */
const LOCAL_MOVE_PAGES: ReadonlyMap<SettingsSectionId, LocalMovePageCopy> =
  new Map<SettingsSectionId, LocalMovePageCopy>([
    [
      "mcp-servers",
      {
        title: MCP_SERVERS.page.label,
        description: MCP_SERVERS.page.description,
        gain: "Add an MCP server once and every coding agent can use it, on this computer, your other computers and your sandboxes.",
        afterMove: moveToUseHere,
      },
    ],
    [
      "skills",
      {
        title: SKILLS.page.label,
        description: SKILLS.page.description,
        gain: "Add a skill once and every coding agent can use it, on this computer, your other computers and your sandboxes.",
        afterMove: moveToUseHere,
      },
    ],
    [
      "sandboxes",
      {
        title: SANDBOXES.page.label,
        description: SANDBOXES.page.description,
        gain: "You can start a sandbox from any task now.",
        afterMove: (hostName) =>
          `Move ${hostName} to Personal and your sandboxes get the settings you set up here, and agents on ${hostName} can start sandboxes too.`,
      },
    ],
    [
      "storage",
      {
        title: STORAGE.page.label,
        description: STORAGE.page.description,
        gain: "Keep chats in the cloud instead of on disk, and clear out tasks nobody has used.",
        afterMove: (hostName) =>
          `Move ${hostName} to Personal to choose this once for every computer you use.`,
      },
    ],
  ]);

/**
 * `section`'s page under the Environment pick: on a Local pick, MCP servers,
 * Skills, Sandboxes and Storage are this offer in place of their panel;
 * every other page, and every page on any other pick, is `children`.
 */
export function LocalMovePageOr(props: {
  readonly section: SettingsSectionId;
  readonly children: ReactNode;
}): ReactNode {
  const pick = useEnvironmentPick();
  const copy = LOCAL_MOVE_PAGES.get(props.section);
  if (pick.kind !== "local" || copy === undefined) return props.children;
  return (
    <LocalMovePage copy={copy} hostId={pick.hostId} hostName={pick.hostName} />
  );
}

function LocalMovePage(props: {
  readonly copy: LocalMovePageCopy;
  readonly hostId: string;
  readonly hostName: string;
}): ReactNode {
  const { copy, hostId, hostName } = props;
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  return (
    <SettingsPanelShell title={copy.title} description={copy.description}>
      <div
        className="flex flex-col items-start gap-3 p-5 text-ui-sm"
        data-testid="local-move-page"
      >
        <p className="max-w-[64ch] font-medium">{copy.gain}</p>
        <MoveProgressOr hostId={hostId} hostName={hostName}>
          <p className="max-w-[64ch] text-muted-foreground">
            {copy.afterMove(hostName)}
          </p>
          <Button
            type="button"
            size="sm"
            data-testid="local-move-page-move"
            onClick={() => openMoveSheet({ hostId, hostName })}
          >
            Move to Personal
          </Button>
        </MoveProgressOr>
      </div>
    </SettingsPanelShell>
  );
}
