import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FrameCommentsToolbar(props: {
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={props.active ? "secondary" : "ghost"}
      aria-label="Comments"
      aria-pressed={props.active}
      onClick={props.onToggle}
    >
      <MessageSquare />
      Comments
    </Button>
  );
}
