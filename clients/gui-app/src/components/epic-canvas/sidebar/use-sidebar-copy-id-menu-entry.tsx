import { Copy } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import type { SidebarRowMenuEntry } from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

function notifyIdCopied(): void {
  toast.success("ID copied to clipboard");
}

function notifyIdCopyFailed(): void {
  reportableErrorToast("Couldn't copy ID to clipboard.", undefined, {
    title: "Could not copy ID",
    message: null,
    code: null,
    source: "Clipboard",
  });
}

export function useSidebarCopyIdMenuEntry(id: string): SidebarRowMenuEntry {
  const { copy } = useClipboardCopy({
    resetMs: 1600,
    onSuccess: notifyIdCopied,
    onError: notifyIdCopyFailed,
  });
  return useMemo(
    () => ({
      kind: "item",
      id: "copy-id",
      label: "Copy ID",
      icon: <Copy className="size-3.5" />,
      disabled: false,
      disabledTooltip: null,
      variant: "default",
      testIds: {
        dropdown: `epic-sidebar-copy-id-${id}`,
        context: `epic-sidebar-context-copy-id-${id}`,
      },
      onSelect: () => copy(id),
    }),
    [copy, id],
  );
}
