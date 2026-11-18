Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Resolve-HvPath([string]$InputPath) {
    if ([string]::IsNullOrWhiteSpace($InputPath)) { throw 'A filesystem path is required.' }
    $full = [IO.Path]::GetFullPath($InputPath)
    if ($full -notmatch '^[A-Za-z]:\\' -or $full.TrimEnd('\') -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) {
        throw 'Use a dedicated local directory on a drive, not a drive root or a network share.'
    }
    for ($p = $full; $p; $p = [IO.Path]::GetDirectoryName($p)) {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse points cannot be used here: $p" }
    }
    return $full
}

function Resolve-HvSid([string]$Account) {
    if ($Account -match '^S-1-') { return [Security.Principal.SecurityIdentifier]::new($Account) }
    return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier])
}

function Set-HvAcl([string]$Path, [Security.Principal.SecurityIdentifier]$Identity, [Security.AccessControl.FileSystemRights]$Rights) {
    $item = Get-Item -LiteralPath (Resolve-HvPath $Path) -Force
    if ($item.PSIsContainer) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $flags = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $flags = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $grants = @{}
    $grants[$Identity.Value] = $Rights
    $grants['S-1-5-18'] = 'FullControl'
    $grants['S-1-5-32-544'] = 'FullControl'
    foreach ($sid in $grants.Keys) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), $grants[$sid], $flags,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
}

function New-HvPrivateDir([string]$Path, [Security.Principal.SecurityIdentifier]$Identity, [Security.AccessControl.FileSystemRights]$Rights = 'Modify') {
    $dir = Resolve-HvPath $Path
    if (Test-Path -LiteralPath $dir) { throw "Use a new directory: $dir" }
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    Set-HvAcl $dir $Identity $Rights
    return $dir
}
