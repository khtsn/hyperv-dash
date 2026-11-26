# Running Hyper-V Dash as a Windows service

Use one always-on Windows management machine with Windows PowerShell 5.1, Node.js with `node:sqlite`, the Hyper-V management tools, and .NET Framework 4.x. The installer compiles a small service executable using the Framework compiler included on the management machine. Hyper-V hosts need WinRM configuration and the role's management modules. No dashboard service is installed on the hosts.

## Accounts and permissions

Use a dedicated domain or local user to run the **HyperVDash** Windows service. Grant it **Log on as a service** on the management machine and allow its Windows user profile to load. Keep this identity stable. The vault protects host passwords using Windows DPAPI CurrentUser, which requires the same Windows identity and its DPAPI profile to decrypt them. Use separate named dashboard accounts for people. The service uses its own identity for integrated WinRM connections or a host's saved credential for that connection. [Microsoft DPAPI documentation](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope?view=net-11.0)

On each managed host, grant the selected host account these rights for the features its operators will use:

| Function | Rights and verification |
| --- | --- |
| Connect and inventory | Permit network logon, grant **Execute** on the configured WinRM PowerShell endpoint, and allow the connection through the firewall from the management machine. The default endpoint may require an explicit ACL entry for a non-administrator. Test `New-PSSession -ComputerName HOST` with the actual host credential, then test read access to the OS, processor, volume and adapter inventory. |
| Operate VMs | Add the host account to the host's **Hyper-V Administrators** group. Verify `Get-VM`, `Get-VMHost`, `Get-VMSwitch` and access to its assigned VMs. This group confers powerful host-wide VM control. |
| Store images and VM files | Grant Modify on the selected VM data directories and image cache. Hyper-V's VM worker and VMMS need their normal VHD permissions. Provisioning on the management machine requires rights to build the base VHDX; staging the seed disk on each host requires VHD mount, partition and format rights on the new virtual disk. These storage operations can require local administrative privileges even if VM power operations work. |
| NAT and serial console | Grant the particular networking/provider operations and access to the VM's serial named pipe to the operating account. Verify the NAT list and the VM detail view before attempting writes. Windows network administration can require additional host-specific elevation. |
| Graphical VM console | The dashboard administrator connects to the running VM's Hyper-V display, keyboard and synthetic mouse through the host's virtualization WMI provider. Local hosts use the workstation identity. Remote hosts use the registered WinRM connection. The host account needs access to those devices. The console works before guest sign-in and uses the existing dashboard HTTPS listener. Frames and input stay out of job and audit logs. Disconnect or close VM details when finished. |

