import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChatSandboxDestroyedLine } from "@/components/chat/chat-sandbox-destroyed-line";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordEndedSandboxHost,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

// Local time, so the line reads the same in any zone.
const DESTROYED_AT = new Date(2026, 9, 25, 11, 1).getTime();

describe("<ChatSandboxDestroyedLine />", () => {
  beforeEach(() => {
    useEndedSandboxHostsStore.setState({ byHostId: {} });
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u-me", username: "me" },
      });
    });
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    });
  });

  it("says the viewer destroyed it, and when", () => {
    recordEndedSandboxHost("host-win2", {
      name: "e2e-sbx-win2",
      at: DESTROYED_AT,
      actor: { userId: "u-me", displayName: null },
    });

    render(<ChatSandboxDestroyedLine hostId="host-win2" />);

    expect(screen.getByTestId("chat-sandbox-destroyed").textContent).toBe(
      "e2e-sbx-win2 was destroyed by you at 11:01.",
    );
  });

  it("names the member who destroyed it", () => {
    recordEndedSandboxHost("host-win2", {
      name: "e2e-sbx-win2",
      at: DESTROYED_AT,
      actor: { userId: "u-priya", displayName: "Priya" },
    });

    render(<ChatSandboxDestroyedLine hostId="host-win2" />);

    expect(screen.getByTestId("chat-sandbox-destroyed").textContent).toBe(
      "e2e-sbx-win2 was destroyed by Priya at 11:01.",
    );
  });

  it("renders nothing for a host with no record, or no host", () => {
    recordEndedSandboxHost("host-win2", {
      name: "e2e-sbx-win2",
      at: DESTROYED_AT,
      actor: { userId: "u-me", displayName: null },
    });

    const other = render(<ChatSandboxDestroyedLine hostId="host-other" />);
    expect(other.container.innerHTML).toBe("");
    other.unmount();
    const none = render(<ChatSandboxDestroyedLine hostId={null} />);
    expect(none.container.innerHTML).toBe("");
  });
});
