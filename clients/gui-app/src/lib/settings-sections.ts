import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  Boxes,
  GitBranch,
  Keyboard,
  Palette,
  Server,
  ShieldCheck,
  Settings as SettingsIcon,
  TerminalSquare,
} from "lucide-react";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "providers"
  | "permissions"
  | "agents"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host"
  | "diagnostics";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "shell", label: "Shell", icon: TerminalSquare },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "host", label: "Host", icon: Server },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];
