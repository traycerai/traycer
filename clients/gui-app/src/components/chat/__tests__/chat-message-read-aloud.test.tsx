import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  LOCAL_VOICE,
  NETWORK_VOICE,
  createSynth,
  installSpeech,
  type FakeSynth,
} from "@/components/chat/__tests__/fake-speech-synthesis";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MessageSegment } from "@/stores/composer/chat-store";

function render(ui: ReactNode) {
  // A fenced code block's renderer reads the query client.
  const queryClient = new QueryClient();
  const wrap = (content: ReactNode): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <ChatExpansionTestProviders tileInstanceId="read-aloud-test-tile">
          {content}
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = rtlRender(wrap(ui));
  return {
    ...view,
    rerenderWith: (next: ReactNode) => view.rerender(wrap(next)),
  };
}

function textSegment(id: string, markdown: string): MessageSegment {
  return { id, kind: "text", markdown, isStreaming: false };
}

function FinishedReply(props: {
  readonly messageId: string;
  readonly markdown: string;
}): ReactNode {
  return (
    <AssistantMessageBody
      turnId={null}
      segments={[textSegment(`${props.messageId}-seg`, props.markdown)]}
      backgroundToolBlockIds={new Set<string>()}
      runState={null}
      messageId={props.messageId}
      elapsedStartedAt={0}
      turnHasOnlyAutonomousResumeSegments={false}
      autonomousResumeOwed={false}
      showCompletionFooter
      pausedDurationMs={0}
      pausedSinceMs={null}
      completedAt={5_000}
      stopped={null}
      meta={null}
      manualRungAnchorId={null}
      nextStepActions={null}
      forkAction={null}
      interviewDeliveryRetry={null}
      routingSettledNoticeId={null}
    />
  );
}

function readAloudButtons(): HTMLElement[] {
  return screen.queryAllByTestId("assistant-reply-read-aloud");
}

function spokenText(synth: FakeSynth): string {
  return synth.spoken.map((utterance) => utterance.text).join(" ");
}

beforeEach(() => {
  installSpeech(null);
});

afterEach(() => {
  cleanup();
  installSpeech(null);
  vi.restoreAllMocks();
});

