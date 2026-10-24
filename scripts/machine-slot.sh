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
# `auto` has two parts.
#
#   POOL: how many slot files exist, one per 16 GiB of physical memory
#   (MemTotal on Linux, hw.memsize on macOS), minimum one. It is stable, so
#   every caller on a machine agrees on it.
#
#   ADMISSION: on Linux, a caller only takes a free slot file in one of two
#   cases. Either no slot file is held at all, so a lone caller is never
#   starved; or MemAvailable (re-read on every poll while it waits) is at least
#   16 GiB plus 12 GiB (above one tsgo peak) for EVERY held slot file.
#   MemAvailable already leaves out what the holders use, but only once they
#   have reached their peak: a holder just admitted is still in format or nx
#   startup, long before its type-check takes its memory, and how long that
#   takes varies with the hook. So every live holder is assumed not to have
#   peaked yet, for as long as it holds its slot. That double-counts a holder
#   already at its peak, on purpose: the reservation can never expire early, and
#   it needs no clock (nothing to age across a suspend or a clock step).
#   MemAvailable gates a newcomer rather than sizing the pool because sizing
#   from it would count the holders twice. Memory in a tmpfs /tmp and other
#   resident sets show up in it, MemTotal hides them. A kernel without
#   MemAvailable, and macOS (it compresses memory, so vm_stat's free pages are
#   not a usable budget), get the pool only.
#
#   Admission is atomic and ordered. Every auto caller holds an exclusive flock
#   on traycer-slot-<name>.admit.lock around its read of MemAvailable, the probe
#   and the lock, so a second caller always sees the first one's lock. A caller
#   stopped (SIGSTOP) while it holds the gate, a window of milliseconds per
#   admission, makes the others wait until it continues or they time out. A
#   caller that is refused leaves a ticket (traycer-slot-<name>.wait.<pid>,
#   holding its start time and its own deadline) and only the oldest live ticket
#   is admitted, so a later arrival cannot keep overtaking a waiter. A ticket is
#   live while its owner holds a flock on it, which the kernel drops on any
#   death, so SIGTERM, an OOM kill, a reboot or a recycled pid cannot keep one
#   alive; whoever can lock a ticket removes it. The owner also rewrites a
#   heartbeat into its ticket on every poll that gets through the admission
#   gate, and a locked ticket whose heartbeat is more than 5 seconds old is
#   ignored, so a stopped (Ctrl-Z) waiter stops blocking within seconds, even a
#   lone caller. A ticket past its owner's deadline is ignored too. Ticket times
#   are time.monotonic(), one clock for every process, so a clock step or a
#   suspend cannot reorder or wedge anything.
#
#   A caller refused by admission behind a long holder waits up to
#   TRAYCER_MACHINE_SLOT_TIMEOUT and then runs unserialized with a warning that
#   names the last reason (memory shortfall, a waiter ahead, no free file,
#   another caller holding the admission gate), which is what happened before
#   this lock existed.
#
# `TRAYCER_MACHINE_SLOTS` (or an explicit count argument) is a pool of exactly
# that size with no admission check: it turns admission off. Admission also
# looks at up to 16 existing slot files past this caller's own pool, so a
# holder from a larger explicit pool is seen.
#
# Test-only, nothing else should set it: `TRAYCER_MACHINE_SLOT_MEMINFO`
# points the Linux reads at another regular file.
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
# No python3, or a python3 without fcntl: run unserialized, without a
# message. pre-commit is itself a python tool, so on a machine that runs these
# hooks that means native Windows python, where the lock has no
# implementation.
#
# Written for bash 3.2 (macOS /bin/bash): no coproc, no {fd} redirections.

