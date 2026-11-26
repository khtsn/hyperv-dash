# Guest provisioning

## Windows 11

Use Windows 11 Pro, Enterprise or Education x64 installation media. Download the English x64 multi-edition ISO and compare its SHA-256 with the value shown for **English 64-bit** on Microsoft's download page. From an elevated Windows PowerShell in the checkout, build the local image with the command below. The default image name is `Windows 11 Pro`. Use `-ImageName` to select another supported edition present on the ISO. Use a Windows license appropriate to each deployment. [Microsoft Windows 11 download](https://www.microsoft.com/en-us/software-download/windows11)

```powershell
.\ops\import-windows-image.ps1 -IsoPath 'D:\media\Windows11.iso' -Sha256 'REPLACE_WITH_MICROSOFT_SHA256'
```

Alternatively, import a detached, standalone, unencrypted Generation 2 VHDX prepared with `Sysprep /generalize /oobe /shutdown`. The template needs an EFI partition, one Windows partition and an unused local account name for provisioning. Remove custom Panther answer files from the reference image before import. Use the VHDX hash with `-Sha256` when available. [Microsoft Sysprep guidance](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/sysprep--generalize--a-windows-installation?view=windows-11)

```powershell
.\ops\import-windows-image.ps1 -Path 'D:\media\windows-11-generalized.vhdx'
```

Refresh **Images & profiles**, then select **Microsoft Windows 11** in **Provision a VM**. The minimum is two vCPUs, 4 GiB RAM and a 64 GiB disk, or the imported virtual disk size when larger. Choose a computer name of up to 15 characters and a new local administrator name. The host enables Secure Boot and a virtual TPM with a local key protector. Retain the protector when planning migration or recovery. [Windows 11 VM requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)

Windows Setup uses a random temporary credential on the cloned disk. The host waits for Windows Setup to finish, signs into the guest over PowerShell Direct, configures the selected network and replaces the temporary password. A final password is optional with SSH keys. Providing keys installs Windows OpenSSH Server and adds the keys to the administrators' authorized-keys file. Providing a Tailscale key installs the signed x64 client and verifies that its unattended session is online. Both optional installs need suitable network access. Debian package profiles apply only to Debian. [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct) · [Windows OpenSSH keys](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)

The image catalog lives under `cache/catalog-v1/windows-11` on the management machine. The active manifest names a SHA-256-addressed VHDX. Importing a replacement switches the manifest after verification. Existing guests keep their independent disks.

To test a published template on a local Hyper-V workstation, run `node tests/live-provision.mjs --create-and-delete-local-vm --windows-11`. This creates a temporary guest on **D:** using **Default Switch**, verifies the final password, Secure Boot and vTPM, then deletes the test VM through the dashboard.

## Debian 13

Select Debian 13, a switch and a fixed volume in the new VM form. Disks are stored in `<volume>:\hvdash\<vm-name>`. The host must have available startup RAM plus 512 MiB. Provisioning reserves the full requested virtual disk size plus the 64 MiB seed in its preflight calculation, and requires at least the larger of 10 GiB and 10% of the volume to remain free. Only one create job per registered host may run at once.

The catalogue shows the official Debian download and its SHA512 when reachable. On first use, the management machine downloads the archive, verifies its upstream SHA512, builds a dynamic VHDX, and records its SHA256, byte length and archive version under `cache/catalog-v1/debian-13`. An older prototype VHDX without verified provenance requires this one-time rebuild. Provisioning checks the SHA256 again at use. On a mismatch at the host it copies to a temporary file, verifies the complete file on the host and only then publishes it under the host's default VHD directory. Allow extra time and space on the management machine and host for that first transfer. The catalogue's host copy list is refreshed asynchronously; open it again after initial discovery.

Static addresses are checked against the persistent ledger, VM adapter addresses, the host interface, and live ping/neighbour evidence. External switches conservatively share a single fleet address namespace. Private and internal switch namespaces use host and switch identity. Static provisioning needs a management interface on the chosen subnet to check it; DHCP also works on an appropriate guest network. As with any network probe, silent or offline devices outside this inventory and untracked DHCP leases may be invisible; assign static addresses from a range excluded from DHCP.

The cloud-init seed config includes the requested login and selected software profile. Specifying a password puts that password on the attached seed disk; choosing an SSH public key avoids this. Job and audit records do not store the seed, plaintext login, or profile command output. Administrators can save packages, files, timezone and commands in profiles, which are trusted code run as root inside newly provisioned guests. Keep secrets out of saved profiles.

Paste one or more OpenSSH public keys under **Guest login**, one complete key per line. Each key grants access to the selected Linux user. A guest password is optional when at least one key is supplied.

To connect a new guest to your tailnet, enter a Tailscale auth key in **Provision a VM → Tailscale**. Use a one-off, pre-approved key if the tailnet requires device approval. The guest needs outbound access to Debian, Tailscale's package repository and its control service. Provisioning reserves an extra 64 MiB for a temporary credential disk. The host restricts access to the disk and removes it after the guest reports a running, online Tailscale client with an assigned IP. The IP appears in the job log. The key is kept out of profiles, cloud-init user-data and the job database. If a host disconnects before cleanup, reconcile the VM's `enrollment.vhdx` and revoke any unused key. Existing tailnet access policies govern which peers and services the guest can reach. [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys) · [Official Debian packages](https://pkgs.tailscale.com/stable/#debian-trixie)

First-time image builds share the management machine's catalog lock. After validation, transfers to different host libraries proceed independently. Jobs targeting the same host library wait and report progress until the first job finishes copying its verified base into the new VM. The ordinary first-boot wait is 15 minutes. Tailscale enrollment extends that wait to 20 minutes.

During boot, cloud-init queues an independent systemd service with --no-block. It waits for cloud-init and publishes a sanitized exit outcome and failing module names through both a dedicated COM2 status port and Hyper-V guest KVP. Each report must match the VM and provisioning ID. KVP works independently if COM2 is unavailable. COM2 works when a package or network failure prevents the guest from starting the KVP daemon. Without a report on either transport, the host records a timeout. Failed builds attempt cleanup of the just-created VM and its owned disks. If remote execution or cleanup cannot be confirmed, the reserved address remains in the ledger for administrator reconciliation.

Verification from this folder:

```powershell
node --test provisioning.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File check-provision.ps1
python -B firstboot_test.py
```

These checks use fake hosts, temporary disk-byte fixtures and a synthetic KVP file. Run an expendable real guest in a lab to validate image transfer, serial access and cloud-init reporting against a particular Windows Server version and guest network. The guest reporter uses the [Hyper-V data exchange service](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange).
