import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Room content is available only through a host running the picked team. */
export function TeamContentNeedsHost(props: {
  readonly content: "guide" | "skills";
  readonly teamName: string;
  readonly onPickHost: () => void;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground"
    >
      <span>
        {props.content === "guide" ? "The guide needs" : "Skills need"} a host
        running {props.teamName}.
      </span>{" "}
      <Button type="button" variant="link" size="sm" onClick={props.onPickHost}>
        Pick one.
      </Button>
    </div>
  );
}
