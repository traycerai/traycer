import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatComposerBannerPortal,
  ChatComposerBannerPortalProvider,
} from "@/components/chat/composer/chat-composer-banner-portal";

describe("<ChatComposerBannerPortalProvider />", () => {
  afterEach(cleanup);

  it("renders the banner before every composer-connected surface", () => {
    render(
      <ChatComposerBannerPortalProvider>
        <div data-testid="todo-surface" />
        <div data-testid="background-surface" />
        <div data-testid="composer-surface" />
        <ChatComposerBannerPortal>
          <div data-testid="rate-limit-banner" />
        </ChatComposerBannerPortal>
      </ChatComposerBannerPortalProvider>,
    );

    const host = screen.getByTestId("chat-composer-banner-host");
    const banner = screen.getByTestId("rate-limit-banner");
    const todo = screen.getByTestId("todo-surface");
    const background = screen.getByTestId("background-surface");
    const composer = screen.getByTestId("composer-surface");

    expect(host.contains(banner)).toBe(true);
    expect(
      banner.compareDocumentPosition(todo) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      todo.compareDocumentPosition(background) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      background.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
