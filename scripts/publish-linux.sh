#!/bin/sh
# Publishes one version's Linux builds to the update feed and usegui.com/download, the way
# scripts/release.sh does for the Mac build. .github/workflows/release-linux.yml runs it once
# both architectures are built and checked:
#
#   sh scripts/publish-linux.sh <folder> <version>
#
# <folder> holds what electron-builder wrote for x64 and arm64: Gui-<version>-x86_64.AppImage,
# Gui-<version>-arm64.AppImage, Gui-<version>-amd64.deb, Gui-<version>-arm64.deb and the feeds
# (<channel>-linux.yml for x64, <channel>-linux-arm64.yml). Wrangler needs CLOUDFLARE_API_TOKEN
# with R2 write access to gui-releases; the account is CLOUDFLARE_ACCOUNT_ID or, without it,
# www/wrangler.jsonc's.
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "$1" >&2
  exit 1
}

usage="usage: publish-linux.sh <folder> <version>"
dir=$(cd "${1:?$usage}" && pwd)
version=${2:?$usage}
bucket=gui-releases
# Where the worker serves the bucket (publish.url in electron-builder.yml).
site=https://usegui.com/releases
case "$version" in
  *-*) channel=$(echo "${version#*-}" | sed 's/\..*//') ;;
  *) channel=latest ;;
esac

files="Gui-$version-x86_64.AppImage Gui-$version-arm64.AppImage Gui-$version-amd64.deb Gui-$version-arm64.deb"
for file in $files; do
  [ -f "$dir/$file" ] || fail "$dir has no $file."
done
# A stable release also writes alpha and beta feeds (generateUpdatesFilesForAllChannels).
feeds=
for feed in "$dir"/*-linux.yml "$dir"/*-linux-arm64.yml; do
  [ ! -f "$feed" ] || feeds="$feeds $feed"
done
for feed in "$channel-linux.yml" "$channel-linux-arm64.yml"; do
  [ -f "$dir/$feed" ] || fail "$dir has no $feed."
done
for feed in $feeds; do
  grep -qxF "version: $version" "$feed" || fail "$(basename "$feed") doesn't name $version."
done

# The Mac release publishes its feed before it tags a version, so a Linux build follows the
# Mac's newest release on its channel and never another: re-running an older tag would put
# copies already updated past it back on that version.
curl -fsS --max-time 60 "$site/$channel-mac.yml" | grep -qxF "version: $version" ||
  fail "$site/$channel-mac.yml doesn't name $version, so the Linux builds of $version aren't published. Linux follows the newest Mac release on its channel."

put() {
  (cd www && bun x wrangler r2 object put "$bucket/$1" --file "$2" --content-type "$3" --remote)
}
content_type() {
  case "$1" in
    *.AppImage) echo application/vnd.appimage ;;
    *.deb) echo application/vnd.debian.binary-package ;;
  esac
}

for file in $files; do
  put "$file" "$dir/$file" "$(content_type "$file")"
done
# An AppImage updates one byte range at a time, like the Mac zip (scripts/release.sh). Nothing
# points at these files yet.
ranged=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 --max-filesize 1024 --max-time 60 "$site/Gui-$version-x86_64.AppImage" || true)
[ "$ranged" = 206 ] ||
  fail "usegui.com/releases answers a Range request with $ranged, not 206, so an update would download the whole AppImage many times. Only the versioned files are uploaded."

# The copies usegui.com/download serves: each channel's newest, and for a stable release the
# newest of all (Gui-x86_64.AppImage), which /download prefers once it exists.
for file in $files; do
  rest=${file#"Gui-$version-"}
  put "Gui-$channel-$rest" "$dir/$file" "$(content_type "$file")"
  if [ "$channel" = latest ]; then
    put "Gui-$rest" "$dir/$file" "$(content_type "$file")"
  fi
done

# Last, so installed copies only see the version once its files are there.
for feed in $feeds; do
  put "$(basename "$feed")" "$feed" text/yaml
done
# Read each feed back the way an installed copy does.
for feed in $feeds; do
  curl -fsS --max-time 60 "$site/$(basename "$feed")" | grep -qxF "version: $version" ||
    fail "$site/$(basename "$feed") doesn't name $version after the upload. The files are in the bucket. Find out why before running this again."
done
echo "Published Gui $version for Linux: https://usegui.com/download"
