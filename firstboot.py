#!/usr/bin/env python3
"""Publish the cloud-init outcome to the host using the Linux Hyper-V guest KVP pool."""
import fcntl
import ipaddress
import json
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

def result():
    try:
        run = subprocess.run(["cloud-init", "status", "--wait", "--format", "json"],
                             capture_output=True, timeout=840)
        data = json.loads(run.stdout)
        if run.returncode == 0 and data.get("status") == "done" and not data.get("errors"):
            return "done"
        # Do not send command output: it can contain profile data or credentials.
        stages = [name for name in ("init-local", "init", "modules-config", "modules-final")
                  if (data.get(name) or {}).get("errors")]
        return "failed:cloud-init exit %d; stage %s" % (run.returncode, ",".join(stages) or "unknown")
    except subprocess.TimeoutExpired:
        return "failed:cloud-init timed out"
    except (ValueError, OSError, AttributeError):
        return "failed:could not read cloud-init status"

def publish(key, message, directory=Path("/var/lib/hyperv")):
    directory.mkdir(mode=0o755, exist_ok=True)
    record = struct.Struct("512s2048s")
    with os.fdopen(os.open(directory / ".kvp_pool_1", os.O_RDWR | os.O_CREAT, 0o644), "r+b") as stream:
        fcntl.lockf(stream, fcntl.LOCK_EX)
        stream.seek(0)
        existing = stream.read()
        if len(existing) % record.size:
            raise ValueError("Invalid KVP record length")
        for index, (k, _) in enumerate(record.iter_unpack(existing)):
            if k.rstrip(b"\0") == key:
                stream.seek(index * record.size)
                break
        stream.write(record.pack(key,message.encode("ascii")))
        stream.flush()
        os.fsync(stream.fileno())

def enroll_tailscale():
    try:
        subprocess.run(["timeout", "--kill-after=5s", "240s", "/bin/sh", "/run/hvdash-tailscale.sh"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=250)
        for attempt in range(6):
            run = subprocess.run(["tailscale", "status", "--json"], capture_output=True, timeout=4)
            if run.returncode == 0:
                status = json.loads(run.stdout)
                if status.get("BackendState") == "Running" and (status.get("Self") or {}).get("Online"):
                    for addr in status.get("TailscaleIPs") or []:
                        return "tailscale:" + str(ipaddress.ip_address(addr))
            if attempt < 5:
                time.sleep(2)
        return "failed:tailscale not online"
    except (subprocess.SubprocessError, OSError, ValueError, AttributeError, TypeError):
        return "failed:tailscale enrollment failed"

def publish_serial(nonce, message, port="/dev/ttyS1"):
    # COM2 is a VM-specific host pipe. Its status line contains no guest data.
    fd = os.open(port, os.O_WRONLY | os.O_NONBLOCK | os.O_NOCTTY)
    try:
        os.write(fd, ("HVDASH:" + nonce + ":" + message + "\n").encode("ascii"))
    finally:
        os.close(fd)

if __name__ == "__main__":
    nonce = sys.argv[1]
    if not re.fullmatch(r"[0-9a-f-]{36}", nonce):
        sys.exit(1)
    status = result()
    if status == "done" and "--tailscale" in sys.argv[2:]:
        status = enroll_tailscale()
    try:
        publish_serial(nonce, status)
    except OSError:
        pass
    try:
        publish(("hvdash.boot." + nonce).encode(), status)
    except (OSError, ValueError):
        pass
    # Repeat a bounded number of times if the host is still attaching. This
    # also works when an apt error prevented installation of hyperv-daemons.
    for _ in range(15):
        try:
            publish_serial(nonce, status)
        except OSError:
            pass
        time.sleep(2)