describe("reply read-aloud button", () => {
  it("is hidden when the device has no speech synthesis", () => {
    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);

    expect(screen.getByTestId("assistant-reply-copy")).not.toBeNull();
    expect(readAloudButtons()).toHaveLength(0);
  });

  it("is hidden when every voice needs a network, and nothing is spoken", () => {
    const synth = createSynth([NETWORK_VOICE]);
    installSpeech(synth);

    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);

    expect(readAloudButtons()).toHaveLength(0);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("appears once the device reports an on-device voice", () => {
    const synth = createSynth([]);
    installSpeech(synth);
    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);
    expect(readAloudButtons()).toHaveLength(0);

    synth.voices = [LOCAL_VOICE];
    act(() => synth.fireVoicesChanged());

    expect(readAloudButtons()).toHaveLength(1);
  });

  it("plays the reply, then stops it on the second press", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);

    const button = screen.getByTestId("assistant-reply-read-aloud");
    expect(button.getAttribute("aria-label")).toBe("Read reply aloud");

    fireEvent.click(button);
    expect(synth.spoken.map((utterance) => utterance.text)).toEqual([
      "Hello there.",
    ]);
    expect(button.getAttribute("aria-label")).toBe("Stop reading");
    // The label names the action; a pressed state on top would be announced
    // as "Stop reading, pressed".
    expect(button.hasAttribute("aria-pressed")).toBe(false);

    const cancelsBeforeStop = synth.cancelCount();
    fireEvent.click(button);
    expect(synth.cancelCount()).toBe(cancelsBeforeStop + 1);
    expect(button.getAttribute("aria-label")).toBe("Read reply aloud");
  });

  it("returns to Play when the reply finishes", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"First paragraph.\n\nSecond paragraph."}
      />,
    );
    const button = screen.getByTestId("assistant-reply-read-aloud");

    fireEvent.click(button);
    expect(button.getAttribute("aria-label")).toBe("Stop reading");
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe("First paragraph. Second paragraph.");
    expect(button.getAttribute("aria-label")).toBe("Read reply aloud");
  });

  it("reads one reply at a time: playing another reply resets the first", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <>
        <FinishedReply messageId="assistant:a" markdown="First reply." />
        <FinishedReply messageId="assistant:b" markdown="Second reply." />
      </>,
    );
    const [first, second] = readAloudButtons();

    fireEvent.click(first);
    fireEvent.click(second);

    expect(first.getAttribute("aria-label")).toBe("Read reply aloud");
    expect(second.getAttribute("aria-label")).toBe("Stop reading");
    expect(synth.spoken.at(-1)?.text).toBe("Second reply.");
  });

  it("stops speaking when the reply leaves the screen", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    const view = render(
      <FinishedReply messageId="assistant:a" markdown="Hello there." />,
    );
    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    const cancelsBeforeUnmount = synth.cancelCount();

    view.unmount();

    expect(synth.cancelCount()).toBe(cancelsBeforeUnmount + 1);
  });

  it.each([
    ["its epic pane is put behind another", "pane"],
    ["its canvas tab is put behind another", "tab"],
  ] as const)(
    "stops speaking when %s while the reply stays mounted",
    (_label, surface) => {
      const synth = createSynth([LOCAL_VOICE]);
      installSpeech(synth);
      const reply = (shown: boolean): ReactNode => (
        <PaneVisibilityContext.Provider value={surface !== "pane" || shown}>
          <TabBodySelectedContext.Provider value={surface !== "tab" || shown}>
            <FinishedReply messageId="assistant:a" markdown={"One.\n\nTwo."} />
          </TabBodySelectedContext.Provider>
        </PaneVisibilityContext.Provider>
      );
      const view = render(reply(true));
      const button = screen.getByTestId("assistant-reply-read-aloud");
      fireEvent.click(button);
      const cancelsBeforeHide = synth.cancelCount();

      view.rerenderWith(reply(false));

      expect(screen.getByTestId("assistant-reply-read-aloud")).toBe(button);
      expect(synth.cancelCount()).toBe(cancelsBeforeHide + 1);
      expect(button.getAttribute("aria-label")).toBe("Read reply aloud");
    },
  );

  it("cancels the rest of the reply when one paragraph fails", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"One.\n\nTwo.\n\nThree."}
      />,
    );
    const button = screen.getByTestId("assistant-reply-read-aloud");
    fireEvent.click(button);
    const cancelsBeforeError = synth.cancelCount();

    act(() => synth.failCurrent());
    act(() => synth.finishAll());

    expect(synth.cancelCount()).toBe(cancelsBeforeError + 1);
    expect(spokenText(synth)).not.toContain("Three.");
    expect(button.getAttribute("aria-label")).toBe("Read reply aloud");
  });

  it("reads the prose and skips code blocks and link targets", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={[
          "## Result",
          "",
          "Run **this** with `bun` and see [the docs](https://example.com/docs).",
          "",
          "```ts",
          "const secret = 1;",
          "```",
          "",
          "- Done.",
        ].join("\n")}
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe(
      "Result Run this with bun and see the docs. Done.",
    );
  });

  it("reads a reference link's label, never its definition", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={[
          "See [docs][ref] for more.",
          "",
          "[ref]: https://example.com/private",
        ].join("\n")}
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe("See docs for more.");
  });

  it("keeps angle brackets that are text, not markup", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown="It returns `Promise<void>` when x < 5 and y > 3."
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe(
      "It returns Promise<void> when x < 5 and y > 3.",
    );
  });

  it.each([
    [
      "inline script and style between visible prose",
      "Visible <script>secret()</script> after, <style>.x { color: red; }</style>done.",
      "Visible after, done.",
    ],
    [
      "an element inside emphasis",
      "**Bold <span>hidden</span> text** stays.",
      "Bold text stays.",
    ],
    [
      "an unclosed inline script",
      "Before <script>secret() and the rest.",
      "Before",
    ],
    [
      "a block element whose body is split by blank lines",
      "<div>\n\nHidden inside.\n\n</div>\n\nShown after.",
      "Shown after.",
    ],
    [
      "a self-closed script, which HTML still opens",
      "Visible <script/>secret() after.",
      "Visible",
    ],
    [
      "a self-closed style, which HTML still opens",
      "Visible <style/>.x { color: red; } after.",
      "Visible",
    ],
    [
      "a self-closed ordinary element, closed later",
      "Text <span/>hidden</span> shown.",
      "Text shown.",
    ],
    [
      "a script tag inside a script, which is script text",
      "Before <script>one <script>two</script> visible after.",
      "Before visible after.",
    ],
    [
      "an element opened in a blockquote and closed after it",
      "> <div>\n>\n> Hidden inside.\n\n</div>\n\nShown after.",
      "Shown after.",
    ],
    [
      "an element opened in a list item and closed after the list",
      "- <div>\n\n  Hidden item.\n\n</div>\n\nShown after.",
      "Shown after.",
    ],
    [
      "an element whose quoted attribute holds a > and a tag",
      'Before <span title="> <script>">hidden</span> after.',
      "Before after.",
    ],
    [
      "a script whose close tag is written as inline code",
      "Before <script>secret `</script>` visible after.",
      "Before visible after.",
    ],
    [
      "a CDATA section, which HTML reads as a comment ending at the first >",
      "Before <![CDATA[<script>]]> visible after.",
      "Before ]]> visible after.",
    ],
    [
      "an unclosed tag the reply shows as text",
      "Returns a Vec<String> of names.",
      "Returns a Vec of names.",
    ],
  ])("skips raw HTML with its contents: %s", (_label, markdown, said) => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(<FinishedReply messageId="assistant:a" markdown={markdown} />);

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe(said);
  });

  it("reads a long reply full of stray close tags to the end", () => {
    // Its size is the bound: work that grows with the square of the reply's
    // tags does not finish within the test timeout at this length.
    const repeats = 20_000;
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"word </span> ".repeat(repeats)}
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe("word ".repeat(repeats).trim());
  });

  it("skips a fenced code block inside a blockquote", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={["> Run this:", ">", "> ```sh", "> echo hello", "> ```"].join(
          "\n",
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(spokenText(synth)).toBe("Run this:");
  });
});

