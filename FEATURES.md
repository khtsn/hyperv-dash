# Hyper-V Admin UI: feature requirements

As of 2026-11-18. Companion to the `hyperv-dash` MVP in this folder.

## 1. Purpose and scope

The admin UI is one web page for running a small fleet of Hyper-V hosts that
have no desktop: see their health, control their VMs, and create new Linux VMs
in under two minutes.

- **Fleet:** 3 to about 20 standalone hosts running Windows Server Core or
  Hyper-V Server 2019 and later, reached over PowerShell remoting (WinRM).
- **Users:** a small team of administrators. Not end users or tenants.
- **Replaces:** logging into each host to check load, running Hyper-V
  PowerShell commands by hand, and walking through an OS installer for every
  new VM.

## 2. How to read the priorities

| Priority | Meaning |
| --- | --- |
| **Must** | The product is not usable or not safe for real servers without it. |
| **Should** | Expected by anyone who has used Windows Admin Center, Proxmox or vCenter; add soon after the Musts. |
| **Could** | Useful, but only worth building once there is a concrete need. |

The **MVP** column says what the prototype does today:
**Done** (verified), **Partial** (works with limits noted), **No**.

## 3. Where the MVP stands

Verified on two hosts (one local Windows 11 Hyper-V, one remote Hyper-V Server
over WinRM):

- Host cards with CPU, memory, disks, uptime and the VM list, refreshed every 10 s.
- VM start, shut down, power off, and delete (delete only for VMs it created).
- Debian 13 provisioning from the official cloud image: 12 to 19 s to create,
  30 to 70 s until the VM reports its IP. First use per host copies a 1.5 GB
  base image (305 s over WinRM).
- Static IP, gateway and DNS at provision time, plus a free-IP pick for
  internal (NAT) switches.
- Software profiles (packages, first-boot commands, scripts, timezone) with an
  editor in the UI and a default profile.

Not there at all: login, HTTPS, history, alerts, audit log, editing a VM after
creation, checkpoints, backups, console access, any OS other than Debian 13.

## 4. Host management

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| H1 | Add, edit and remove hosts from the UI (name, address, transport, credential reference) | Must | No: hand-edited `hosts.json` |
| H2 | Connection test when adding a host, with a plain reason on failure (DNS, port, auth, TrustedHosts, Hyper-V role missing) | Must | No |
| H3 | Per-host reachability state (online, degraded, unreachable) with last-seen time, so one dead host never blocks the page | Must | Partial: per-host errors, no last-seen |
| H4 | Host inventory: OS and build, CPU model, cores, RAM, Hyper-V version, uptime, last boot | Must | Partial: OS, cores, RAM, uptime |
| H5 | Per-host credentials stored encrypted, never in config files or logs | Must | Partial: environment variables, one pair for all hosts |
| H6 | HTTPS WinRM (5986) or SSH transport option, per host | Should | No: HTTP WinRM only |
| H7 | Groups or tags (site, role) with filter and search | Should | No |
| H8 | Host maintenance mode: block new VMs, show a banner | Should | No |
| H9 | Host actions: restart, shut down, with confirmation that lists the running VMs | Should | No |
| H10 | Pending Windows updates and reboot-required indicator | Should | No |
| H11 | Host prerequisites check and one-click fix (WinRM limits, default VM paths, base image present) | Should | No |
| H12 | Install Windows updates from the UI | Could | No |
| H13 | Hyper-V role and feature management (for example enable nested virtualization) | Could | No |
| H14 | Failover cluster awareness (cluster nodes, CSV, clustered roles) | Could | No |

## 5. Monitoring and stats

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| M1 | Live host metrics: CPU %, memory used/total, disk free per volume | Must | Done |
| M2 | Live VM metrics: state, CPU %, assigned memory, uptime, IP addresses | Must | Done |
| M3 | Fleet overview: totals for hosts, VMs running/stopped, free CPU, RAM and disk across hosts | Must | No |
| M4 | Capacity view per host: allocated versus physical vCPU, RAM and disk, to decide where a new VM fits | Must | No |
| M5 | History: at least 30 days of host and VM metrics with charts (1 h, 24 h, 7 d, 30 d) | Should | No |
| M6 | Network throughput per host NIC and per VM adapter | Should | No |
| M7 | Disk I/O and latency per host volume and per VM disk | Should | No |
| M8 | Alerts with thresholds (disk below 15 % free, memory above 90 %, host unreachable, VM stopped unexpectedly) | Should | No |
| M9 | Alert delivery to chat or email (Telegram, Slack, SMTP) | Should | No |
| M10 | VM health: heartbeat and integration-service status, flagged when the guest stops responding | Should | No |
| M11 | Hyper-V event log view (VMMS and worker errors), filtered per host or VM | Should | No |
| M12 | Hardware health: disk SMART, temperatures, RAID state where the host exposes them | Could | No |
| M13 | Prometheus metrics endpoint for use with an existing Grafana | Could | No |
| M14 | Guest-level metrics (disk usage inside the VM, load) through an agent or SSH | Could | No |

