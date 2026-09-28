#!/usr/bin/env python3
"""Measure, in a real pi TUI, the two delays the user actually feels:
  t_echo : Enter pressed -> the submitted prompt text appears on screen
  t_work : Enter pressed -> first sign of work (spinner / status / first token)
Run several iterations; report min/median/max. Optionally pass extra pi args
(e.g. -ne to disable all extensions).
"""
import os, pty, select, subprocess, sys, time, re, statistics

ITER = int(os.environ.get("ITER", "5"))
PROMPT = os.environ.get("PROMPT", "hi")
EXTRA = sys.argv[1:]

ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>()][A-Za-z0-9]?")


def strip(b):
    return ANSI.sub(b"", b)


def once(i):
    env = dict(os.environ, TERM="xterm-256color", COLUMNS="120", LINES="40")
    master, slave = pty.openpty()
    import fcntl, struct, termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    p = subprocess.Popen(
        ["pi", *EXTRA], stdin=slave, stdout=slave, stderr=slave, cwd="/home/hakergeniusz",
        env=env, close_fds=True, preexec_fn=os.setsid)
    os.close(slave)
    buf = b""
    t_start = time.monotonic()
    ready = None
    while time.monotonic() - t_start < 60:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            continue
        try:
            buf += os.read(master, 65536)
        except OSError:
            break
        if b"?" in buf and (b"esc to" in strip(buf).lower() or b"ctrl" in strip(buf).lower()):
            ready = time.monotonic()
            break
    if ready is None:
        os.killpg(os.getpgid(p.pid), 9)
        return None
    time.sleep(1.5)  # let the TUI settle
    buf = b""
    os.write(master, PROMPT.encode() + b"\r")
    t_key = time.monotonic()
    t_echo = t_work = None
    seen = b""
    while time.monotonic() - t_key < 25:
        r, _, _ = select.select([master], [], [], 0.1)
        if not r:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        t = time.monotonic()
        clean = strip(chunk)
        seen += clean
        if t_echo is None and PROMPT.encode() in clean:
            t_echo = t
        elif t_echo is not None and t_work is None and len(clean.strip()) > 0:
            t_work = t
        if t_work is not None:
            break
    os.killpg(os.getpgid(p.pid), 9)
    os.close(master)
    if t_echo is None:
        return None
    return (t_echo - t_key) * 1000, ((t_work or t_echo) - t_key) * 1000


rows = []
for i in range(ITER):
    r = once(i)
    if r:
        rows.append(r)
    print(f"  run {i+1}: echo {rows[-1][0]:6.0f} ms   work {rows[-1][1]:6.0f} ms" if rows else "  timeout", flush=True)
    time.sleep(1)
if rows:
    e = [r[0] for r in rows]
    w = [r[1] for r in rows]
    print(f"\n{' '.join(EXTRA) or 'default':<12} echo  min/med/max = {min(e):.0f} / {statistics.median(e):.0f} / {max(e):.0f} ms")
    print(f"{'':<12} work  min/med/max = {min(w):.0f} / {statistics.median(w):.0f} / {max(w):.0f} ms")
