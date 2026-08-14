#!/bin/sh
# crosswire installer: downloads the latest prebuilt binary for this platform.
#   curl -fsSL https://raw.githubusercontent.com/pranavkarthik10/crosswire/main/install.sh | sh
set -e

REPO="pranavkarthik10/crosswire"
DIR="${CROSSWIRE_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s) (Windows: run from source with Bun)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

target="crosswire-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${target}.tar.gz"

echo "downloading ${target}…"
mkdir -p "$DIR"
tmp=$(mktemp -d)
curl -fsSL "$url" -o "$tmp/crosswire.tar.gz"
tar -xzf "$tmp/crosswire.tar.gz" -C "$tmp"
mv "$tmp/crosswire" "$DIR/crosswire"
chmod +x "$DIR/crosswire"
rm -rf "$tmp"

echo "installed $DIR/crosswire"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "note: add $DIR to your PATH" ;;
esac
echo "next: cd your-repo && crosswire init"
