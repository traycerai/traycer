import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeaderTab } from "@/stores/tabs/types";
import { useTabRepositorySettings } from "@/components/layout/tabs/tab-repository-settings";

const dialogMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/layout/tabs/tab-repository-settings-dialog", () => ({
  TabRepositorySettingsDialog: (props: {
    readonly hostId: string | null;
    readonly identityPath: string | null;
  }) => {
    dialogMock(props);
    return <div data-testid="repository-settings-dialog" />;
  },
}));

function epicTab(): HeaderTab {
  return {
    kind: "epic",
    id: "tab-1",
    epicId: "epic-1",
    hostId: "host-from-epic",
    route: "/epic/epic-1",
    name: "Epic",
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
    repositoryIdentity: {
      color: "#e5484d",
      icon: null,
      scope: {
        accountId: "acct-1",
        hostId: "host-from-identity",
        canonicalSourceRoot: "/repo/canonical",
      },
      assetRefreshKey: 1,
      iconRejected: false,
    },
  };
}

afterEach(() => {
  cleanup();
  dialogMock.mockClear();
});

describe("useTabRepositorySettings", () => {
  it("opens repository settings on the identity scope host and canonical root", () => {
    const { result } = renderHook(() => useTabRepositorySettings(epicTab()));

    act(() => result.current.onOpen?.());
    render(result.current.dialog);

    expect(screen.getByTestId("repository-settings-dialog")).toBeTruthy();
    expect(dialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-from-identity",
        identityPath: "/repo/canonical",
      }),
    );
  });
});
