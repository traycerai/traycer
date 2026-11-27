/**
 * The GUI tells the phone shell each time the cloud feed accepts a snapshot.
 * The shell is the fake runner host; the store and the hook are the real ones.
 */
import { cleanup, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  IDeliveredNotificationsHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostNotificationsCloudFeedSummary } from "@traycer/protocol/host/notifications/contracts";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { useDeliveredNotificationsFeedTrigger } from "@/hooks/notifications/use-delivered-notifications-feed-trigger";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

const ACCOUNT = "account-1";
const EMPTY_SUMMARY: HostNotificationsCloudFeedSummary = {
  totalCount: 0,
  unreadCount: 0,
  attentionCount: 0,
};

beforeEach(() => {
  useCloudNotificationsStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useCloudNotificationsStore.getState().reset();
});

function feedHost(): { readonly host: IRunnerHost; readonly frames: string[] } {
  const frames: string[] = [];
  const deliveredNotifications: IDeliveredNotificationsHost = {
    noteCloudFeedFrame(userId: string): void {
      frames.push(userId);
    },
  };
  return {
    host: createFakeRunnerHost({ deliveredNotifications }),
    frames,
  };
}

function wrapperFor(host: IRunnerHost) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <RunnerHostProvider runnerHost={host}>
        {props.children}
      </RunnerHostProvider>
    );
  };
}

function acceptSnapshot(version: number): void {
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [],
    summary: EMPTY_SUMMARY,
    version,
  });
}

describe("useDeliveredNotificationsFeedTrigger", () => {
  it("tells the shell the feed's account on each accepted snapshot, including a same-version resend", () => {
    useCloudNotificationsStore.setState({ accountId: ACCOUNT });
    const { host, frames } = feedHost();
    renderHook(() => useDeliveredNotificationsFeedTrigger(), {
      wrapper: wrapperFor(host),
    });

    act(() => acceptSnapshot(2));
    act(() => acceptSnapshot(2));
    expect(frames).toEqual([ACCOUNT, ACCOUNT]);

    act(() => acceptSnapshot(1));
    expect(frames).toEqual([ACCOUNT, ACCOUNT]);
    expect(useCloudNotificationsStore.getState().version).toBe(2);
  });

  it("does not tell the shell when the rows are unchanged", () => {
    useCloudNotificationsStore.setState({ accountId: ACCOUNT });
    const { host, frames } = feedHost();
    renderHook(() => useDeliveredNotificationsFeedTrigger(), {
      wrapper: wrapperFor(host),
    });

    act(() => acceptSnapshot(1));
    expect(frames).toEqual([ACCOUNT]);
    act(() => {
      useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    });
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "reconnecting",
    );
    expect(frames).toEqual([ACCOUNT]);
  });

  it("does not tell the shell when the feed has no account", () => {
    const { host, frames } = feedHost();
    renderHook(() => useDeliveredNotificationsFeedTrigger(), {
      wrapper: wrapperFor(host),
    });

    act(() => acceptSnapshot(1));
    expect(useCloudNotificationsStore.getState().hasSnapshot).toBe(true);
    expect(frames).toEqual([]);
  });
});
