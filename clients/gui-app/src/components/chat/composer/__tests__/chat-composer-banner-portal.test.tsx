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
      <ChatComposerBannerPortalProvider hidden={false}>
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

  it("hides the banner host while keeping the banner mounted", () => {
    const view = render(
      <ChatComposerBannerPortalProvider hidden>
        <ChatComposerBannerPortal>
          <input data-testid="banner-field" defaultValue="" />
        </ChatComposerBannerPortal>
      </ChatComposerBannerPortalProvider>,
    );

    const host = screen.getByTestId("chat-composer-banner-host");
    const field = screen.getByTestId("banner-field");
    expect(host.hidden).toBe(true);
    expect(host.contains(field)).toBe(true);

    view.rerender(
      <ChatComposerBannerPortalProvider hidden={false}>
        <ChatComposerBannerPortal>
          <input data-testid="banner-field" defaultValue="" />
        </ChatComposerBannerPortal>
      </ChatComposerBannerPortalProvider>,
    );

    expect(screen.getByTestId("chat-composer-banner-host").hidden).toBe(false);
    expect(screen.getByTestId("banner-field")).toBe(field);
  });
});
