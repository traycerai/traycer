#!/usr/bin/env bash
# Machine-wide counted semaphore for memory-heavy local checks.
#
#   machine-slot.sh <name> <slots|auto> <command...>   run <command> in a slot
#   . machine-slot.sh; machine_slot_acquire <name> <slots|auto>
#                                                     hold a slot until this
#                                                     shell exits
#
# WHY: a type-check holds its whole program resident (gui-app ~4.7 GB cold,
# traycer-host ~3.9 GB), and nx's --parallel only bounds ONE invocation. With
# agents committing from several worktrees at once, those peaks add up across
# processes until macOS swaps the machine to a halt. A slot bounds how many of
# them run on the machine at the same time.
#
# `auto` sizes the pool from physical memory: one slot per 16 GB, minimum one.
# `TRAYCER_MACHINE_SLOTS` overrides it for every name.
#
# The internal monorepo's hook sources this file through its traycer/
# submodule, so both repos' hooks take the same lock files and a commit in
# one waits for a commit in the other.
#
# HOW THE LOCK IS HELD
#
# A small python process takes `flock` on its OWN descriptor (python opens
# files non-inheritable) and stays alive until the shell that asked for the
# slot exits. The shell's children never receive the descriptor. That matters:
# a lock fd held by the hook's bash would be inherited by every child,
# including a detached nx daemon, and the slot would stay taken until that
# daemon died (machine-wide serialization, #4896 in the internal repo, hit
# exactly this with orphans). Here the holder watches its parent pid and
# exits within 0.2 s of the parent, and the kernel drops the flock when the
# holder dies, so SIGKILL and OOM kills cannot strand a slot either.
#
# The wait is bounded (TRAYCER_MACHINE_SLOT_TIMEOUT seconds, default 1800).
# On timeout the command runs anyway with a warning. That is the behaviour
# before this lock existed, and it beats a wedged commit.
#
# No fcntl (native Windows python) or no python3: run unserialized, silently
# on Windows because the lock has no implementation there.
#
# Written for bash 3.2 (macOS /bin/bash): no coproc, no {fd} redirections.

machine_slot__count() {
    local requested="$1"
    if [ -n "${TRAYCER_MACHINE_SLOTS:-}" ]; then
        requested="$TRAYCER_MACHINE_SLOTS"
    fi
    case "$requested" in
        '' | *[!0-9]*)
            if [ "$requested" != "auto" ]; then
                echo "machine-slot: ignoring invalid slot count '$requested'; using auto" >&2
            fi
            local bytes=""
            if [ -r /proc/meminfo ]; then
                bytes=$(awk '/^MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo)
            else
                bytes=$(sysctl -n hw.memsize 2>/dev/null || true)
            fi
            case "$bytes" in
                '' | *[!0-9]*) echo 1 ;;
                *)
                    local slots=$((bytes / 17179869184))
                    [ "$slots" -lt 1 ] && slots=1
                    echo "$slots"
                    ;;
            esac
            ;;
        *)
            # Cap the digits before arithmetic: an absurd value must not
            # overflow into something negative.
            if [ "${#requested}" -gt 3 ] || [ "$requested" -lt 1 ]; then
                echo 1
            else
                echo "$requested"
            fi
            ;;
    esac
}

machine_slot__dir() {
    if [ -n "${TRAYCER_MACHINE_SLOT_DIR:-}" ]; then
        printf '%s' "$TRAYCER_MACHINE_SLOT_DIR"
    elif [ -n "${TMPDIR:-}" ]; then
        # Per-user on macOS, and the same value for every agent session.
        printf '%s' "${TMPDIR%/}"
    elif [ -n "${XDG_RUNTIME_DIR:-}" ]; then
        # Linux without TMPDIR: never fall back to a world-writable /tmp.
        printf '%s' "$XDG_RUNTIME_DIR"
    else
        mkdir -p "$HOME/.cache" && printf '%s' "$HOME/.cache"
    fi
}

