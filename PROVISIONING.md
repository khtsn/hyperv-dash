# Debian provisioning

Select Debian 13, a switch and a fixed volume in the new VM form. Disks are stored in `<volume>:\hvdash\<vm-name>`. The host must have available startup RAM plus 512 MiB. Provisioning reserves the full requested virtual disk size plus the 64 MiB seed in its preflight calculation, and requires at least the larger of 10 GiB and 10% of the volume to remain free. Only one create job per registered host may run at once.

The catalogue shows the official Debian download and its SHA512 when reachable. On first use, the management machine downloads the archive, verifies its upstream SHA512, builds a dynamic VHDX, and records its SHA256, byte length and archive version under `cache/catalog-v1/debian-13`. An older prototype VHDX without verified provenance requires this one-time rebuild. Provisioning checks the SHA256 again at use. On a mismatch at the host it copies to a temporary file, verifies the complete file on the host and only then publishes it under the host's default VHD directory. Allow extra time and space on the management machine and host for that first transfer. The catalogue's host copy list is refreshed asynchronously; open it again after initial discovery.

Static addresses are checked against the persistent ledger, VM adapter addresses, the host interface, and live ping/neighbour evidence. External switches conservatively share a single fleet address namespace. Private and internal switch namespaces use host and switch identity. Static provisioning needs a management interface on the chosen subnet to check it; DHCP also works on an appropriate guest network. As with any network probe, silent or offline devices outside this inventory and untracked DHCP leases may be invisible; assign static addresses from a range excluded from DHCP.

The cloud-init seed config includes the requested login and selected software profile. Specifying a password puts that password on the attached seed disk; choosing an SSH public key avoids this. Job and audit records do not store the seed, plaintext login, or profile command output. Administrators can save packages, files, timezone and commands in profiles, which are trusted code run as root inside newly provisioned guests. Keep secrets out of saved profiles.

During boot, cloud-init queues an independent systemd service with --no-block. It waits for cloud-init and publishes a sanitized exit outcome and failing module names through both a dedicated COM2 status port and Hyper-V guest KVP. The host waits up to 15 minutes for a report matching that VM and provisioning ID. KVP works independently if COM2 is unavailable. COM2 works when a package or network failure prevents the guest from starting the KVP daemon. Without a report on either transport, the host records a timeout. Failed builds attempt cleanup of the just-created VM and its two owned disks. If remote execution or cleanup cannot be confirmed, the reserved address remains in the ledger for administrator reconciliation.

Verification from this folder:

```powershell
node --test provisioning.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File check-provision.ps1
python -B firstboot_test.py
```

These checks use fake hosts, temporary disk-byte fixtures and a synthetic KVP file. Run an expendable real guest in a lab to validate image transfer, serial access and cloud-init reporting against a particular Windows Server version and guest network. The guest reporter uses the [Hyper-V data exchange service](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange).