## 6. VM lifecycle

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| V1 | List all VMs across hosts in one table with search, sort and filter by host, state and tag | Must | Partial: per-host tables only |
| V2 | Start, graceful shut down, power off | Must | Done |
| V3 | Restart, pause, resume, save state | Must | No |
| V4 | Delete VM and its disks, with typed-name confirmation | Must | Partial: plain confirm; only VMs created by the tool |
| V5 | VM detail page: hardware, disks, adapters, checkpoints, notes, creation time and creator | Must | No |
| V6 | Edit VM: vCPU count, memory (static or dynamic with min/max), notes, automatic start and stop action | Must | No |
| V7 | Console access to a VM that has no network (VMConnect-style console in the browser, or a serial console) | Must | No |
| V8 | Adopt existing VMs: full control of VMs the tool did not create, with a clear marker and stricter delete rules | Should | Partial: power actions only |
| V9 | Bulk actions on selected VMs (start, stop, tag) | Should | No |
| V10 | Rename VM; tags and owner fields | Should | No |
| V11 | Clone a VM; convert a VM into a reusable template | Should | No |
| V12 | Attach and eject ISO; change boot order; Secure Boot settings | Should | No |
| V13 | Export and import a VM | Should | No |
| V14 | Move a VM between hosts (shared-nothing live migration, or offline export/import) | Should | No |
| V15 | Web SSH terminal to Linux guests | Could | No |
| V16 | Scheduled power actions (stop at night, start in the morning) | Could | No |
| V17 | GPU or device passthrough (DDA) settings | Could | No |

## 7. Provisioning

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| P1 | One-form VM creation: host, name, vCPU, memory, disk, switch, login user, password or SSH key | Must | Done |
| P2 | Unattended OS install from a cloud image plus cloud-init, no installer interaction | Must | Done: Debian 13 |
| P3 | Image library: list of base images per OS with version, size, checksum and which hosts have a copy | Must | Partial: one hard-coded image, size check only |
| P4 | Checksum verification of images on download and after copy to a host | Must | Partial: SHA512 on download, size only on host |
| P5 | Software profiles: packages, first-boot commands, files, timezone; editable in the UI; one default | Must | Done |
| P6 | Provisioning job with live log, clear failure reason and automatic cleanup of a half-built VM | Must | Done |
| P7 | First-boot result reported back: cloud-init finished or failed, with the error, not just "VM started" | Must | Partial: IP appears on success; failures are silent |
| P8 | Input validation before anything is created: name unique, host has enough free RAM and disk, IP not in use | Must | Partial: name and format checks only |
| P9 | SSH key library: stored public keys, selectable per VM, several keys per VM | Should | No: one pasted key |
| P10 | More operating systems: Ubuntu LTS, other Debian releases, Rocky/Alma | Should | No |
| P11 | Windows Server guests from a sysprepped image with an unattend file | Should | No |
| P12 | Sizing presets (small, medium, large) and saved VM templates combining size, profile and network | Should | No |
| P13 | Create several VMs at once (count plus name pattern, addresses assigned in sequence) | Should | No |
| P14 | Fast image distribution to hosts: host pulls over HTTPS or SMB instead of WinRM copy; resumable | Should | No: WinRM copy, 305 s for 1.5 GB |
| P15 | Image refresh: detect a newer upstream image, rebuild, and roll it out to hosts | Should | No |
| P16 | Profile validation: check that package names exist in the target release before saving | Should | Partial: syntax check only |
| P17 | Secrets in profiles (tokens, keys) stored encrypted and injected at provision time | Should | No |
| P18 | Remove the seed disk after first boot so the plain-text password does not stay attached | Should | No |
| P19 | Auto-placement: suggest the host with the most free capacity | Could | No |
| P20 | Golden images: bake a profile into a new base image for faster, offline provisioning | Could | No |
| P21 | Installer-ISO path with preseed/kickstart for custom disk layouts (LVM, encryption) | Could | No |
| P22 | Post-provision hooks: call a webhook or run an Ansible playbook when the VM is ready | Could | No |

