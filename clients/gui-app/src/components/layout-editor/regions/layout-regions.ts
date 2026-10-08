import {
  CONTEXT_USAGE_REGION,
  MINIMAP_REGION,
  THINKING_REGION,
  TIMESTAMPS_REGION,
  TOOL_ACTIVITY_REGION,
} from "@/components/layout-editor/regions/chat-regions";
import {
  ACCESS_REGION,
  ATTACH_IMAGE_REGION,
  BACKGROUND_REGION,
  CHANGED_FILES_REGION,
  MIC_REGION,
  MODEL_REGION,
  RUNNING_AGENTS_REGION,
  TODO_REGION,
} from "@/components/layout-editor/regions/composer-regions";
import {
  RAIL_AGENTS_REGION,
  RAIL_ARTIFACTS_REGION,
  RAIL_FILES_REGION,
  RAIL_BROWSERS_REGION,
  RAIL_COMMENTS_REGION,
  RAIL_FILE_TREE_REGION,
  RAIL_GIT_DIFF_REGION,
  RAIL_PULL_REQUESTS_REGION,
  RAIL_SHARING_REGION,
  RAIL_TERMINALS_REGION,
} from "@/components/layout-editor/regions/rail-regions";
import type { LayoutRegion } from "@/components/layout-editor/regions/region-grammar";
import {
  RESOURCE_MONITOR_REGION,
  USAGE_LIMITS_REGION,
} from "@/components/layout-editor/regions/status-bar-regions";
import { HOME_TAB_REGION } from "@/components/layout-editor/regions/top-bar-regions";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Every region the editor can address, said once (resolves O-2).
 *
 * This is the one declarative registry (L-03), and it feeds five callers: the
 * docked inspector's section renderer, the full-width `Settings > Layout` host,
 * the index grouped by surface, the filter, and the quick verbs and search
 * launch entries.
 *
 * An index rather than a table: each surface states its own regions in its own
 * file, and this map is where the twenty-six are joined so a caller holding
 * an id can look one up. A region missing from here is a compile error, which is
 * what keeps the five per-surface files from drifting into a partial registry.
 *
 * The copy in those files is final (L-33, L-52) and matches the prototype
 * (L-45).
 */
export const LAYOUT_REGIONS: {
  readonly [K in RegionId]: LayoutRegion<K>;
} = {
  homeTab: HOME_TAB_REGION,
  usageLimits: USAGE_LIMITS_REGION,
  resourceMonitor: RESOURCE_MONITOR_REGION,
  // The transcript's own three in the order a turn draws them, then the
  // two readings at its edges; the Chat area lists them in this order.
  toolActivity: TOOL_ACTIVITY_REGION,
  thinking: THINKING_REGION,
  timestamps: TIMESTAMPS_REGION,
  minimap: MINIMAP_REGION,
  contextUsage: CONTEXT_USAGE_REGION,
  runningAgents: RUNNING_AGENTS_REGION,
  changedFiles: CHANGED_FILES_REGION,
  background: BACKGROUND_REGION,
  todo: TODO_REGION,
  attachImage: ATTACH_IMAGE_REGION,
  access: ACCESS_REGION,
  model: MODEL_REGION,
  mic: MIC_REGION,
  railAgents: RAIL_AGENTS_REGION,
  railTerminals: RAIL_TERMINALS_REGION,
  railBrowsers: RAIL_BROWSERS_REGION,
  railArtifacts: RAIL_ARTIFACTS_REGION,
  railFiles: RAIL_FILES_REGION,
  railGitDiff: RAIL_GIT_DIFF_REGION,
  railPullRequests: RAIL_PULL_REQUESTS_REGION,
  railFileTree: RAIL_FILE_TREE_REGION,
  railSharing: RAIL_SHARING_REGION,
  railComments: RAIL_COMMENTS_REGION,
};
