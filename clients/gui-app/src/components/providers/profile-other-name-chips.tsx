import { Tag } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export function ProfileOtherNameChips(props: {
  readonly otherNames: readonly string[];
}): ReactNode {
  return props.otherNames.map((name) => (
    <Badge key={name} variant="muted" size="xs" className="max-w-1/2">
      <Tag aria-hidden data-icon="inline-start" />
      <span className="truncate">{name}</span>
    </Badge>
  ));
}
