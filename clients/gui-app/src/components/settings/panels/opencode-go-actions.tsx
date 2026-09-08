import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useOpenLink } from "@/lib/links/open-link";

const OPENCODE_GO_MANAGE_URL = "https://opencode.ai/auth";

export function OpenModelProvidersButton({
  onClick,
}: {
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto p-0"
      onClick={onClick}
    >
      Open Model Providers
    </Button>
  );
}

export function OpenCodeGoManageLink(): ReactNode {
  const openLink = useOpenLink();
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto w-fit p-0"
      onClick={(event) => {
        void openLink(OPENCODE_GO_MANAGE_URL, "account", event);
      }}
    >
      Manage Go
    </Button>
  );
}
