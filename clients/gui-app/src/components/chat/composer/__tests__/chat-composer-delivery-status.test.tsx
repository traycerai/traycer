import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_STREAM_RECONNECTING_COPY,
  ChatComposerDeliveryStatus,
} from "@/components/chat/composer/chat-composer-delivery-status";
import {
  NO_QUEUED_MESSAGE_STAGES,
  QueuedMessageStagesContext,
  type QueuedMessageStages,
} from "@/components/chat/queued-message-stages";

function renderStatus(overrides: Partial<QueuedMessageStages>) {
  return render(
    <QueuedMessageStagesContext
      value={{ ...NO_QUEUED_MESSAGE_STAGES, ...overrides }}
    >
      <ChatComposerDeliveryStatus />
    </QueuedMessageStagesContext>,
  );
}

afterEach(() => {
  cleanup();
});

describe("<ChatComposerDeliveryStatus />", () => {
  it("shows the reconnecting line, and not the delivery line, even with unconfirmed sends", () => {
    renderStatus({
      streamReconnecting: true,
      unconfirmedSendActionIds: new Set(["action-1"]),
      onCheckDelivery: vi.fn(),
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(CHAT_STREAM_RECONNECTING_COPY);
    expect(screen.queryByText(/Delivery not confirmed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Check delivery" })).toBeNull();
  });

  it("shows Delivery not confirmed with a Check delivery button that calls the handler once", () => {
    const onCheckDelivery = vi.fn();
    renderStatus({
      unconfirmedSendActionIds: new Set(["action-1"]),
      onCheckDelivery,
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Delivery not confirmed",
    );
    expect(screen.queryByText(CHAT_STREAM_RECONNECTING_COPY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));
    expect(onCheckDelivery).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the stream is open and no send is unconfirmed", () => {
    const { container } = renderStatus({});
    expect(container.firstChild).toBeNull();
  });
});
