import type { ProjectProfileColor } from "@/stores/workspace/project-profiles-store";

export const PROJECT_PROFILE_COLOR_DOT: Readonly<
  Record<ProjectProfileColor, string>
> = {
  orange: "bg-orange-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
};
