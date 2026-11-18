#!/bin/sh
# Installs Gui on Linux, or replaces it with the newest version:
#
#   curl -fsSL https://usegui.com/install.sh | sh
#
# It puts the AppImage at ~/.local/share/gui/Gui.AppImage (the AppImage updates itself there,
# keeping the name), adds Gui to the app launcher, and writes nothing outside your home folder.
# GUI_INSTALL_URL points it at another copy of the site, for testing.

set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Gui was not installed: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# Prints a file from the site.
fetch() {
  if has curl; then
    curl -fsSL "$1"
  else
    wget -qO- "$1"
  fi
}

# Downloads $1 to $2, with a progress bar when someone is watching.
download() {
  if has curl; then
    if [ -t 2 ]; then curl -fL --progress-bar -o "$2" "$1"; else curl -fsSL -o "$2" "$1"; fi
  elif [ -t 2 ] && wget --help 2>&1 | grep -q -- --show-progress; then
    wget -q --show-progress -O "$2" "$1"
  elif [ -t 2 ]; then
    wget -O "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# True when this computer has the tools to check a download's sha512.
can_check() {
  { has sha512sum || has shasum || has openssl; } && { has base64 || has openssl; } && has od
}

# The sha512 of a file, in hex.
sha512_hex() {
  if has sha512sum; then
    sha512sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 512 "$1" | cut -d' ' -f1
  else
    openssl dgst -sha512 -r "$1" | cut -d' ' -f1
  fi
}

# The feed's base64 sha512, in hex.
base64_hex() {
  if has base64; then
    printf '%s' "$1" | base64 -d
  else
    printf '%s\n' "$1" | openssl base64 -d -A
  fi | od -An -v -tx1 | tr -d ' \n'
}

# A field at the top of a feed (version, sha512).
field() { printf '%s\n' "$1" | sed -n "s/^$2: *//p" | head -n 1; }

# A path as it can be typed into a shell.
shell_path() {
  case $1 in
    "$HOME"/*) rest=${1#"$HOME"/} ;;
    *) rest=$1 ;;
  esac
  case $rest in
    *[!A-Za-z0-9_./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    "$1") printf '%s' "$1" ;;
    *) printf '%s/%s' '~' "$rest" ;;
  esac
}

# A path quoted for a desktop entry's Exec line: inside double quotes, \ " ` $ take a
# backslash, which the file's own escaping doubles; % is written %%.
desktop_exec() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/["`$]/\\\\&/g' -e 's/%/%%/g')"
}

# True when a running Gui was started from $1 (the AppImage's runtime keeps it as its exe).
running() {
  for exe in /proc/[0-9]*/exe; do
    case $(readlink "$exe" 2>/dev/null || true) in
      "$1" | "$1 (deleted)") return 0 ;;
    esac
  done
  return 1
}

install_gui() {
  case $(uname -s) in
    Linux) ;;
    Darwin) fail "this command is for Linux. On a Mac, download Gui from https://usegui.com/download" ;;
    *) fail "Gui is for Mac and Linux." ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x86_64 feed=alpha-linux.yml ;;
    aarch64 | arm64) arch=arm64 feed=alpha-linux-arm64.yml ;;
    *) fail "Gui runs on x86_64 and arm64 processors, and this computer has $(uname -m)." ;;
  esac
  has curl || has wget || fail "install curl or wget, then run this again."

  site=${GUI_INSTALL_URL:-https://usegui.com}
  case ${XDG_DATA_HOME:-} in
    /*) data=$XDG_DATA_HOME ;;
    *) data=$HOME/.local/share ;;
  esac
  dir=$data/gui
  app=$dir/Gui.AppImage
  mkdir -p "$dir" || fail "couldn't create $dir."

  tmp=
  work=
  trap 'rm -rf "$tmp" "$work"' EXIT
  trap 'exit 1' INT TERM HUP
  tmp=$(mktemp "$dir/.Gui.AppImage.XXXXXX") || fail "couldn't write to $dir."

  checked=yes
  tries=0
  while :; do
    tries=$((tries + 1))
    info=$(fetch "$site/releases/$feed") ||
      fail "couldn't reach $site. Check your internet connection and try again."
    version=$(field "$info" version)
    sha512=$(field "$info" sha512)
    [ -n "$version" ] || fail "couldn't read the newest version from $site/releases/$feed."
    [ -t 2 ] && say "Downloading Gui $version for $arch..." >&2
    download "$site/download/Gui-$arch.AppImage" "$tmp" ||
      fail "the download stopped. Check your internet connection and try again."

    if ! can_check; then
      checked=no
      break
    fi
    [ "$(sha512_hex "$tmp")" = "$(base64_hex "$sha512")" ] && break
    # A release that landed during the download changes the feed: the file is the new one.
    newer=$(fetch "$site/releases/$feed" || true)
    if [ "$(field "$newer" sha512)" = "$sha512" ]; then
      fail "the download doesn't match its checksum, so it was deleted. Try again in a minute."
    fi
    [ "$tries" -lt 2 ] ||
      fail "a new version of Gui came out during the download. Run the command again."
  done

  chmod 755 "$tmp"
  was_running=no
  running "$app" && was_running=yes
  # Moving the new file over the old one leaves a running Gui on the old file until it quits.
  mv -f "$tmp" "$app" || fail "couldn't move Gui into $dir."
  tmp=

  # The icon, from the AppImage itself: extracting needs no FUSE. Gui installs without one.
  icon=no
  work=$(mktemp -d)
  if (cd "$work" && "$app" --appimage-extract 'usr/share/icons/hicolor/*/apps/gui.png') >/dev/null 2>&1; then
    for png in "$work"/squashfs-root/usr/share/icons/hicolor/*/apps/gui.png; do
      [ -f "$png" ] || continue
      size=${png%/apps/gui.png}
      size=${size##*/}
      mkdir -p "$data/icons/hicolor/$size/apps" &&
        cp "$png" "$data/icons/hicolor/$size/apps/gui.png" && icon=yes
    done
  fi

  # The launcher entry. Its name matches package.json's desktopName, so the running window
  # is matched to it.
  apps=$data/applications
  mkdir -p "$apps" || fail "couldn't create $apps."
  entry=$(mktemp "$apps/.gui.desktop.XXXXXX") || fail "couldn't write to $apps."
  {
    say '[Desktop Entry]'
    say 'Type=Application'
    say 'Name=Gui'
    say 'Comment=Design real interfaces with your own AI agents'
    say "Exec=$(desktop_exec "$app") %U"
    say 'Icon=gui'
    say 'Terminal=false'
    say 'Categories=Development;'
    say 'StartupWMClass=gui'
  } >"$entry"
  chmod 644 "$entry"
  mv -f "$entry" "$apps/gui.desktop" || {
    rm -f "$entry"
    fail "couldn't write $apps/gui.desktop."
  }
  has update-desktop-database && update-desktop-database "$apps" >/dev/null 2>&1 || true

  say "Installed Gui $version."
  say "Open it from your app launcher, or run: $(shell_path "$app")"
  [ "$was_running" = yes ] && say "Restart Gui to use the new version."
  [ "$checked" = no ] && say "The download's checksum wasn't checked: this computer has no sha512sum."
  [ "$icon" = yes ] || say "Gui's icon couldn't be added, so the launcher shows a generic one."
  if ! has fusermount3 && ! has fusermount; then
    say "Gui needs FUSE to start: install the fuse3 package (for example, sudo apt install fuse3)."
  fi
  return 0
}

install_gui
