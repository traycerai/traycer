import {
  ClaudeAIIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  DroidIcon,
  GrokIcon,
  KimiIcon,
  OpenCodeIcon,
  TraycerIcon,
  type HarnessIcon,
} from "@/components/home/pickers/harness-icons";
import type { ProviderId } from "@/components/home/data/landing-options";

interface HarnessIconConfig {
  readonly Icon: HarnessIcon;
  readonly className: string;
}

export const PROVIDER_ICON_CONFIG: Record<ProviderId, HarnessIconConfig> = {
  codex: { Icon: CodexIcon, className: "text-foreground" },
  claude: { Icon: ClaudeAIIcon, className: "text-foreground" },
  opencode: { Icon: OpenCodeIcon, className: "text-foreground" },
  traycer: { Icon: TraycerIcon, className: "text-foreground" },
  cursor: { Icon: CursorIcon, className: "text-foreground" },
  grok: { Icon: GrokIcon, className: "text-foreground" },
  droid: { Icon: DroidIcon, className: "text-foreground" },
  kimi: { Icon: KimiIcon, className: "text-foreground" },
  copilot: { Icon: CopilotIcon, className: "text-foreground" },
};