## 8. Networking and IP management

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| N1 | List virtual switches per host with type (external, internal, private) and attached adapters | Must | Partial: names only |
| N2 | Static IP, gateway and DNS at provision time, or DHCP | Must | Done |
| N3 | IP address ledger per network: which address belongs to which VM, kept across restarts, including powered-off VMs | Must | Partial: live detection only; forgets on restart; misses powered-off VMs |
| N4 | Free-IP suggestion from that ledger, with a conflict check before use | Must | Partial: internal switches only |
| N5 | NAT port forwarding management (list, add, remove mappings from host port to VM port) | Must | No |
| N6 | Create, edit and remove virtual switches and NAT networks | Should | No |
| N7 | VLAN ID per VM adapter | Should | No |
| N8 | Add, remove and reconfigure VM network adapters after creation; fixed MAC address option | Should | No |
| N9 | Reserved ranges per network (addresses the tool must never hand out) | Should | No |
| N10 | DHCP service for internal networks, managed by the tool | Could | No |
| N11 | DNS record creation for new VMs (internal zone or an external provider) | Could | No |
| N12 | Bandwidth limits and port ACLs per adapter | Could | No |
| N13 | IPv6 addressing | Could | No |

## 9. Storage

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| S1 | Choose the volume or path for a new VM's disks; show free space next to each choice | Must | No: host default path |
| S2 | Refuse to provision when the volume would drop below a safety margin | Must | No |
| S3 | Per-VM disk list: path, type (dynamic, fixed, differencing), provisioned size, size on disk | Must | No |
| S4 | Add a data disk; grow an existing disk | Should | Partial: OS disk size set at creation only |
| S5 | Orphan finder: VHDX files and folders that no VM references | Should | No |
| S6 | Thin-provisioning overview: total provisioned versus physical capacity per volume | Should | No |
| S7 | Compact dynamic disks; convert between dynamic and fixed | Could | No |
| S8 | Differencing-disk provisioning (linked clones) to save space and time | Could | No |
| S9 | Storage QoS (IOPS limits) per disk | Could | No |

## 10. Backup, checkpoints and recovery

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| B1 | Create, list, apply and delete checkpoints, with age and size shown | Must | No |
| B2 | Warning on old or large checkpoint chains (they slow VMs and fill disks) | Should | No |
| B3 | Scheduled VM export to another volume or network share, with retention count | Should | No |
| B4 | Restore a VM from an export, to the same or another host | Should | No |
| B5 | Backup status per VM (last success, age, size) and alert on failure | Should | No |
| B6 | Hyper-V Replica setup and status between two hosts | Could | No |
| B7 | Integration with an existing backup product instead of built-in exports | Could | No |
| B8 | Backup of the tool's own data (hosts, profiles, IP ledger, audit log) | Must | No |

## 11. Access and security

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| A1 | Login required for every page and API call | Must | No: open on 127.0.0.1 |
| A2 | HTTPS for the UI | Must | No |
| A3 | Named user accounts (no shared login), with strong password rules or single sign-on | Must | No |
| A4 | Roles: read-only, operator (power actions, provision), admin (hosts, credentials, delete) | Must | No |
| A5 | Host credentials encrypted at rest; never shown again after entry; never written to logs | Must | Partial: kept in memory only |
| A6 | Least-privilege host account (Hyper-V Administrators plus what remoting needs), documented | Must | No: built-in Administrator |
| A7 | Confirmation for destructive actions, stating exactly what will be removed | Must | Partial: plain confirm dialogs |
| A8 | Protection flag on critical VMs: cannot be stopped or deleted without an admin lifting it | Must | Partial: only tool-created VMs can be deleted |
| A9 | Session timeout, CSRF protection, strict same-origin API | Must | Partial: cross-origin requests refused |
| A10 | Two-factor authentication | Should | No |
| A11 | Single sign-on (OIDC, for example Entra ID or Google) | Should | No |
| A12 | VM passwords never stored; generated passwords shown once | Should | Partial: sits on the VM's seed disk |
| A13 | Per-group permissions (a user may manage only some hosts or VMs) | Could | No |
| A14 | IP allow-list or VPN-only access to the UI | Could | No |

## 12. Operations: jobs, audit, API

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| O1 | Job list: every long action with status, start and end time, who started it, and its log | Must | Partial: in memory, lost on restart |
| O2 | Audit log: who did what to which host or VM, and when; searchable; exportable | Must | No |
| O3 | Jobs survive a server restart or are clearly marked interrupted | Must | No |
| O4 | One operation per VM at a time (locking), so two admins cannot collide | Must | No |
| O5 | Recent-activity feed on the dashboard | Should | No |
| O6 | Notifications when a job finishes or fails | Should | No |
| O7 | Documented REST API with tokens, covering everything the UI does | Should | Partial: undocumented, no auth |
| O8 | Retry and cancel for jobs | Should | No |
| O9 | Command-line client or Terraform provider on top of the API | Could | No |
| O10 | Webhooks on events (VM created, host down) | Could | No |

## 13. UI and usability

