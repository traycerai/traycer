import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";

interface TestDirectory {
  refresh(): Promise<readonly HostDirectoryEntry[]>;
}

interface DirectoryProps {
  readonly directory: TestDirectory | null;
}

function makeDirectory() {
  const refresh = vi.fn((): Promise<readonly HostDirectoryEntry[]> =>
    Promise.resolve([]),
  );
  return { directory: { refresh }, refresh };
}

afterEach(() => {
  cleanup();
});

describe("useRefreshHostDirectoryOnOpen", () => {
  it("refreshes when the open flag becomes true", () => {
    const { directory, refresh } = makeDirectory();
    const rendered = renderHook(
      (props: { readonly open: boolean }) =>
        useRefreshHostDirectoryOnOpen(props.open, directory),
      { initialProps: { open: false } },
    );

    expect(refresh).not.toHaveBeenCalled();

    rendered.rerender({ open: true });
    expect(refresh).toHaveBeenCalledTimes(1);

    rendered.rerender({ open: true });
    expect(refresh).toHaveBeenCalledTimes(1);

    rendered.rerender({ open: false });
    rendered.rerender({ open: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores open transitions until a directory is available", () => {
    const { directory, refresh } = makeDirectory();
    const initialProps: DirectoryProps = { directory: null };
    const rendered = renderHook(
      (props: DirectoryProps) =>
        useRefreshHostDirectoryOnOpen(true, props.directory),
      { initialProps },
    );

    expect(refresh).not.toHaveBeenCalled();

    rendered.rerender({ directory });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
