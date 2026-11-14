import { Tag } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * One chip per other name the account had (`otherNames`), drawn beside the
 * account's name until a person picks one in Settings.
 */
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
