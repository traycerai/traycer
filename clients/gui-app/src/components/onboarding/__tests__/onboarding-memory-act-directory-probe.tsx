import { useEffect, type ReactNode } from "react";
import { useHostBinding } from "@/lib/host";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";

/** Hands the window's host directory to a test so it can re-read the host list. */
export function DirectoryProbe(props: {
  readonly onDirectory: (directory: HostDirectoryService | null) => void;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const { onDirectory } = props;
  useEffect(() => {
    onDirectory(binding === null ? null : binding.directory);
    return () => onDirectory(null);
  }, [binding, onDirectory]);
  return props.children;
}
