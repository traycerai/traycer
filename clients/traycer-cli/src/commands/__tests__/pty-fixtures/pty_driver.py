"""Drives one child on a real pseudo-terminal for host-join-token.pty.test.ts.

argv[1] is JSON: {"command": [...], "payload_hex": "...", "runs": N,
"timeout_seconds": S}. Per run the child gets the slave as stdin, stdout and
stderr. The moment the prompt is readable on the master, the terminal's flags
are read and the payload is written, with no delay. Once the child reports
its read, the flags are read again, the child is released, and they are read
once more after it exits by itself. Prints a JSON list, one entry per run.
"""

import json
import os
import select
import signal
import subprocess
import sys
import termios
import time

PROMPT = b"Install token: "
REPORTS = (b"READ ", b"REFUSED ")


def flags(fd):
    lflag = termios.tcgetattr(fd)[3]
    return {"echo": bool(lflag & termios.ECHO), "icanon": bool(lflag & termios.ICANON)}


def read_until(master, buffer, needles, deadline):
    while not any(needle in buffer for needle in needles):
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        ready, _, _ = select.select([master], [], [], left)
        if not ready:
            continue
        try:
            chunk = os.read(master, 4096)
        except OSError:
            return any(needle in buffer for needle in needles)
        if not chunk:
            return any(needle in buffer for needle in needles)
        buffer.extend(chunk)
    return True


def drain(master, buffer):
    while True:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            return
        try:
            chunk = os.read(master, 4096)
        except OSError:
            return
        if not chunk:
            return
        buffer.extend(chunk)


def run_once(command, payload, timeout_seconds):
    master, slave = os.openpty()
    child = subprocess.Popen(
        command, stdin=slave, stdout=slave, stderr=slave, close_fds=True
    )
    deadline = time.monotonic() + timeout_seconds
    buffer = bytearray()
    result = {
        "prompt_seen": False,
        "at_prompt": None,
        "reported": False,
        "after_read": None,
        "exit_code": None,
        "after_exit": None,
        "timed_out": False,
    }
    try:
        result["prompt_seen"] = read_until(master, buffer, (PROMPT,), deadline)
        if result["prompt_seen"]:
            result["at_prompt"] = flags(slave)
            os.write(master, payload)
            result["reported"] = read_until(master, buffer, REPORTS, deadline)
        if result["reported"]:
            result["after_read"] = flags(slave)
            child.send_signal(signal.SIGUSR2)
            try:
                result["exit_code"] = child.wait(timeout=max(deadline - time.monotonic(), 0.1))
            except subprocess.TimeoutExpired:
                pass
        if result["exit_code"] is None:
            result["timed_out"] = True
            child.kill()
            child.wait()
        else:
            result["after_exit"] = flags(slave)
        drain(master, buffer)
    finally:
        os.close(master)
        os.close(slave)
    result["output"] = buffer.decode("latin-1")
    return result


def main():
    spec = json.loads(sys.argv[1])
    payload = bytes.fromhex(spec["payload_hex"])
    results = [
        run_once(spec["command"], payload, spec["timeout_seconds"])
        for _ in range(spec["runs"])
    ]
    print(json.dumps(results))


main()
