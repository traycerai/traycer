import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { MAX_INSTALL_TOKEN_LENGTH } from "../host/team-install-token";

export { MAX_INSTALL_TOKEN_LENGTH } from "../host/team-install-token";

// The one-time token for `traycer host install --team <team>`. Never on the
// command line: `ps` shows a process's arguments to every local user, and the
// shell keeps them in its history, so a token there can be redeemed first by
// someone else. A terminal gets a prompt that echoes nothing; anything else
// (`traycer host install --team <team> < token-file`) gives the token as the
// first line on stdin.

const END_OF_TEXT = "\u0003";
const END_OF_TRANSMISSION = "\u0004";
const BACKSPACE = "\b";
const DELETE = "\u007f";

interface InstallTokenInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

function cancelled(): Error {
  return cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: "host install: cancelled.",
    details: null,
    exitCode: 1,
  });
}

/**
 * The first line of `input`. In raw mode a terminal hands over the keys that
 * a line discipline would have acted on, so they are acted on here. Input past
 * the cap is dropped, which leaves a line the token check refuses. `onListening`
 * runs once the input is being read.
 */
function readTokenLine(
  input: InstallTokenInput,
  onListening: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let line = "";
    const stop = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
    };
    const onEnd = (): void => {
      stop();
      resolve(line);
    };
    const onError = (error: unknown): void => {
      stop();
      reject(error);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n" || char === END_OF_TRANSMISSION) {
          onEnd();
          return;
        }
        if (char === END_OF_TEXT) {
          stop();
          reject(cancelled());
          return;
        }
        if (char === BACKSPACE || char === DELETE) {
          line = line.slice(0, -1);
        } else if (line.length <= MAX_INSTALL_TOKEN_LENGTH) {
          line += char;
        }
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
    try {
      onListening();
    } catch (error) {
      onError(error);
    }
  });
}

/**
 * The install token from `input`, prompting on `prompt` with nothing echoed
 * when `input` is a terminal. A run that may not prompt is refused there: it
 * has no one to ask, and a line read from a terminal would echo. A pipe gets
 * no time limit, because over `ssh` without a terminal a person pastes into it.
 */
export async function readInstallToken(
  input: InstallTokenInput,
  prompt: NodeJS.WritableStream,
  canPrompt: boolean,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    return readTokenLine(input, () => undefined);
  }
  if (!canPrompt) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "host install: give the install token on stdin.",
      details: null,
      exitCode: 1,
    });
  }
  // Nothing may tell a person to paste until the terminal has stopped echoing
  // and the reader is listening, or what they paste lands on the screen.
  input.setRawMode(true);
  try {
    return await readTokenLine(input, () => {
      prompt.write("Install token: ");
    });
  } finally {
    input.setRawMode(false);
    prompt.write("\n");
  }
}
