import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ClearFiltersButtonProps {
  onClick: () => void;
}

export function ClearFiltersButton(props: ClearFiltersButtonProps) {
  const { onClick } = props;
  return (
    <Button type="button" variant="muted" size="sm" onClick={onClick}>
      <X className="size-4" />
      Clear
    </Button>
  );
}
