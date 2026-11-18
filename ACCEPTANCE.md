# Hyper-V Fleet acceptance record

2026-11-19, Windows 11 management workstation, Node 26.13, Windows PowerShell 5.1. Scope: all 55 requirements marked **Must** in [FEATURES.md](FEATURES.md). Its MVP column describes the earlier prototype. This table identifies what ran against hardware and what was exercised with fixtures.

| Must IDs | Delivered | Evidence |
| --- | --- | --- |
| H1, H2, H3, H4, H5 | Host CRUD with editable labels and stable identity, WinRM connection diagnosis, reachability and last seen, OS/build/CPU/Hyper-V inventory, encrypted per-host credentials | Local host identity and inventory read successfully. Tests cover a disconnected host, a reachable peer, a changed machine identity and write-only DPAPI credentials. |
| M1, M2, M3, M4 | Host and VM stats, fleet totals, per-host vCPU, memory and VHD capacity | Local collector returned two fixed volumes, two virtual switches and twelve logical processors. Offline and allocation arithmetic tested with fixtures. |
| V1, V2, V3, V4, V5, V6, V7 | Fleet VM table with search, state/host/tag filtering and sorting, power controls, typed owned-disk deletion, VM details and offline hardware edits, browser serial console | Real test guest booted and was powered off and deleted; its Debian login prompt was read via the serial bridge. Editing, other power actions, console session isolation and deletion guards tested with fixtures. |
| P1, P2, P3, P4, P5, P6, P7, P8 | Provision form, Debian 13 cloud-init, image catalog and verified host copies, profiles, logged jobs and rollback, guest outcome, capacity/name/IP checks | Official SHA512 and host VHDX SHA256 verified. Verified host copy measured 1,547,698,176 bytes. Guest success reported; see live chronology below. Host + guest fixtures cover same-size corruption, failed first boot, cleanup and unconfirmed outcomes. |
| N1, N2, N3, N4, N5 | Switch and adapter inventory; DHCP or static IPv4; durable observed and reserved IPs; conflict probing; NAT mapping management | Actual guest used Default Switch and DHCP. Ledger restart, collision, static reservation, NAT conflict and removal confirmed with simulated hosts. Static placement requires a checkable network; unreachable targets and quiet devices can never prove an address globally unused. |
| S1, S2, S3 | Select a fixed drive, display free space, apply reserve margin, inspect and validate attached disks | Actual OS and seed VHDX on D:. Insufficient capacity, shared parent chains, outside paths and unexpected files covered in tests. |
| B1, B8 | Per-VM checkpoint list, create, restore and delete; backup and restore dashboard database and TLS material | Checkpoint identifiers, confirmation and protection tested with fake hosts. Snapshot/restore, corruption detection, retained ledger, session revocation and DPAPI decryptability verified in an isolated Windows operations test. |
| A1, A2, A3, A4, A5, A6, A7, A8, A9 | HTTPS, named accounts, server-enforced roles, credential vault, least-privilege deployment guide, destructive confirmations, VM protection, expiry/CSRF/exact origin | Browser sign-in, viewer/operator/admin E2E, credential write-only behavior, protection and disk list checks. Deployment identity and certificate trust are installation-specific. |
| O1, O2, O3, O4 | Durable jobs and logs with actor/timestamps, searchable/exportable audit, interrupted status, one active VM job | Concurrent operation rejected, interrupted console recovered on restart, job/audit/backup verified with test SQLite state. |
| U1, U2, U3 | Problems first, collapsed healthy hosts, timestamped refresh, actionable connection and operation errors | Chrome on localhost over HTTPS, navigation, details, narrow viewport and provision flow, [desktop screenshot](shots/fleet-must.png). |
| X1, X2, X3, X6, X7 | Installable Windows service, SQLite, independent background collectors with bounded calls, structured PowerShell inputs, fake and live provision checks | Compiled service wrapper started/stopped a disposable child. No SCM registration or workstation reboot. The documented real-VM test is explicit opt-in. |

## Live provision

- Created one disposable VM, `hvdash-qa-d4b2bf0c`, from the authenticated HTTPS API, with two vCPUs, 2 GiB RAM, and an 8 GiB dynamic disk. The run used a separate database containing only the local host.
- First boot stalled in cloud-init's early boot command. Read-only inspection found that the network init stage had started, with neither config nor final modules reached. Fixed the generated seed to start its systemd reporter without blocking early boot.
- Corrected the seed on **that same VM**, restored its OS disk from the verified base and booted again. The guest's cloud-init status file showed all stages finished without errors; the guest wrote its nonce-bound `done` record. COM1 returned a Debian login prompt. The host KVP channel made contact after a further reboot, and the outstanding provision job read the guest's success record.
- The final code explicitly reloads udev rules, schedules the KVP daemon and also listens on a separate COM2 first-boot channel. The COM2 framing and KVP status code paths were tested with fixtures. The manually recovered live run is not a benchmark of an unattended fresh installation.
- The API powered off and deleted the guest. Hyper-V inventory, the VM disk directory, and both OS and seed disk paths were verified absent. The verified reusable image caches were retained.

## Verification scope

The Node suite passed **16 tests**. Four Python guest-report tests passed. The PowerShell deletion-guard, checksum and operations smoke scripts passed. No other host was modified. Remote fleet rollout, Server Core version compatibility, a real checkpoint restore, real NAT mapping changes, and unattended Windows service startup after an OS reboot remain deployment acceptance checks. The implementation does not promise a two-minute cold provision when downloading or transferring a base image.

## Phase 4 monitoring and alerts

2026-11-19. The phase adds M5–M9 to the fleet and capacity views already delivered for M3, M4 and U1.

| Requirement | Verified outcome |
| --- | --- |
| M5, historical charts | Chrome displayed host and VM history across all four windows on an isolated HTTPS instance. SQLite tests covered legacy samples, a removed VM, missing intervals, genuine zeroes and 30-day retention using dated fixtures. |
| M6–M7, device counters | A read-only local Hyper-V collection returned receive rates for one host network interface and transfer latency for two fixed volumes. The host had no registered VMs. The PowerShell fixture exercised VM NIC GUID matching, VHD path matching, byte rates, invalid counter status and conversion from seconds to milliseconds. Chrome rendered device charts and the latest readings. |
| M8, alert lifecycle | Simulated disk and memory pressure, host outage, unexpected VM stop, intentional shutdown and recovery. Repeated polls preserved a single open incident. Browser verification changed the disk threshold and saw the resulting volume alert on Fleet overview. |
| M9, delivery | A simulated Slack sender verified notification payloads, retries and ordering of opening and recovery. An actual Slack channel and remote Server Core guest counters remain deployment checks. |

All 21 Node tests and four Python tests passed, along with the PowerShell deletion, checksum and service backup/restore smoke checks. The screenshot uses simulated data. [Monitoring screenshot](shots/monitoring.png)
