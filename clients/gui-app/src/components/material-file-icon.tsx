import { getIcon } from "material-file-icons";
import type { ReactElement } from "react";
import { basenameOfPath } from "@/lib/path";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { cn } from "@/lib/utils";

interface MaterialFileIconProps {
  readonly filename: string;
  readonly className: string | undefined;
}

export function MaterialFileIcon(props: MaterialFileIconProps): ReactElement {
  const name = basenameOfPath(props.filename) || props.filename;
  const icon = trustedMarkupToReactNodes(getIcon(name).svg, "svg");
  return (
    <span
      className={cn("inline-flex items-center justify-center", props.className)}
      aria-hidden
    >
      {icon}
    </span>
  );
}
