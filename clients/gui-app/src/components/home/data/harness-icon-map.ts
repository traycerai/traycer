import {
  AmpIcon,
  ClaudeAIIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  DroidIcon,
  GrokIcon,
  KiroIcon,
  KiloCodeIcon,
  KimiIcon,
  OpenCodeIcon,
  OpenRouterIcon,
  QwenIcon,
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
  openrouter: { Icon: OpenRouterIcon, className: "text-foreground" },
  cursor: { Icon: CursorIcon, className: "text-foreground" },
  grok: { Icon: GrokIcon, className: "text-foreground" },
  qwen: { Icon: QwenIcon, className: "text-foreground" },
  kiro: { Icon: KiroIcon, className: "text-foreground" },
  droid: { Icon: DroidIcon, className: "text-foreground" },
  kimi: { Icon: KimiIcon, className: "text-foreground" },
  copilot: { Icon: CopilotIcon, className: "text-foreground" },
  kilocode: { Icon: KiloCodeIcon, className: "text-foreground" },
  amp: { Icon: AmpIcon, className: "text-foreground" },
};
