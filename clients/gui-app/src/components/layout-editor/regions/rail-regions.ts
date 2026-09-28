import {
  COMMENTS_AUTO_HINT,
  getLeftPanelDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  SHOW_HIDE_VERBS,
  type LayoutRegion,
} from "@/components/layout-editor/regions/region-grammar";
import { railStateWord } from "@/components/layout-editor/regions/region-state-words";
import { leftPanelIdForRailRegion } from "@/lib/layout/rail";
import type { RailRegionId } from "@/lib/layout/region-id";

/**
 * The sidebar rail's nine regions, which are nine because each icon is
 * hoverable, selectable and separately shown or hidden.
 *
 * Everything they say identically is said once in {@link railRegionBase}, and
 * their name and icon come from `LEFT_PANEL_DEFINITIONS` rather than from a
 * second list here - which is why the Chats panel is "Agents" in the index
 * (C-35).
 */

const RAIL_ROWS = [{ kind: "position-order", group: "rail" }] as const;

function railRegionBase<K extends RailRegionId>(
  regionId: K,
  keywords: ReadonlyArray<string>,
  hint: string | null,
): Omit<LayoutRegion<K>, "id"> {
  const definition = getLeftPanelDefinition(leftPanelIdForRailRegion(regionId));
  return {
    name: definition.title,
    surface: "sidebar",
    icon: definition.icon,
    where: "Sidebar - icon rail",
    whereByHost: null,
    hint,
    keywords: [...keywords, "sidebar", "rail", "panel"],
    rows: RAIL_ROWS,
    quickVerbs: SHOW_HIDE_VERBS,
    stateWord: railStateWord,
  };
}

export const RAIL_AGENTS_REGION: LayoutRegion<"railAgents"> = {
  id: "railAgents",
  ...railRegionBase("railAgents", ["chats", "conversations", "agents"], null),
};

export const RAIL_TERMINALS_REGION: LayoutRegion<"railTerminals"> = {
  id: "railTerminals",
  ...railRegionBase("railTerminals", ["terminals", "shell", "console"], null),
};

export const RAIL_BROWSERS_REGION: LayoutRegion<"railBrowsers"> = {
  id: "railBrowsers",
  ...railRegionBase("railBrowsers", ["browsers", "web", "pages"], null),
};

export const RAIL_ARTIFACTS_REGION: LayoutRegion<"railArtifacts"> = {
  id: "railArtifacts",
  ...railRegionBase("railArtifacts", ["artifacts", "outputs", "files"], null),
};

export const RAIL_GIT_DIFF_REGION: LayoutRegion<"railGitDiff"> = {
  id: "railGitDiff",
  ...railRegionBase("railGitDiff", ["git", "diff", "changes"], null),
};

export const RAIL_PULL_REQUESTS_REGION: LayoutRegion<"railPullRequests"> = {
  id: "railPullRequests",
  ...railRegionBase(
    "railPullRequests",
    ["pull", "requests", "pr", "review"],
    "Auto: appears when this task has pull requests.",
  ),
};

export const RAIL_FILE_TREE_REGION: LayoutRegion<"railFileTree"> = {
  id: "railFileTree",
  ...railRegionBase(
    "railFileTree",
    ["file", "tree", "explorer", "folders"],
    null,
  ),
};

export const RAIL_SHARING_REGION: LayoutRegion<"railSharing"> = {
  id: "railSharing",
  ...railRegionBase(
    "railSharing",
    ["sharing", "invite", "collaborators"],
    null,
  ),
};

export const RAIL_COMMENTS_REGION: LayoutRegion<"railComments"> = {
  id: "railComments",
  ...railRegionBase(
    "railComments",
    ["comments", "notes", "feedback"],
    COMMENTS_AUTO_HINT,
  ),
};