Use a narrowly scoped, dedicated operator for actions that require elevated storage or NAT privileges. Grant management access on the relevant machines only. For domain hosts use Kerberos and hostnames. Workgroup hosts require an explicitly trusted management path, such as certificate-validated HTTPS WinRM or an exact host entry in TrustedHosts for the HTTP WinRM deployment. Endpoint ACLs and group membership are separate. [Microsoft Hyper-V remote management guide](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/remotely-manage-hyper-v-hosts) · [PowerShell remoting security](https://learn.microsoft.com/powershell/scripting/security/remoting/winrm-security?view=powershell-7.6)

## Install and start

1. Copy the reviewed application, its profiles and the `ops` directory into a dedicated administrator-controlled release directory, for example `C:\Program Files\HyperVDash`. The service account needs read/execute access to the code and the Node executable. Use the existing `hosts.json`, `settings.json` and `profiles` that should seed the first database. Do not copy an old plaintext credential file. Use an editor that preserves UTF-8.
2. Open an elevated Windows PowerShell in that release directory. Substitute the real account name. `Prepare` creates three **new** directories with restrictive NTFS ACLs for that identity, Administrators and SYSTEM.

   ```powershell
   $svcUser = 'CONTOSO\hvdash-svc'
   .\ops\service.ps1 -Action Prepare -Account $svcUser
   $env:HVDASH_DATA = 'C:\ProgramData\HyperVDash\state'
   ```

3. Install a certificate for the management DNS name at `$env:HVDASH_DATA\tls\cert.pem` and its matching unencrypted PEM private key at `tls\key.pem`. Preserve the state directory's protected ACLs. If both files are absent, `admin.mjs init` generates a self-signed local-development certificate for `localhost` and `127.0.0.1`. Use a certificate trusted by operator browsers for remote access. Bootstrap the named dashboard administrator from a password prompt.

   ```powershell
   $initial = Get-Credential -UserName 'fleet-admin' -Message 'Create the first named dashboard account; use at least 14 characters'
   try {
       $env:HVDASH_ACCOUNT_PASSWORD = $initial.GetNetworkCredential().Password
       node .\admin.mjs init $initial.UserName
       if ($LASTEXITCODE) { throw 'Dashboard initialization failed.' }
   } finally {
       Remove-Item Env:HVDASH_ACCOUNT_PASSWORD -ErrorAction SilentlyContinue
       $initial = $null
   }
   # For each additional account, use the same password prompt and:
   # node .\admin.mjs user NAME viewer|operator|admin
   ```

4. Register the service using the dedicated Windows credential. For a local-only console, omit the bind and origin options. For LAN access use the management interface address and a DNS name covered by the certificate. This example uses documentation-only addresses.

   ```powershell
   $scmCred = Get-Credential -UserName $svcUser -Message 'Windows service logon'
   .\ops\service.ps1 -Action Install -Credential $scmCred -Bind '192.0.2.20' -Port 8722 -Origin 'https://hv-console.example:8722'
   .\ops\service.ps1 -Action Start
   .\ops\service.ps1 -Action Status
   ```

   Installation registers **HyperVDash** with automatic startup and SCM restart delays of 10, 30 and 60 seconds. The wrapper records lifecycle messages in `C:\ProgramData\HyperVDash\logs\service.log`. The wrapper sets the process environment from `C:\Program Files\HyperVDashService\service.xml`. Restrict any inbound HTTPS firewall rule to your admin network. Sign in, test a host and enter its host credential through this running service so DPAPI uses the service identity.

5. For maintenance, run `.\ops\service.ps1 -Action Stop`. The wrapper sends the application a shutdown request, waits up to eight seconds and closes its process job, including local PowerShell children. A host-side Hyper-V operation can already have committed when the service stops; reconcile interrupted jobs against VM inventory. To remove the SCM registration, stop it and run `.\ops\service.ps1 -Action Remove`. State, backups and installed files are retained. For a reinstallation use a fresh wrapper directory or archive the existing one first.

## Monitoring and alert delivery

Open **Monitoring** and select a host, a VM if desired, and a time range. The collector saves the last successful observation per minute. Each chart uses the last recorded minute in each interval (1 minute, 15 minutes, 2 hours or 6 hours). Missing intervals appear as gaps. A VM remains selectable while its history is retained, including after deletion. The first start indexes older VM samples in SQLite. Old samples can have only a VM ID and lack I/O counters.

The collector reads Windows performance counters for network interfaces, logical disks, Hyper-V virtual network adapters and virtual storage devices. Throughput is shown in KiB/s and average disk transfer latency in milliseconds. An unavailable counter leaves an empty reading. Check the service identity's performance-counter access and the availability of the English counter names on each host. [Microsoft Hyper-V performance counters](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/hyper-v-server/detecting-virtualized-environment-bottlenecks) · [Microsoft virtual disk counters](https://learn.microsoft.com/en-us/windows-server/storage/storage-spaces/performance-history-for-vhds)

Alerts open when disk free space falls below 15%, memory usage exceeds 90%, a host becomes unreachable, or a previously running VM is observed powered off without a matching dashboard operation. A shutdown initiated inside the guest or through another management tool can therefore raise an alert. A fresh sample clears a recovered condition. While the host is unreachable, its disk, memory and VM alerts retain their previous state. Administrators can change either percentage under **Alert thresholds**. New limits apply on the next successful poll.

For optional chat delivery, create an incoming webhook for the intended Slack channel and supply its URL in the dashboard process environment as `HVDASH_SLACK_WEBHOOK` before startup. For the Windows service, supply it to the service process through your site's secret-management mechanism. A variable set in an interactive shell applies to a dashboard launched from that shell. Keep the webhook secret. [Slack incoming webhook setup](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)

With delivery configured, SQLite queues one notification per opening and resolution. Messages include the host ID, condition and event time. Monitoring shows queued and retrying counts. Failed deliveries retry after 30 seconds with backoff up to one hour, including after restart. A lost acknowledgement or a restored pending queue can repeat a message. Leave the variable unset for dashboard-only alerts.

## Backup and restore

Run as an authorized local administrator and pass the **same Windows service account** to both operations. The account parameter records the DPAPI owner; the secret remains encrypted. Keep the backup path on an ACL-protected local volume, then use your organization's encrypted backup transport for off-host copies. The bundle contains password hashes, encrypted host credentials and the TLS private key.

```powershell
$svcUser = 'CONTOSO\hvdash-svc'
$snapshot = 'D:\ProtectedBackups\hvdash-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
.\ops\recovery.ps1 -Action Backup -Account $svcUser -BackupDirectory $snapshot
.\ops\recovery.ps1 -Action Verify -BackupDirectory $snapshot
```

Backup takes an online SQLite snapshot including hosts, profiles, permissions, jobs, metrics, IP ledger and audit history, then copies the TLS pair and writes a SHA-256 manifest. `Verify` checks the files, TLS pairing, SQLite integrity, references and required application tables. Store the application release and the service XML configuration separately for matching deployment paths. Image caches are reproducible from approved images. VM disks require their own backup policy.

Restore into a new location on the original management machine with the original service account and DPAPI profile. An empty or fresh Windows profile with the same login text cannot decrypt the original ciphertext. Back up that profile/master-key material using your Windows identity recovery procedures. The script rejects a mismatched machine identifier or service SID. These checks identify a misplaced snapshot; SHA-256 detects corruption, and trusted backup storage and NTFS permissions establish provenance.

```powershell
$restored = 'C:\ProgramData\HyperVDash\state-restored'
.\ops\recovery.ps1 -Action Restore -Account $svcUser -BackupDirectory $snapshot -RestoreDirectory $restored
.\ops\service.ps1 -Action Stop
.\ops\service.ps1 -Action UseState -StateDirectory $restored
.\ops\service.ps1 -Action Start
```

Restoration invalidates saved sign-in sessions, marks in-progress jobs interrupted and adds an audit entry. Sign in again and use the host connection test. To roll back, stop the service, use `UseState` with the original directory, then start it. Reconcile any writes accepted after the backup before switching production to the restored state.

## Local verification

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\smoke.ps1
```

This smoke check builds the actual Framework service wrapper, exercises its start and stop callbacks around a temporary Node process, applies fixture NTFS ACLs, backs up and restores a temporary database and TLS identity, decrypts an original fixture credential with DPAPI after restore, and verifies that a modified backup is rejected. SCM registration and reboot survival require a separate installation check in your intended service account.
