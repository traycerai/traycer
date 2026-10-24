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
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MessageSegment } from "@/stores/composer/chat-store";

interface FakeVoice {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
  readonly voiceURI: string;
}

class FakeUtterance {
  readonly text: string;
  voice: FakeVoice | null = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

interface FakeSynth {
  voices: FakeVoice[];
  readonly spoken: FakeUtterance[];
  readonly speak: (utterance: FakeUtterance) => void;
  readonly cancel: () => void;
  readonly getVoices: () => FakeVoice[];
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
  readonly fireVoicesChanged: () => void;
  readonly finishAll: () => void;
}

function voice(
  name: string,
  localService: boolean,
  isDefault: boolean,
): FakeVoice {
  return {
    name,
    lang: "en-US",
    localService,
    default: isDefault,
    voiceURI: name,
  };
}

const LOCAL_VOICE = voice("Samantha", true, false);
// Chrome lists its Google voices first and can mark one the default; they
// synthesize on Google's servers and report `localService: false`.
const NETWORK_VOICE = voice("Google US English", false, true);

function createSynth(voices: FakeVoice[]): FakeSynth {
  let queue: FakeUtterance[] = [];
  const spoken: FakeUtterance[] = [];
  const listeners = new Set<() => void>();
  const synth: FakeSynth = {
    voices,
    spoken,
    speak: vi.fn((utterance: FakeUtterance) => {
      queue.push(utterance);
      spoken.push(utterance);
    }),
    cancel: vi.fn(() => {
      const interrupted = queue;
      queue = [];
      for (const utterance of interrupted) utterance.onerror?.();
    }),
    getVoices: () => synth.voices,
    addEventListener: (type, listener) => {
      if (type === "voiceschanged") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "voiceschanged") listeners.delete(listener);
    },
    fireVoicesChanged: () => {
      for (const listener of listeners) listener();
    },
    finishAll: () => {
      const finished = queue;
      queue = [];
      for (const utterance of finished) utterance.onend?.();
    },
  };
  return synth;
}

function installSpeech(synth: FakeSynth | null): void {
  if (synth === null) {
    Reflect.deleteProperty(window, "speechSynthesis");
    Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
    return;
  }
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    writable: true,
    value: synth,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    writable: true,
    value: FakeUtterance,
  });
}

function render(ui: ReactNode) {
  // A fenced code block's renderer reads the query client.
  const queryClient = new QueryClient();
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <ChatExpansionTestProviders tileInstanceId="read-aloud-test-tile">
          {ui}
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>,
  );
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

    const cancelsBeforeStop = vi.mocked(synth.cancel).mock.calls.length;
    fireEvent.click(button);
    expect(vi.mocked(synth.cancel).mock.calls.length).toBe(
      cancelsBeforeStop + 1,
    );
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
    const cancelsBeforeUnmount = vi.mocked(synth.cancel).mock.calls.length;

    view.unmount();

    expect(vi.mocked(synth.cancel).mock.calls.length).toBe(
      cancelsBeforeUnmount + 1,
    );
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

    const said = synth.spoken.map((utterance) => utterance.text).join(" ");
    expect(said).toBe("Result Run this with bun and see the docs. Done.");
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

    expect(synth.spoken.length).toBeGreaterThan(0);
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
