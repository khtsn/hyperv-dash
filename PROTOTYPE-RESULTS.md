# Original prototype measurements

On 2026-11-18 the prototype collected inventory from a local Windows 11 Hyper-V host and a remote Hyper-V Server host over WinRM.

| Debian 13 provisioning step | Observed time |
| --- | --- |
| First transfer of the 1.5 GB base image to the remote host | 305 s |
| VM creation with a cached image | 12 s locally, 19 s remotely |
| Guest IP visible in the dashboard after the request | 30 s locally, 70 s remotely |

The remote guest used a static address on an internal NAT switch. The local guest completed cloud-init, expanded its root disk to 12 GB, and accepted the configured login. A local Docker profile test verified Docker, Compose, timezone and login-user group membership. Both test guests were removed after verification.

The base-image conversion needed the sparse attribute cleared from the extracted raw file. Guest IP reporting needed a udev trigger after installing the Hyper-V KVP daemon.

These timings predate the authenticated dashboard. Current test coverage and the limits of hardware verification are recorded separately. [Acceptance record](ACCEPTANCE.md)
