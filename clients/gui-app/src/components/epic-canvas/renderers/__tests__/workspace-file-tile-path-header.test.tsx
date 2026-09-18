import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

vi.mock("@/components/diff/diff-edit-provider-loader", () => ({
  preloadDiffEditProvider: () => Promise.resolve(),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Host A" }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => null,
  useHostSupportsMethod: () => false,
}));

vi.mock("@/hooks/workspace/use-read-file-query", () => ({
  useWorkspaceReadFile: () => ({
    data: { content: "const value = 1;\n", error: null, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/workspace/use-workspace-write-file-mutation", () => ({
  useWorkspaceWriteFile: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock(
  "@/components/epic-canvas/workspace-file/workspace-file-renderer",
  () => ({
    WorkspaceFileRenderer: (): ReactNode => (
      <div data-testid="workspace-file-source" />
    ),
  }),
);

import { WorkspaceFileTile } from "../workspace-file-tile";
import { TabHostProvider } from "../../tab-host-provider";

const POSIX_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:/work/repo:src/index.ts",
  instanceId: "workspace-file-instance",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/work/repo",
  filePath: "src/index.ts",
};
const POSIX_ABSOLUTE_PATH = "/work/repo/src/index.ts";

const WINDOWS_NODE: WorkspaceFileRef = {
  id: "workspace-file:host-A:C:\\Users\\dev\\repo:src\\index.ts",
  instanceId: "workspace-file-instance-windows",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "C:\\Users\\dev\\repo",
  filePath: "src\\index.ts",
};
const WINDOWS_ABSOLUTE_PATH = "C:/Users/dev/repo/src/index.ts";

const OPEN_DELAY_MS = 500;
const COPY_BUTTON_TEST_ID = "workspace-file-copy-path";

function copyButtonQuery() {
  return screen.queryByTestId(COPY_BUTTON_TEST_ID);
}

function installClipboardMock(): Mock<(value: string) => Promise<void>> {
  const mock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock },
  });
  return mock;
}

describe("<WorkspaceFileTile /> path header", () => {
  let writeText: Mock<(value: string) => Promise<void>>;

  beforeEach(() => {
    fileEditRuntimeRegistry.resetForTesting();
    writeText = installClipboardMock();
  });

  afterEach(() => {
    cleanup();
    fileEditRuntimeRegistry.resetForTesting();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.useRealTimers();
  });

  it("hides the copy control at rest, reveals exactly one on hover with the absolute path, and copies from it - without a second one mounting when the trigger is then clicked", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTile(POSIX_NODE);
    const trigger = screen.getByRole("button", {
      name: "Show full file path",
    });
    expect(copyButtonQuery()).toBeNull();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(OPEN_DELAY_MS * 2);
    });

    expect(screen.getByText(POSIX_ABSOLUTE_PATH)).toBeTruthy();
    expect(screen.getAllByTestId(COPY_BUTTON_TEST_ID)).toHaveLength(1);
    const copyButton = copyButtonQuery();
    if (copyButton === null) throw new Error("expected the copy control");
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(POSIX_ABSOLUTE_PATH);

    // Clicking the trigger switches to the click-open popover; the hover
    // card must be forced shut rather than the two coexisting.
    fireEvent.click(trigger);
    expect(screen.getAllByTestId(COPY_BUTTON_TEST_ID)).toHaveLength(1);
  });

  it("opens the accessible popover from the keyboard, lands focus on the copy control via Radix's auto-focus, and copies on Enter", async () => {
    const user = userEvent.setup();
    // `userEvent.setup()` installs its own clipboard shim, clobbering the
    // spy `beforeEach` set up - reinstall ours after `setup()`.
    writeText = installClipboardMock();
    renderTile(POSIX_NODE);
    expect(copyButtonQuery()).toBeNull();

    // Nothing focused yet - the caption is the first (and only, at rest)
    // tab stop in the tile.
    await user.tab();
    const trigger = screen.getByRole("button", {
      name: "Show full file path",
    });
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Enter}");

    expect(screen.getByText(POSIX_ABSOLUTE_PATH)).toBeTruthy();
    expect(screen.getAllByTestId(COPY_BUTTON_TEST_ID)).toHaveLength(1);
    // Radix's Popover moves focus into its content on open (its default
    // `onOpenAutoFocus`) - onto the copy control, since it's the only
    // focusable element in there. A further Tab would move PAST it, not
    // onto it, so this is the actual reachable state after opening from the
    // keyboard, not a Tab away from it.
    const copyButton = screen.getByTestId(COPY_BUTTON_TEST_ID);
    expect(document.activeElement).toBe(copyButton);

    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith(POSIX_ABSOLUTE_PATH);
    // CodeRabbit finding: a static aria-label never announces the copy to a
    // screen reader - it must swap to "Copied" on success.
    await waitFor(() => {
      expect(copyButton.getAttribute("aria-label")).toBe("Copied");
    });
  });

  it("resolves the drive-letter absolute path for a Windows workspace, in both the disclosure and the copy", () => {
    renderTile(WINDOWS_NODE);
    const trigger = screen.getByRole("button", {
      name: "Show full file path",
    });

    fireEvent.click(trigger);

    expect(screen.getByText(WINDOWS_ABSOLUTE_PATH)).toBeTruthy();
    const copyButton = copyButtonQuery();
    if (copyButton === null) throw new Error("expected the copy control");
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(WINDOWS_ABSOLUTE_PATH);
  });
});

function renderTile(node: WorkspaceFileRef) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TabHostProvider hostId="host-A">
        <WorkspaceFileTile node={node} viewTabId="view-1" isActive />
      </TabHostProvider>
    </QueryClientProvider>,
  );
}
