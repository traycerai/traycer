import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerCall } from "@/components/layout/voice/use-composer-call";
import { useDictationHotkey } from "@/hooks/composer/use-dictation-hotkey";
import { KeyboardOwnerContext } from "@/hooks/use-primary-action-shortcut";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";

const THREAD: CallTarget = { botId: "bot-1", threadId: "t-1" };
const CHANNEL: CallTarget = { botId: "bot-1", threadId: null };

const CHORD = { code: "KeyM", ctrlKey: true, shiftKey: true } as const;

const driver = {
  start: vi.fn<(target: CallTarget) => void>(),
  end: vi.fn<() => void>(),
  setMuted: vi.fn<(muted: boolean) => void>(),
};

/** An agent chat's composer: the dictation owner of the chord. */
function DictationComposer(props: { readonly start: () => void }): ReactNode {
  useDictationHotkey({
    enabled: true,
    state: "idle",
    start: props.start,
    stop: () => undefined,
    cancel: () => undefined,
  });
  return null;
}

function OwnsKeyboard(props: { readonly children: ReactNode }): ReactNode {
  return <KeyboardOwnerContext value>{props.children}</KeyboardOwnerContext>;
}

/** A bot's message box, as far as the chord is concerned. */
function BotBox(props: { readonly target: CallTarget }): ReactNode {
  useComposerCall(props.target.botId, props.target.threadId, null);
  return null;
}

function botBox(target: CallTarget): ReactNode {
  return <BotBox target={target} />;
}

function tap(): void {
  fireEvent.keyDown(window, CHORD);
  fireEvent.keyUp(window, CHORD);
}

beforeEach(() => {
  driver.start.mockReset();
  driver.end.mockReset();
  driver.setMuted.mockReset();
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  useVoiceSessionStore.getState().setDriver(driver);
  useVoiceSessionStore.getState().setAvailability("live");
});

afterEach(cleanup);

describe("the dictation chord on a bot surface", () => {
  it("starts a call with the thread's target from a bot thread", () => {
    render(<OwnsKeyboard>{botBox(THREAD)}</OwnsKeyboard>);

    tap();

    expect(driver.start.mock.calls).toEqual([[THREAD]]);
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("takes the chord from a dictation composer mounted beneath the bot surface", () => {
    const dictate = vi.fn<() => void>();
    render(
      <OwnsKeyboard>
        <DictationComposer start={dictate} />
        {botBox(THREAD)}
      </OwnsKeyboard>,
    );

    tap();

    expect(driver.start.mock.calls).toEqual([[THREAD]]);
    expect(dictate).not.toHaveBeenCalled();
  });

  it("hands the chord back to dictation once the bot surface unmounts", () => {
    const dictate = vi.fn<() => void>();
    const view = render(
      <OwnsKeyboard>
        <DictationComposer start={dictate} />
        {botBox(THREAD)}
      </OwnsKeyboard>,
    );
    view.rerender(
      <OwnsKeyboard>
        <DictationComposer start={dictate} />
      </OwnsKeyboard>,
    );

    tap();

    expect(dictate).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("dictates in an agent chat and starts no call", () => {
    const dictate = vi.fn<() => void>();
    render(
      <OwnsKeyboard>
        <DictationComposer start={dictate} />
      </OwnsKeyboard>,
    );

    tap();

    expect(dictate).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("ends the call that is live and starts none", () => {
    useVoiceSessionStore.setState({
      phase: "live",
      focus: { botId: "bot-1", hostId: "host-a", threadId: "t-1" },
    });
    render(<OwnsKeyboard>{botBox(THREAD)}</OwnsKeyboard>);

    tap();

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("calls the thread's target when the channel shows first and the thread after", () => {
    render(
      <OwnsKeyboard>
        {botBox(CHANNEL)}
        {botBox(THREAD)}
      </OwnsKeyboard>,
    );

    tap();

    expect(driver.start.mock.calls).toEqual([[THREAD]]);
  });

  it("calls the thread's target when the thread shows first and the channel after", () => {
    render(
      <OwnsKeyboard>
        {botBox(THREAD)}
        {botBox(CHANNEL)}
      </OwnsKeyboard>,
    );

    tap();

    expect(driver.start.mock.calls).toEqual([[THREAD]]);
  });

  it("toggles once for a held chord, however many times the key repeats", () => {
    render(<OwnsKeyboard>{botBox(THREAD)}</OwnsKeyboard>);

    fireEvent.keyDown(window, CHORD);
    fireEvent.keyDown(window, { ...CHORD, repeat: true });
    fireEvent.keyDown(window, { ...CHORD, repeat: true });
    fireEvent.keyDown(window, { ...CHORD, repeat: true });
    fireEvent.keyUp(window, CHORD);

    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("leaves the chord to dictation until the server has said voice is offered", () => {
    useVoiceSessionStore.getState().setAvailability("dormant");
    const dictate = vi.fn<() => void>();
    render(
      <OwnsKeyboard>
        <DictationComposer start={dictate} />
        {botBox(THREAD)}
      </OwnsKeyboard>,
    );

    tap();

    expect(dictate).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("leaves the chord to dictation while the bot surface does not own the keyboard", () => {
    const dictate = vi.fn<() => void>();
    render(
      <>
        <OwnsKeyboard>
          <DictationComposer start={dictate} />
        </OwnsKeyboard>
        <KeyboardOwnerContext value={false}>
          {botBox(THREAD)}
        </KeyboardOwnerContext>
      </>,
    );

    tap();

    expect(dictate).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });
});