| ID | Feature | Priority | MVP |
| --- | --- | --- | --- |
| U1 | Dashboard that answers "is anything wrong?" in one look: problems first, healthy hosts collapsed | Must | Partial: all hosts shown equally |
| U2 | Live updates without manual refresh, with a visible "last updated" time per host | Must | Partial: 10 s polling, no timestamp |
| U3 | Clear, specific error messages with the failing step and a suggested fix | Must | Partial: raw PowerShell errors |
| U4 | Works on a phone for checking status and doing power actions | Should | Partial: layout adapts, untested |
| U5 | Global search across hosts, VMs and IPs | Should | No |
| U6 | Copy buttons for IP, SSH command and generated password | Should | No |
| U7 | Light and dark themes | Should | Done: follows the system setting |
| U8 | Keyboard shortcuts and deep links to any host or VM | Could | No |
| U9 | English and Vietnamese interface | Could | No |

## 14. Architecture and non-functional requirements

| ID | Requirement | Priority | MVP |
| --- | --- | --- | --- |
| X1 | Runs as a service on one management machine or VM; survives reboot; nothing to install on the Hyper-V hosts beyond enabled remoting | Must | Partial: started by hand |
| X2 | Persistent store (SQLite is enough) for hosts, jobs, audit log, IP ledger, profiles and metric history | Must | No: JSON files and memory |
| X3 | A slow or dead host never delays other hosts; every remote call has a timeout | Must | Done |
| X4 | Persistent remoting sessions per host instead of a new PowerShell process per request | Should | No: about 1 to 3 s per call |
| X5 | Dashboard loads in under 2 s with 20 hosts and 200 VMs, served from a cache refreshed in the background | Should | No |
| X6 | All user input passed to hosts as data, never built into command text | Must | Done |
| X7 | Automated tests against a fake host, plus an end-to-end provision test | Must | Partial: one smoke script |
| X8 | Versioned releases, upgrade path and a config/database backup command | Should | No |
| X9 | Structured logs for the tool itself | Should | No |
| X10 | Optional agent on each host that pushes metrics, for sub-10 s resolution or hosts behind NAT | Could | No |

## 15. Out of scope

- Multi-tenant self-service with quotas and billing.
- Other hypervisors (VMware, Proxmox, KVM).
- Software-defined networking and Storage Spaces Direct design.
- Managing what runs inside guests after first boot (patching, configuration
  management); hand that to Ansible or similar.
- Replacing a dedicated backup product for anything beyond simple exports.

## 16. Suggested build order

The acceptance record covers phases 1–4. Phase 4 added M5–M9 on 2026-11-19. Phase 5 is next. The MVP column above preserves the original prototype baseline. [Acceptance record](ACCEPTANCE.md#phase-4-monitoring-and-alerts)

1. **Safe to run on real servers.** Login, HTTPS, roles, encrypted per-host
   credentials, audit log, persistent store, run as a service.
   (A1 to A9, O1 to O4, X1, X2, H1, H2)
2. **Trustworthy provisioning.** Image library with checksums, capacity and
   IP checks before creating, first-boot result reporting, IP ledger, storage
   placement, NAT port forwards. (P3, P4, P7, P8, N3 to N5, S1 to S3)
3. **Complete VM control.** Fleet-wide VM table, detail page, edit hardware,
   restart and pause, checkpoints, console access. (V1, V3, V5 to V7, B1)
4. **Know before it breaks.** Fleet overview, capacity view, history charts,
   alerts and delivery. (M3 to M9, U1)
5. **Scale and comfort.** More OS images, templates and bulk create, faster
   image distribution, backups and exports, migration between hosts, API
   tokens. (P9 to P15, B3 to B5, V11, V14, O7)

## 17. Open questions

- **Where does it run?** One always-on management VM, or an admin's
  workstation as today? This decides X1, A2 and how hosts are reached.
- **Who logs in?** Local accounts are enough for 2 or 3 admins; single
  sign-on is worth it only if an identity provider already exists.
- **Are hosts domain-joined?** Workgroup hosts need TrustedHosts or HTTPS
  WinRM with certificates; a domain gives Kerberos for free.
- **Which guest systems matter next?** Ubuntu is a small step from Debian;
  Windows guests are a separate, larger piece of work.
- **Is console access a hard requirement?** It is the hardest Must (V7):
  Hyper-V has no built-in web console, so it needs an RDP gateway component
  or a serial-console workaround.
- **Backups: built in or external?** If a backup product is already in use,
  B3 to B5 shrink to showing its status.
- **Build or adopt?** Windows Admin Center already covers much of sections 4
  to 6 and 10. The case for a custom tool rests on sections 7 and 8
  (fast templated Linux provisioning and IP management), which it does poorly.
