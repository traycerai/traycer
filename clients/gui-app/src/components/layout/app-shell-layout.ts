export type ArtifactsSidebarSide = "left" | "right";
export type ChatPanelId = "artifacts" | "chat" | "preview";

export interface ArtifactsSidebarLayoutConfig {
  side: ArtifactsSidebarSide;
  defaultOpen: boolean;
  defaultSize: string;
  minSize: string;
  collapsedSize: string;
}

export const ARTIFACTS_SIDEBAR_LAYOUT: ArtifactsSidebarLayoutConfig = {
  side: "left",
  defaultOpen: true,
  defaultSize: "24%",
  minSize: "18%",
  collapsedSize: "0%",
};

export function getChatPanelOrder(
  side: ArtifactsSidebarSide,
): readonly ChatPanelId[] {
  return side === "left"
    ? ["artifacts", "chat", "preview"]
    : ["chat", "artifacts", "preview"];
}

export function getArtifactsPanelInitialSize(
  config: ArtifactsSidebarLayoutConfig,
): string {
  return config.defaultOpen ? config.defaultSize : config.collapsedSize;
}