# True when the slot count is a number (an argument or TRAYCER_MACHINE_SLOTS)
# rather than `auto`. An explicit count has no admission check.
machine_slot__explicit() {
    local requested="$1"
    if [ -n "${TRAYCER_MACHINE_SLOTS:-}" ]; then
        requested="$TRAYCER_MACHINE_SLOTS"
    fi
    case "$requested" in
        '' | *[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

# The file the Linux memory reads come from. The test seam is only honoured
# for a regular file: a FIFO or a device would hang the read.
machine_slot__meminfo() {
    if [ -n "${TRAYCER_MACHINE_SLOT_MEMINFO:-}" ] && [ -f "$TRAYCER_MACHINE_SLOT_MEMINFO" ]; then
        printf '%s' "$TRAYCER_MACHINE_SLOT_MEMINFO"
    else
        printf '%s' /proc/meminfo
    fi
}

# Prints the size of the pool: how many slot files there are.
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
            # The pool is physical memory, never MemAvailable: MemAvailable
            # already leaves out what the current holders use, so dividing it
            # by 16 GiB would count them twice (see ADMISSION in the header).
            # macOS keeps hw.memsize.
            local kib="" meminfo
            meminfo="$(machine_slot__meminfo)"
            if [ -f "$meminfo" ] && [ -r "$meminfo" ]; then
                kib=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo")
            else
                kib=$(sysctl -n hw.memsize 2>/dev/null || true)
                case "$kib" in
                    '' | *[!0-9]*) kib="" ;;
                    *)
                        if [ "${#kib}" -gt 15 ]; then
                            kib=""
                        else
                            kib=$((10#$kib / 1024))
                        fi
                        ;;
                esac
            fi
            # Cap the digits before the pool arithmetic, as for an explicit
            # count (the macOS value was capped above, before its own division):
            # an absurd value must not overflow into something negative.
            case "$kib" in
                '' | *[!0-9]*) echo 1 ;;
                *)
                    if [ "${#kib}" -gt 12 ]; then
                        echo 1
                    else
                        local slots=$((10#$kib / 16777216))
                        [ "$slots" -lt 1 ] && slots=1
                        echo "$slots"
                    fi
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

# The directory is a per-USER key, never $TMPDIR: a shell or harness that
# overrides TMPDIR (nix-shell, an agent sandbox) would otherwise take locks in
# a private directory and stop queueing behind everyone else, silently.
# macOS: the user's confstr temp dir (what TMPDIR normally is, but read from
# the OS). Elsewhere: XDG_RUNTIME_DIR, then ~/.cache - never a world-writable
# /tmp.
machine_slot__dir() {
    local darwin_temp=""
    if [ -n "${TRAYCER_MACHINE_SLOT_DIR:-}" ]; then
        printf '%s' "$TRAYCER_MACHINE_SLOT_DIR"
        return
    fi
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
        darwin_temp="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
    fi
    if [ -n "$darwin_temp" ] && [ -d "$darwin_temp" ]; then
        printf '%s' "${darwin_temp%/}"
    elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ]; then
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

    local slots admit meminfo dir timeout status_file status holder
    slots="$(machine_slot__count "$2")"
    admit=1
    if machine_slot__explicit "$2"; then
        admit=0
    fi
    meminfo="$(machine_slot__meminfo)"
    dir="$(machine_slot__dir)"
    timeout="${TRAYCER_MACHINE_SLOT_TIMEOUT:-1800}"
    case "$timeout" in '' | *[!0-9]*) timeout=1800 ;; esac
    [ "${#timeout}" -gt 6 ] && timeout=1800

    if ! status_file="$(mktemp "${dir}/traycer-slot-status.XXXXXX" 2>/dev/null)"; then
        echo "machine-slot: cannot create a status file in '${dir}'; running without a slot." >&2
        return 0
    fi

    # The holder's parent must be THIS shell, so it is started directly rather
    # than from a subshell or a command substitution, and it is TOLD that
    # parent ($$) rather than reading os.getppid() at startup: a shell killed
    # while python is still starting has already reparented it to pid 1, and a
    # holder that adopted 1 as its parent would hold the slot until reboot.
    python3 -c '
import atexit, errno, fcntl, os, random, sys, time

directory, name, slots, timeout, status_file, parent, admit, meminfo = sys.argv[1:9]
slots, timeout, parent = int(slots), int(timeout), int(parent)
if os.getppid() != parent:
    sys.exit(0)

def report(message):
    staging = status_file + ".tmp"
    with open(staging, "w") as handle:
        handle.write(message + "\n")
    os.replace(staging, status_file)

descriptors = []
for index in range(slots):
    path = os.path.join(directory, "traycer-slot-%s.%d.lock" % (name, index))
    # Append, no truncation, no symlink following: the path may be predictable.
    try:
        descriptors.append(os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, 0o600))
    except OSError as error:
        report("error cannot open %s: %s" % (path, error.strerror))
        sys.exit(0)

