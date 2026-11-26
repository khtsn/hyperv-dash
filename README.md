# Hyper-V Dash

Hyper-V Dash is an authenticated HTTPS dashboard for monitoring Hyper-V hosts, managing virtual machines and provisioning Debian 13 or Windows 11 guests.

**Run:** On Windows, use Node.js 24 or later with `node:sqlite` (tested on Node 26), Windows PowerShell 5.1 and the Hyper-V management tools. OpenSSL is needed for the development certificate unless you supply your own PEM pair. No npm packages are required.

On a new PC, clone this repository and run the setup script **as the Windows identity that will run the dashboard**. It checks the prerequisites, asks for the first administrator password (14+ characters) and creates the state in `state\` inside the checkout. You can run it again at any time. It only does what is still missing.

```powershell
powershell -ExecutionPolicy Bypass -File .\ops\setup.ps1
node server.mjs
```

From an elevated PowerShell, add `-Install` to install missing prerequisites with winget and enable Hyper-V. Restart Windows when the script asks, then run it again. `-AdminName` changes the first account name from `fleet-admin`. `-DataDirectory` selects another state folder. Set `HVDASH_DATA` to that folder before each start. For a long-running deployment, prepare the directories and identity using [the service guide](OPERATIONS.md) instead.

Open **https://127.0.0.1:8722** and sign in. The bootstrap certificate is self-signed for localhost. Verify its fingerprint before trusting it. For a shared console, install a trusted certificate for its DNS name in `$env:HVDASH_DATA/tls/{key,cert}.pem`, set `HVDASH_BIND`, `HVDASH_PORT`, and `HVDASH_ORIGIN` to the listening interface, port and exact public HTTPS origin. Stop any old HTTP prototype on the same port before cutover. To use a different loopback port, set **both** `HVDASH_PORT` and `HVDASH_ORIGIN`.

To create a named user or change that user's password/role, set `HVDASH_ACCOUNT_PASSWORD` from a password prompt as shown in [the service guide](OPERATIONS.md#install-and-start), then run `node admin.mjs user NAME viewer|operator|admin`. Changing an account revokes its sessions. Viewers inspect inventory and jobs. Operators provision and control VM power. Administrators manage hosts, profiles, storage-affecting actions, interactive consoles, NAT and the audit log. Sign-in lasts seven days from login, including across browser restarts. Administrators can select **Change password** beside **Sign out**, enter their current password, and confirm a new password of 14 to 256 characters. This signs that account out on every device. Any saved copy of the old password must be updated separately.

**Host setup.** A fresh checkout starts with an empty fleet. Sign in as an administrator and select **Add host** on Fleet overview. First initialization imports the bundled profiles and settings, plus a local `hosts.json` if one exists. Each host must pass a connection test before it can be saved. For a workgroup connection, use WinRM HTTPS or an explicit TrustedHosts entry and a dedicated host account. The dashboard encrypts new credentials with Windows DPAPI for the service identity. [Least privilege and recovery](OPERATIONS.md)

**Using the dashboard**

- **Fleet overview** shows issues first, per-host last-seen times, live metrics and capacity. Counts and free capacity use current reporting hosts. Offline inventory is marked stale.
- **Monitoring** charts host and VM history over 1 hour, 24 hours, 7 days or 30 days. Select a network adapter or disk to inspect throughput and disk latency. Active alerts also appear on Fleet overview. Administrators can change disk and memory thresholds. Slack delivery is optional. [Monitoring and delivery setup](OPERATIONS.md#monitoring-and-alert-delivery)
- **Virtual machines** supports search, hardware details, power actions and checkpoints. Administrators can select a running VM and choose **Open graphical console** to see its Hyper-V display and use the keyboard and mouse inside the browser, including during Windows Setup. The toolbar offers **Send Ctrl+Alt+Delete**, full screen and disconnect. **Ctrl+Alt+Left** returns keyboard focus to the toolbar. The separate serial console requires COM1 and a guest serial terminal. Interactive consoles respect VM protection and exclusive job locks. Deletion requires confirmed ownership, the current VM ID, the exact name and recorded disk paths.
- **Provisioning** verifies the base image, reserves the selected resources and waits for the guest to finish setup. The Windows 11 catalog accepts an official installation ISO or a generalized VHDX. Debian 13 uses the official cloud image. See [image import, guest login and networking](PROVISIONING.md).
- **Networks & IPs** shows switches, retained addresses and host NAT mappings. **Jobs** and **Audit** show running, completed and interrupted work. Audit entries can be searched and exported as CSV. After an interrupted job, reconcile the host before retrying.
- Install an auto-starting Windows service and back up or restore the application state using the [operations guide](OPERATIONS.md). The application backup includes configuration and history; VM disk backup is a separate operation.

**Verification:**

```powershell
node --test tests/fleet-e2e.test.mjs tests/fleet.test.mjs tests/vm.test.mjs tests/monitoring.test.mjs provisioning.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tests/vm-delete-guards.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File check-provision.ps1
python -B firstboot_test.py
powershell -NoProfile -ExecutionPolicy Bypass -File ops/smoke.ps1
```

These checks isolate their state, simulate hosts, and exercise Windows DPAPI, HTTPS, named pipes, the service wrapper and backup/restore. For an explicitly authorized hardware acceptance run, `node tests/live-provision.mjs --create-and-delete-local-vm` uses a separate database and only local Hyper-V. It creates one uniquely named 2-vCPU, 2 GiB Debian guest on **Default Switch**, placing an 8 GiB dynamic disk on **D:**. It then powers off the guest and removes its recorded disks. The verified image caches remain for later provisions.

**Result:** See [acceptance results](ACCEPTANCE.md) and the [dashboard screenshot](shots/fleet-must.png) for tested paths and limitations. [Original prototype measurements](PROTOTYPE-RESULTS.md) predate the authenticated implementation.

**Next:** Phase 5 covers additional guest images, templates, bulk provisioning, backups, migration and API tokens. Deployment acceptance still includes the intended service identity, certificate, WinRM permissions, guest serial/KVP and remote performance counters. [Roadmap](FEATURES.md#16-suggested-build-order)
