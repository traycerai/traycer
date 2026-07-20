import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
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
  | "notifications"
  | "agents"
  | "keybindings"
  | "shell"
  | "worktrees"
  | "host"
  | "devices"
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
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "shell", label: "Shell", icon: TerminalSquare },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "host", label: "Host", icon: Server },
  { id: "devices", label: "Devices", icon: ShieldCheck },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];
