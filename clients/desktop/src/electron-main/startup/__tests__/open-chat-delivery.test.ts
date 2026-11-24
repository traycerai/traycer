import { describe, expect, it, vi, type Mock } from "vitest";
import type { OpenChatDeepLinkTarget } from "../../auth/deep-link";
import {
  OpenChatDelivery,
  type OpenChatDeliveryPorts,
  type OpenChatWindow,
} from "../open-chat-delivery";

const A: OpenChatDeepLinkTarget = { epicId: "epic-a", chatId: "chat-a" };
const B: OpenChatDeepLinkTarget = { epicId: "epic-b", chatId: "chat-b" };

class FakeWindow implements OpenChatWindow {
  loaded: boolean;
  private listeners: (() => void)[] = [];

  constructor(
    readonly windowId: string,
    loaded: boolean,
  ) {
    this.loaded = loaded;
  }

  onceLoaded(listener: () => void): void {
    this.listeners.push(listener);
  }

  finishLoad(): void {
    this.loaded = true;
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener();
  }
}

function ports(window: {
  current: FakeWindow | null;
}): OpenChatDeliveryPorts & {
  delivered: OpenChatDeepLinkTarget[];
  openWindow: Mock<() => void>;
} {
  const delivered: OpenChatDeepLinkTarget[] = [];
  return {
    delivered,
    targetWindow: () => window.current,
    openWindow: vi.fn<() => void>(),
    deliver: (target) => delivered.push(target),
  };
}

describe("OpenChatDelivery", () => {
  it("delivers at once to a loaded window", () => {
    const delivery = new OpenChatDelivery();
    const p = ports({ current: new FakeWindow("w1", true) });
    delivery.attach(p);
    delivery.offer(A);
    expect(p.delivered).toEqual([A]);
  });

  it("cold start: links before attach and while the renderer loads collapse to the newest, delivered once on load", () => {
    const delivery = new OpenChatDelivery();
    delivery.offer(A);
    const window = new FakeWindow("w1", false);
    const p = ports({ current: window });
    delivery.attach(p);
    delivery.offer(B);
    expect(p.delivered).toEqual([]);
    window.finishLoad();
    expect(p.delivered).toEqual([B]);
  });

  it("with no live window opens one once, then delivers when it has loaded", () => {
    const delivery = new OpenChatDelivery();
    const slot: { current: FakeWindow | null } = { current: null };
    const p = ports(slot);
    delivery.attach(p);
    delivery.offer(A);
    delivery.offer(B);
    expect(p.openWindow).toHaveBeenCalledTimes(1);
    expect(p.delivered).toEqual([]);

    const window = new FakeWindow("w2", false);
    slot.current = window;
    delivery.flush();
    expect(p.delivered).toEqual([]);
    window.finishLoad();
    expect(p.delivered).toEqual([B]);
  });

  it("delivers each link once", () => {
    const delivery = new OpenChatDelivery();
    const p = ports({ current: new FakeWindow("w1", true) });
    delivery.attach(p);
    delivery.offer(A);
    delivery.flush();
    delivery.offer(B);
    expect(p.delivered).toEqual([A, B]);
  });
});