# machine_slot_acquire <name> <slots|auto>
# Returns once a slot is held (or the wait timed out). The slot is released
# when the calling shell exits.
machine_slot_acquire() {
    local name="$1"
    local held_var
    held_var="TRAYCER_MACHINE_SLOT_HELD_$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_')"
    if [ "$(eval "printf '%s' \"\${${held_var}:-}\"")" = "1" ]; then
        return 0
    fi

    if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import fcntl' >/dev/null 2>&1; then
        return 0
    fi

    local slots dir timeout status_file status holder
    slots="$(machine_slot__count "$2")"
    dir="$(machine_slot__dir)"
    timeout="${TRAYCER_MACHINE_SLOT_TIMEOUT:-1800}"
    case "$timeout" in '' | *[!0-9]*) timeout=1800 ;; esac
    [ "${#timeout}" -gt 6 ] && timeout=1800

    status_file="$(mktemp "${dir}/traycer-slot-status.XXXXXX")"

    # The holder's parent must be THIS shell, so it is started directly rather
    # than from a subshell or a command substitution.
    python3 -c '
import errno, fcntl, os, sys, time

directory, name, slots, timeout, status_file = sys.argv[1:6]
slots, timeout = int(slots), int(timeout)
parent = os.getppid()

def report(message):
    staging = status_file + ".tmp"
    with open(staging, "w") as handle:
        handle.write(message + "\n")
    os.replace(staging, status_file)

descriptors = []
for index in range(slots):
    path = os.path.join(directory, "traycer-slot-%s.%d.lock" % (name, index))
    # Append, no truncation, no symlink following: the path may be predictable.
    descriptors.append(os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, 0o600))

deadline = time.monotonic() + timeout
announced = False
held = None
while held is None:
    for descriptor in descriptors:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            held = descriptor
            break
        except OSError as error:
            if error.errno not in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                raise
    if held is not None:
        break
    if os.getppid() != parent:
        sys.exit(0)
    if time.monotonic() >= deadline:
        report("timeout")
        sys.exit(0)
    if not announced:
        sys.stderr.write(
            "machine-slot: all %d %r slot(s) are busy on this machine; waiting...\n" % (slots, name)
        )
        sys.stderr.flush()
        announced = True
    time.sleep(0.5)

for descriptor in descriptors:
    if descriptor != held:
        os.close(descriptor)
# Let go of the caller stderr: pre-commit reads the hook output until EOF,
# and this process outlives the hook by up to one poll interval.
null = os.open(os.devnull, os.O_WRONLY)
os.dup2(null, 2)
report("held")

# Hold until the shell that asked for the slot is gone.
while os.getppid() == parent:
    time.sleep(0.2)
' "$dir" "$name" "$slots" "$timeout" "$status_file" </dev/null >/dev/null &
    holder=$!

    # Poll rather than block on a pipe: a holder that dies before reporting
    # must not wedge this shell.
    status=""
    while :; do
        if [ -s "$status_file" ]; then
            read -r status <"$status_file" || true
            break
        fi
        if ! kill -0 "$holder" 2>/dev/null; then
            [ -s "$status_file" ] && read -r status <"$status_file"
            break
        fi
        sleep 0.2
    done
    rm -f "$status_file" "$status_file.tmp"

    case "$status" in
        held)
            export "${held_var}=1"
            ;;
        timeout)
            echo "machine-slot: waited ${timeout}s for a '${name}' slot; running without one." >&2
            echo "machine-slot: another run on this machine is still holding it (a hung type-check?)." >&2
            ;;
        *)
            echo "machine-slot: the slot holder exited unexpectedly; running without a slot." >&2
            ;;
    esac
    return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    if [ "$#" -lt 3 ]; then
        echo "usage: machine-slot.sh <name> <slots|auto> <command...>" >&2
        exit 2
    fi
    slot_name="$1"
    slot_count="$2"
    shift 2
    machine_slot_acquire "$slot_name" "$slot_count"
    # Not exec: this shell must outlive the command, because the holder is
    # released when this shell exits.
    "$@"
fi
