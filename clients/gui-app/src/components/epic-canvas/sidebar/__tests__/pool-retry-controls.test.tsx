import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitBindingsUnreadable } from "@/components/epic-canvas/git-diff/empty-states/git-bindings-unreadable";
import { GitHostUnreachable } from "@/components/epic-canvas/git-diff/empty-states/git-host-unreachable";
import { GitRootsUnavailable } from "@/components/epic-canvas/git-diff/empty-states/git-roots-unavailable";
import { FileTreeWorkspacesUnavailable } from "@/components/epic-canvas/sidebar/file-tree-workspaces-unavailable";
import { TerminalsErrorState } from "@/components/epic-canvas/sidebar/terminal-list-states";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";

const hostContext = vi.hoisted(() => ({ hostId: "owner-computer" }));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => hostContext.hostId,
}));

interface RetryControlCase {
  readonly name: string;
  readonly render: (onRetry: () => Promise<void>) => ReactNode;
}

const retryControls: readonly RetryControlCase[] = [
  {
    name: "Git bindings",
    render: (onRetry) => (
      <GitBindingsUnreadable message="Fixture failure" onRetry={onRetry} />
    ),
  },
  {
    name: "Git host",
    render: (onRetry) => (
      <GitHostUnreachable
        hostName="Fixture computer"
        onRetry={onRetry}
        onUseDefaultHost={() => undefined}
      />
    ),
  },
  {
    name: "Git roots",
    render: (onRetry) => (
      <GitRootsUnavailable
        onRetry={() => {
          void onRetry();
        }}
      />
    ),
  },
  {
    name: "file tree",
    render: (onRetry) => (
      <FileTreeWorkspacesUnavailable
        failure={{ kind: "answered", message: "Fixture failure" }}
        hostName="Fixture computer"
        onRetry={onRetry}
      />
    ),
  },
  {
    name: "terminal list",
    render: (onRetry) => (
      <TerminalsErrorState
        message="Fixture failure"
        isRetrying={false}
        onRetry={() => {
          void onRetry();
        }}
        testIdPrefix="fixture-terminals"
      />
    ),
  },
];

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("computer-only Retry controls on a cold pool", () => {
  it.each(retryControls)(
    "$name disables and ignores Retry on the pool, then works when its computer serves",
    async ({ render: renderControl }) => {
      const onRetry = vi.fn<() => Promise<void>>(() => Promise.resolve());
      const authority = mountTestSelectionAuthority({
        hosts: [
          { hostId: hostContext.hostId, kind: "remote", teamOwned: false },
        ],
      });
      const view = render(renderControl(onRetry));

      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.hasAttribute("disabled")).toBe(true);
      fireEvent.click(retry);
      fireEvent.keyDown(retry, { key: "Enter", code: "Enter" });
      fireEvent.keyUp(retry, { key: "Enter", code: "Enter" });
      expect(onRetry).not.toHaveBeenCalled();

      act(() => {
        authority.connectComputer(hostContext.hostId);
        authority.finishReturnDamping();
      });
      view.rerender(renderControl(onRetry));
      const availableRetry = screen.getByRole("button", { name: "Retry" });
      expect(availableRetry.hasAttribute("disabled")).toBe(false);
      fireEvent.click(availableRetry);
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    },
  );
});
