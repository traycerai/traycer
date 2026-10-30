import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Shown wherever an instance is listed while an agent's session drives it. */
export function SimulatorAgentBadge() {
  return (
    <Badge variant="info" size="xs" className="shrink-0">
      <Bot aria-hidden />
      Agent
    </Badge>
  );
}
