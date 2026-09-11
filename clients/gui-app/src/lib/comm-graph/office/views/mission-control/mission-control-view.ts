/**
 * The Mission control view value. Registered in OFFICE_VIEWS after Floor.
 */
import {
  measureMissionControl,
  planMissionControl,
} from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import { MISSION_CONTROL_PAINTER } from "@/lib/comm-graph/office/views/mission-control/mission-control-painter";
import type { OfficeView } from "@/lib/comm-graph/office/views/office-view";

export const MISSION_CONTROL_VIEW: OfficeView = {
  id: "mission-control",
  label: "Mission control",
  description:
    "Consoles in tiers facing the orchestrator at the podium; a team is a contiguous section with its lead on the aisle.",
  plan: planMissionControl,
  measure: measureMissionControl,
  painter: MISSION_CONTROL_PAINTER,
};
