"""Test the guest completion report without booting a VM or touching a KVP device."""
import os
import json
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

if os.name == "nt":
    # The registered file lock is a Linux interface; model it for the fixture.
    with patch.dict("sys.modules", {"fcntl": MagicMock()}):
        import firstboot
else:
    import firstboot


class GuestReport(unittest.TestCase):
    def test_tailscale_requires_connected_machine_and_address(self):
        def status(state, online, ips):
            data = dict(BackendState=state, Self=dict(Online=online), TailscaleIPs=ips)
            return subprocess.CompletedProcess([], 0, json.dumps(data).encode())
        for sample in (status("NeedsMachineAuth", True, ["100.64.1.3"]),
                       status("Running", False, ["100.64.1.3"]), status("Running", True, [])):
            with patch.object(subprocess, "run", return_value=sample), patch.object(firstboot.time, "sleep"):
                self.assertEqual(firstboot.enroll_tailscale(), "failed:tailscale not online")
        with patch.object(subprocess, "run", return_value=status("Running", True, ["100.64.1.3"])):
            self.assertEqual(firstboot.enroll_tailscale(), "tailscale:100.64.1.3")
        with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "secret", stderr=b"private")):
            self.assertEqual(firstboot.enroll_tailscale(), "failed:tailscale enrollment failed")

    def test_failure_is_sanitized(self):
        run = subprocess.CompletedProcess([], 2, b'{"status":"error","modules-final":{"errors":["secret text"]}}')
        with patch.object(subprocess, "run", return_value=run):
            self.assertEqual(firstboot.result(), "failed:cloud-init exit 2; stage modules-final")

    def test_success_and_timeout(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b'{"status":"done","errors":[]}')):
            self.assertEqual(firstboot.result(), "done")
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("cloud-init", 840)):
            self.assertEqual(firstboot.result(), "failed:cloud-init timed out")

    def test_serial_report_is_a_bounded_per_vm_frame(self):
        with patch.object(os, "O_NOCTTY", 0, create=True), patch.object(os, "O_NONBLOCK", 0, create=True), \
             patch.object(os,"open",return_value=7) as opened, patch.object(os,"write") as wrote, patch.object(os,"close") as closed:
            firstboot.publish_serial("test-id","failed:cloud-init timed out")
            self.assertEqual(opened.call_args.args[0],"/dev/ttyS1")
            wrote.assert_called_once_with(7,b"HVDASH:test-id:failed:cloud-init timed out\n")
            closed.assert_called_once_with(7)

    def test_pool_updates_one_key_without_corrupting_others(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp)
            firstboot.publish(b"existing", "marker", directory)
            firstboot.publish(b"hvdash.boot.test", "waiting", directory)
            firstboot.publish(b"hvdash.boot.test", "done", directory)
            records=[(k.rstrip(b"\0"),v.rstrip(b"\0")) for k,v in struct.iter_unpack("512s2048s",(directory/".kvp_pool_1").read_bytes())]
            self.assertEqual(records, [(b"existing",b"marker"),(b"hvdash.boot.test",b"done")])


if __name__=="__main__":
    unittest.main()