ADMIT_KIB = 16 * 1024 * 1024
# Above one type-check peak: the internal hook runs nx --parallel=3 and
# the traycer-host type-check alone is about 6 GiB, so one hook can exceed
# 8 GiB.
# Every live holder is assumed not to have reached its peak yet, however long it
# has held its slot: a newcomer must leave this much per held slot file on top
# of ADMIT_KIB. That double-counts a holder already at its peak, on purpose: it
# can never expire early and needs no clock.
RAMP_KIB = 12 * 1024 * 1024
# A locked ticket counts only while the heartbeat of its owner is this fresh.
# The owner beats on every poll that gets through the admission gate, so a
# stopped owner stops blocking others within a few seconds.
HEARTBEAT_SECONDS = 5.0
# Admission looks at up to this many existing slot files past the pool this
# caller sized, so a holder from a larger explicit pool is seen too, whatever
# the size of the auto pool.
PROBE_LIMIT = 16

def available_kib():
    # MemAvailable in KiB, or None when there is nothing to check against:
    # an explicit count, macOS, a kernel without MemAvailable, an unreadable file.
    if admit != "1":
        return None
    try:
        if not os.path.isfile(meminfo):
            return None
        with open(meminfo) as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    fields = line.split()
                    if len(fields) >= 2 and fields[1].isdigit() and len(fields[1]) <= 12:
                        return int(fields[1])
                    return None
    except OSError:
        return None
    return None

def busy(error):
    return error.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES)

def open_extra_files():
    # Up to PROBE_LIMIT existing slot files past the pool this caller sized,
    # whatever its size, never created here. The first missing one ends the run.
    extras = []
    for index in range(slots, slots + PROBE_LIMIT):
        path = os.path.join(directory, "traycer-slot-%s.%d.lock" % (name, index))
        try:
            extras.append(os.open(path, os.O_RDWR | os.O_NOFOLLOW))
        except OSError:
            break
    return extras

def take_without_admission():
    # No admission applies (explicit count, macOS, no MemAvailable, or it just
    # went away): the first free slot file, and no ticket stays behind.
    descriptor = first_free()
    if descriptor is not None:
        drop_ticket()
    return descriptor

def first_free():
    for descriptor in descriptors:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return descriptor
        except OSError as error:
            if not busy(error):
                raise
    return None

