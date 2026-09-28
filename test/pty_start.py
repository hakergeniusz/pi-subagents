#!/usr/bin/env python3
"""Measure pi TUI startup-to-interactive latency and 'typed too early' echo latency.

usage: pty_start.py [--reps N] [-- <pi args...>]
"""
import os, pty, re, select, subprocess, sys, time, fcntl, termios, struct, argparse

ap = argparse.ArgumentParser()
ap.add_argument("--reps", type=int, default=3)
ap.add_argument("--text", default="ping3")
ap.add_argument("pi_args", nargs=argparse.REMAINDER)
a = ap.parse_args()
pi_args = a.pi_args[1:] if a.pi_args and a.pi_args[0] == "--" else a.pi_args

FOOTER = re.compile(r"(\d+(\.\d+)?%/\d+k|esc to|\u203a )")   # context meter / prompt hint


def one_run(pi_args, type_early: bool):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 130, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", COLUMNS="130", LINES="45")
    t0 = time.time()
    proc = subprocess.Popen(["pi", *pi_args], stdin=slave, stdout=slave, stderr=slave,
                            env=env, cwd="/tmp/pi-lag-test", close_fds=True)
    os.close(slave)
    fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
    buf = bytearray()
    first_frame = None
    deadline = time.time() + 90
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.02)
        if r:
            try: chunk = os.read(master, 65536)
            except BlockingIOError: continue
            except OSError: break
            if not chunk: break
            if first_frame is None:
                first_frame = time.time() - t0
            buf.extend(chunk)
        if first_frame and FOOTER.search(buf.decode("utf8", "replace")):
            break
    t_ready = time.time() - t0
    res = {"first_output_ms": first_frame * 1000 if first_frame else None,
           "interactive_ms": t_ready * 1000}
    if type_early:
        # user was impatient: type immediately, measure until it shows up
        buf.clear()
        te = time.time()
        os.write(master, (a.text + "\n").encode())
        end = time.time() + 60
        seen = None
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.02)
            if r:
                try: chunk = os.read(master, 65536)
                except BlockingIOError: continue
                except OSError: break
                if not chunk: break
                buf.extend(chunk)
                if a.text in buf.decode("utf8", "replace"):
                    seen = time.time() - te
                    break
        res["early_echo_ms"] = seen * 1000 if seen else None
    proc.terminate()
    try: proc.wait(timeout=5)
    except Exception: proc.kill()
    os.close(master)
    return res


def fmt(r):
    def g(k):
        v = r.get(k)
        return f"{v:.0f}ms" if v is not None else "n/a"
    return f"first_output={g('first_output_ms'):>8} interactive={g('interactive_ms'):>8} early_echo={g('early_echo_ms'):>8}"


for mode in (False, True):
    label = "type-early" if mode else "wait-ready "
    for i in range(a.reps):
        args = pi_args if not mode else ["--no-session", *pi_args]
        print(f"{label} run{i+1}: {fmt(one_run(args, mode))}")
