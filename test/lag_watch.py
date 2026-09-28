#!/usr/bin/env python3
"""lag_watch.py — run this WHILE the freeze happens. It answers one question:
is pi burning local CPU (an extension) or sleeping on the network (provider)?

usage: python3 lag_watch.py [seconds]        # default 90

Samples the newest interactive `pi` process every 100 ms and records:
  state      R = running (burning CPU)   S = sleeping   D = uninterruptible IO
  cpu        utime+stime ticks (10 ms each) since previous sample
  wchan      kernel wait channel (what it is blocked on)
  sess_mtime mtime of the active session jsonl (a write = pi did local work)

At the end: how much of the window was local CPU vs idle, plus every idle gap
longer than 1s with the wait channel at the time.
"""
import glob, os, subprocess, sys, time

DUR = int(sys.argv[1]) if len(sys.argv) > 1 else 90
STEP = 0.1
TICK = 0.01  # one utime/stime tick = 10 ms


def newest_pi():
    best = None
    for p in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(p, "rb") as f:
                argv = f.read().split(b"\0")
        except OSError:
            continue
        if not argv or b"pi" not in os.path.basename(argv[0]):
            continue
        pid = int(p.split("/")[2])
        if any(b"--mode" == a or a == b"json" for a in argv):
            continue  # skip my own print-mode benchmarks
        try:
            with open(f"/proc/{pid}/stat") as f:
                fields = f.read().rsplit(") ", 1)[1].split()
            cpu = int(fields[11]) + int(fields[12])  # utime, stime
        except (OSError, IndexError, ValueError):
            continue
        if best is None or cpu < best[1]:
            best = (pid, cpu)
    return best


pid, prev = newest_pi()
if pid is None:
    sys.exit("no interactive pi process found (start pi, then run this)")

sess = max(glob.glob(os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl")), key=os.path.getmtime, default=None)
prev_mtime = os.path.getmtime(sess) if sess else 0

print(f"watching pid {pid}  session={os.path.basename(sess) if sess else '?'}  for {DUR}s")
print("press Enter in pi when the freeze starts; type 'r' + Enter here after it ends\n")

t0 = time.monotonic()
samples = 0
cpu_busy = 0.0
idle_gaps = []
gap_start = None
gap_state = ""
transitions = []
prev_state = ""

while time.monotonic() - t0 < DUR:
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(") ", 1)[1].split()
        state, cpu = fields[0], int(fields[11]) + int(fields[12])
    except OSError:
        break
    now = time.monotonic() - t0
    dt = cpu - prev
    prev = cpu
    used = dt * TICK
    samples += 1
    if used > STEP * 0.5:
        cpu_busy += STEP
        if gap_start is not None:
            idle_gaps.append((gap_start, now, gap_state))
            gap_start = None
    else:
        if gap_start is None:
            gap_start, gap_state = now, state
    if state != prev_state:
        w = ""
        try:
            w = open(f"/proc/{pid}/wchan").read().strip()[:24]
        except OSError:
            pass
        if now > 0.4:
            transitions.append(f"    t={now:6.1f}s  {prev_state or '-'}->{state}  wchan={w or '-'}")
        prev_state = state
    time.sleep(STEP)

if gap_start is not None:
    idle_gaps.append((gap_start, time.monotonic() - t0, gap_state))

print(f"\nsamples {samples}   window {time.monotonic()-t0:.1f}s")
print(f"local CPU busy : {cpu_busy:.1f}s  ({100*cpu_busy/(time.monotonic()-t0):.1f}% of window)")
print(f"idle/sleeping  : {time.monotonic()-t0-cpu_busy:.1f}s")
long = [g for g in idle_gaps if g[1] - g[0] >= 1.0]
print(f"\nidle gaps >= 1s: {len(long)}")
for a, b, s in long:
    print(f"    {b-a:5.1f}s  from t={a:6.1f}s  state={s or '?'}   <-- pi waiting, not working")
print("\nstate transitions:")
print("\n".join(transitions[-25:]) or "    (none)")