# The admission gate: one exclusive flock around read meminfo, probe and lock
# a slot file, so a second caller always sees the first one lock.
gate = None
if admit == "1":
    gate_path = os.path.join(directory, "traycer-slot-%s.admit.lock" % name)
    try:
        gate = os.open(gate_path, os.O_CREAT | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        report("error cannot open %s: %s" % (gate_path, error.strerror))
        sys.exit(0)

def take_gate():
    # A short wait, far under the poll interval, so the deadline and parent
    # checks in the loop below still run.
    for _ in range(20):
        try:
            fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError as error:
            if not busy(error):
                raise
        time.sleep(0.01)
    return False

# Waiters queue by arrival: a refused caller leaves a ticket holding its start
# time and its own deadline, and only the oldest live ticket is admitted. A
# ticket is live while its owner holds an exclusive flock on it for the whole
# wait: the kernel drops that lock on any death (SIGKILL, SIGTERM, OOM, a
# reboot), so a recycled pid or a zombie cannot keep a ticket alive. A scanner
# that can take the lock knows the owner is gone and removes the ticket. A
# ticket past its deadline is ignored, and so is one whose owner has not beaten
# its heartbeat lately (a stopped, SIGSTOP, owner). Every time here is
# time.monotonic(), one clock for all processes.
started = time.monotonic()
me = (started, os.getpid())
ticket_prefix = "traycer-slot-%s.wait." % name
my_ticket = os.path.join(directory, ticket_prefix + str(os.getpid()))
ticket_fd = None
refusal = [""]

def drop_ticket():
    global ticket_fd
    try:
        os.unlink(my_ticket)
    except OSError:
        pass
    if ticket_fd is not None:
        os.close(ticket_fd)
        ticket_fd = None

atexit.register(drop_ticket)

def write_ticket():
    # Called under the gate on every refusal: creates the ticket the first
    # time and rewrites its heartbeat every time.
    global ticket_fd
    fd = ticket_fd
    try:
        if fd is None:
            fd = os.open(my_ticket, os.O_CREAT | os.O_RDWR | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        data = ("%r %r %r\n" % (started, started + timeout, time.monotonic())).encode()
        os.pwrite(fd, data, 0)
        os.ftruncate(fd, len(data))
        ticket_fd = fd
    except OSError:
        if fd is not None and fd != ticket_fd:
            os.close(fd)

def live_tickets():
    found = []
    now = time.monotonic()
    for entry in os.listdir(directory):
        pid = entry[len(ticket_prefix):]
        if not entry.startswith(ticket_prefix) or not pid.isdigit() or len(pid) > 10 or int(pid) == 0:
            continue
        if int(pid) == os.getpid():
            continue
        path = os.path.join(directory, entry)
        try:
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        except OSError:
            continue
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if not busy(error):
                    continue
                # Locked, so its owner is alive: count it unless unparseable,
                # past the deadline written in it, or not beaten lately.
                try:
                    arrival, due, beat = [float(word) for word in os.read(fd, 100).split()[:3]]
                except ValueError:
                    continue
                if now < due and now - beat <= HEARTBEAT_SECONDS:
                    found.append((arrival, int(pid)))
                continue
            try:
                os.unlink(path)
            except OSError:
                pass
        finally:
            os.close(fd)
    return found

def admit_one(available):
    if available is None:
        return take_without_admission()
    waiting_ahead = [ticket for ticket in live_tickets() if ticket < me]
    descriptor = first_free()
    allowed = False
    if descriptor is not None:
        # Probe every other slot file, then give the probes back. A file the
        # probe cannot lock is held by someone else.
        extras = open_extra_files()
        probed = []
        others_held = []
        for other in [d for d in descriptors if d != descriptor] + extras:
            try:
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                probed.append(other)
            except OSError as error:
                if not busy(error):
                    raise
                others_held.append(other)
        for other in probed:
            fcntl.flock(other, fcntl.LOCK_UN)
        for extra in extras:
            os.close(extra)
        # Alone: always admitted. Otherwise memory must cover the 16 GiB floor
        # plus one peak for every slot file that is held.
        needed = ADMIT_KIB + RAMP_KIB * len(others_held)
        allowed = not others_held or available >= needed
        if not allowed:
            refusal[0] = "MemAvailable is %d GiB and this needs %d GiB" % (available // 1048576, needed // 1048576)
    else:
        refusal[0] = "every slot file is held"
    if waiting_ahead:
        refusal[0] = "a waiter ahead of it has been queued for %d s" % (time.monotonic() - min(waiting_ahead)[0])
    if allowed and not waiting_ahead:
        drop_ticket()
        return descriptor
    if descriptor is not None:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    write_ticket()
    return None

def try_take():
    # The first free slot file, if admission allows one more holder, else None.
    # Exclusion is only ever the flock on a slot file, so nothing here can
    # let two holders share one. Memory is read again on every call.
    if available_kib() is None:
        return take_without_admission()
    if not take_gate():
        refusal[0] = "another caller held the admission gate"
        return None
    try:
        return admit_one(available_kib())
    finally:
        fcntl.flock(gate, fcntl.LOCK_UN)

deadline = started + timeout
announced = False
held = None
while held is None:
    held = try_take()
    if held is not None:
        break
    if os.getppid() != parent:
        sys.exit(0)
    if time.monotonic() >= deadline:
        report("timeout " + refusal[0])
        sys.exit(0)
    if not announced:
        if available_kib() is None:
            sys.stderr.write("machine-slot: all %d %r slot(s) are busy on this machine; waiting...\n" % (slots, name))
        else:
            sys.stderr.write(
                "machine-slot: waiting for a %r slot (%d slot file(s); a free one is only taken in turn, while memory allows)...\n" % (name, slots)
            )
        sys.stderr.flush()
        announced = True
    # Jitter keeps two probing newcomers from lock-stepping.
    time.sleep(0.4 + 0.2 * random.random())

for descriptor in descriptors:
    if descriptor != held:
        os.close(descriptor)
if gate is not None:
    os.close(gate)
# Let go of the caller stderr: pre-commit reads the hook output until EOF,
# and this process outlives the hook by up to one poll interval.
null = os.open(os.devnull, os.O_WRONLY)
os.dup2(null, 2)
report("held")

# Hold until the shell that asked for the slot is gone.
while os.getppid() == parent:
    time.sleep(0.2)
' "$dir" "$name" "$slots" "$timeout" "$status_file" "$$" "$admit" "$meminfo" </dev/null >/dev/null &
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
        timeout | timeout\ *)
            echo "machine-slot: waited ${timeout}s for a '${name}' slot; running without one." >&2
            if [ "$status" != "timeout" ]; then
                echo "machine-slot: last refused because ${status#timeout }." >&2
            fi
            ;;
        error\ *)
            echo "machine-slot: ${status#error }; running without a slot." >&2
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
