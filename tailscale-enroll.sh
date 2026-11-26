#!/bin/sh
# Run as root on the newly provisioned Debian 13 guest after cloud-init finishes.
set -eu
export DEBIAN_FRONTEND=noninteractive
repo=https://pkgs.tailscale.com/stable/debian
keyring=/usr/share/keyrings/tailscale-archive-keyring.gpg
install -d -m 0755 /usr/share/keyrings
curl --fail --silent --show-error --retry 2 "$repo/trixie.noarmor.gpg" -o "$keyring"
chmod 0644 "$keyring"
printf 'deb [signed-by=%s] %s trixie main\n' "$keyring" "$repo" > /etc/apt/sources.list.d/tailscale.list
apt-get -o APT::Update::Error-Mode=any update
apt-get install -y --no-install-recommends tailscale
systemctl enable --now tailscaled

keydir=$(mktemp -d /run/hvdash-key.XXXXXX)
mount -t vfat -o ro,nosuid,nodev,noexec,umask=077 LABEL=HVDASHKEY "$keydir"
trap 'umount "$keydir" && rmdir "$keydir"' EXIT
tailscale up --timeout=90s --auth-key="file:$keydir/auth.key"
