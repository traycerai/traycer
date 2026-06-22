import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  GitBranch,
  Keyboard,
  Palette,
  Server,
  Settings as SettingsIcon,
  TerminalSquare,
} from "lucide-react";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "providers"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "shell", label: "Shell", icon: TerminalSquare },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "host", label: "Host", icon: Server },
];
