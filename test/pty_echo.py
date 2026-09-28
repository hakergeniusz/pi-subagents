#!/usr/bin/env python3
"""Measure pi TUI input-echo latency: time from writing "<text>\\n" to the text
appearing in the terminal output stream.

usage: pty_echo.py [--dump] [--wait SEC] [--reps N] -- <pi args...>
"""
import os, pty, re, select, subprocess, sys, time, fcntl, termios, struct, argparse

ap = argparse.ArgumentParser()
ap.add_argument("--dump", action="store_true", help="print raw output and exit")
ap.add_argument("--wait", type=float, default=25.0)
ap.add_argument("--reps", type=int, default=1)
ap.add_argument("--text", default="hello there")
ap.add_argument("--settle", type=float, default=2.0, help="seconds to wait after ready marker")
ap.add_argument("pi_args", nargs=argparse.REMAINDER)
a = ap.parse_args()
pi_args = a.pi_args[1:] if a.pi_args and a.pi_args[0] == "--" else a.pi_args

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 130, 0, 0))
env = dict(os.environ, TERM="xterm-256color", COLUMNS="130", LINES="45")
proc = subprocess.Popen(["pi", *pi_args], stdin=slave, stdout=slave, stderr=slave,
                        env=env, cwd="/tmp/pi-lag-test", close_fds=True)
os.close(slave)
fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)

buf = bytearray()
def pump(deadline):
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: chunk = os.read(master, 65536)
            except BlockingIOError: continue
            except OSError: return False
            if not chunk: return False
            buf.extend(chunk)
    return True

# wait for the composer to be ready: look for the footer/status or a settled prompt
ready = False
end = time.time() + a.wait
while time.time() < end:
    pump(time.time() + 0.3)
    txt = buf.decode("utf8", "replace")
    if re.search(r"(ready|space-bunny|bunnies|esc to)", txt, re.I):
        ready = True
        break
pump(time.time() + a.settle)
if a.dump:
    sys.stdout.write(buf.decode("utf8", "replace")[-6000:])
    proc.terminate(); proc.wait(timeout=5); sys.exit(0)
if not ready:
    print("WARN: ready marker not found; measuring anyway")

needle = a.text
for rep in range(a.reps):
    # 1) type the text WITHOUT Enter, let the composer render it
    os.write(master, needle.encode())
    pump(time.time() + 1.0)
    if needle not in buf.decode("utf8", "replace"):
        print(f"rep{rep+1}: composer never echoed typed text - aborting")
        break
    # 2) drop everything rendered so far, then press Enter and time the echo
    buf.clear()
    t0 = time.time()
    os.write(master, b"\n")
    seen = None
    end = time.time() + 30
    while time.time() < end:
        pump(time.time() + 0.02)
        if needle in buf.decode("utf8", "replace"):
            seen = time.time() - t0
            break
    print(f"rep{rep+1}: Enter->echo = {'NOT SEEN (>30s)' if seen is None else f'{seen*1000:.0f} ms'}")
    if rep < a.reps - 1:
        pump(time.time() + 4.0)          # let the turn finish
        os.write(master, b"\x1b")        # esc
        pump(time.time() + 0.5)
proc.terminate()
try: proc.wait(timeout=5)
except Exception: proc.kill()
