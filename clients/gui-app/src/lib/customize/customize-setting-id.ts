/**
 * The ids of the layout settings the Customize editor can target.
 *
 * A leaf module of its own so the settings search index can name one in an
 * entry without importing the catalog, which reads the Layout definitions - and
 * those import the search index's definition helpers.
 */
export type CustomizeSettingId =
  | "statusBar.placement"
  | "statusBar.usage"
  | "statusBar.provider"
  | "statusBar.resources"
  | "header.usage"
  | "tabs.home"
  | "composer.attachImage"
  | "composer.access"
  | "composer.harness"
  | "composer.model"
  | "composer.mic"
  | "composer.filesChanged"
  | "composer.activeAgents"
  | "composer.background"
  | "chat.context"
  | "chat.minimapSide"
  | "sidebar.panel"
  | "sidebar.resourceChips";
