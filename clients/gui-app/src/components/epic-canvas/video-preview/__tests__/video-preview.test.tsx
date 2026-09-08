import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { VideoPreview } from "../video-preview";

const SRC = "https://storage.example.com/signed/clip.mp4";
const POSTER = "https://storage.example.com/signed/poster.png";
const FILE_NAME = "recording.mp4";

let pauseSpy: Mock<HTMLMediaElement["pause"]>;
let playSpy: Mock<HTMLMediaElement["play"]>;

beforeEach(() => {
  // jsdom implements neither `play` nor `pause` on HTMLMediaElement - stub
  // both so the component's `element.pause()` call in `onPlay` is drivable
  // and doesn't throw "not implemented".
  pauseSpy = vi.fn<HTMLMediaElement["pause"]>();
  playSpy = vi.fn<HTMLMediaElement["play"]>();
  HTMLMediaElement.prototype.pause = pauseSpy;
  HTMLMediaElement.prototype.play = playSpy;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderVideo(onError: () => void) {
  return render(
    <VideoPreview
      src={SRC}
      posterSrc={POSTER}
      fileName={FILE_NAME}
      onError={onError}
    />,
  );
}

describe("<VideoPreview />", () => {
  it("renders a native video element wired to the given src and accessible name", () => {
    renderVideo(() => undefined);

    const video = screen.getByTestId("video-preview");
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("src")).toBe(SRC);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("aria-label")).toBe(FILE_NAME);
  });

  it("renders the poster attribute when posterSrc is given", () => {
    renderVideo(() => undefined);

    const video = screen.getByTestId("video-preview");
    expect(video.getAttribute("poster")).toBe(POSTER);
  });

  it("renders no poster attribute when posterSrc is null", () => {
    render(
      <VideoPreview
        src={SRC}
        posterSrc={null}
        fileName={FILE_NAME}
        onError={() => undefined}
      />,
    );

    const video = screen.getByTestId("video-preview");
    expect(video.hasAttribute("poster")).toBe(false);
  });

  it("invokes onError when the element fires an error event", () => {
    const onError = vi.fn();
    renderVideo(onError);

    const video = screen.getByTestId("video-preview");
    fireEvent.error(video);

    expect(onError).toHaveBeenCalledTimes(1);
  });

  describe("one playing at a time (module-global)", () => {
    it("pauses the first instance's element when a second instance starts playing", () => {
      const firstRender = render(
        <VideoPreview
          src={SRC}
          posterSrc={null}
          fileName="first.mp4"
          onError={() => undefined}
        />,
      );
      const secondRender = render(
        <VideoPreview
          src={SRC}
          posterSrc={null}
          fileName="second.mp4"
          onError={() => undefined}
        />,
      );

      const first = within(firstRender.container).getByTestId("video-preview");
      const second = within(secondRender.container).getByTestId(
        "video-preview",
      );

      fireEvent.play(first);
      expect(pauseSpy).not.toHaveBeenCalled();

      fireEvent.play(second);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy.mock.contexts[0]).toBe(first);
    });

    it("does not pause an unmounted instance when another one starts playing", () => {
      const firstRender = render(
        <VideoPreview
          src={SRC}
          posterSrc={null}
          fileName="first.mp4"
          onError={() => undefined}
        />,
      );
      const secondRender = render(
        <VideoPreview
          src={SRC}
          posterSrc={null}
          fileName="second.mp4"
          onError={() => undefined}
        />,
      );

      const first = within(firstRender.container).getByTestId("video-preview");
      fireEvent.play(first);
      firstRender.unmount();

      const second = within(secondRender.container).getByTestId(
        "video-preview",
      );
      fireEvent.play(second);

      expect(pauseSpy).not.toHaveBeenCalled();
    });
  });
});