describe("reply read-aloud: no audio or text leaves the device", () => {
  it("speaks every part of the reply with an on-device voice, even when a network voice is the default", () => {
    const synth = createSynth([NETWORK_VOICE, LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"One.\n\nTwo.\n\nThree."}
      />,
    );

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(synth.spoken).toHaveLength(3);
    for (const utterance of synth.spoken) {
      expect(utterance.voice).toBe(LOCAL_VOICE);
    }
  });

  it("speaks nothing when the on-device voice is gone by the time Play is pressed", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);
    const button = screen.getByTestId("assistant-reply-read-aloud");

    // The list changes without a voiceschanged event reaching the button.
    synth.voices = [NETWORK_VOICE];
    fireEvent.click(button);

    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("cancels the reading when its on-device voice is removed during playback", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"One.\n\nTwo.\n\nThree."}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    const cancelsBeforeRemoval = synth.cancelCount();

    synth.voices = [NETWORK_VOICE];
    act(() => synth.fireVoicesChanged());
    act(() => synth.finishAll());

    expect(synth.cancelCount()).toBe(cancelsBeforeRemoval + 1);
    expect(spokenText(synth)).toBe("One.");
  });

  it("queues no further paragraph once the voice is gone, even with no voiceschanged event", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    render(
      <FinishedReply
        messageId="assistant:a"
        markdown={"One.\n\nTwo.\n\nThree."}
      />,
    );
    const button = screen.getByTestId("assistant-reply-read-aloud");
    fireEvent.click(button);

    synth.voices = [NETWORK_VOICE];
    act(() => synth.finishCurrent());

    expect(spokenText(synth)).toBe("One.");
    expect(button.getAttribute("aria-label")).toBe("Read reply aloud");
  });

  it("opens no network request, socket or audio element while reading", () => {
    const synth = createSynth([LOCAL_VOICE]);
    installSpeech(synth);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const beaconSpy = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: beaconSpy,
    });
    const socketSpy = vi.fn();
    vi.stubGlobal("WebSocket", socketSpy);
    const audioSpy = vi.fn();
    vi.stubGlobal("Audio", audioSpy);
    render(<FinishedReply messageId="assistant:a" markdown="Hello there." />);

    fireEvent.click(screen.getByTestId("assistant-reply-read-aloud"));
    act(() => synth.finishAll());

    expect(synth.speak).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
    expect(audioSpy).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "sendBeacon");
    vi.unstubAllGlobals();
  });
});
