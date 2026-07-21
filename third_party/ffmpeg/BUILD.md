# Audited FFmpeg build recipe

This recipe is intentionally fail-closed. It does not convert Homebrew, `ffmpeg-static`, or another
downloaded executable into a redistributable artifact merely by hashing it.

## 1. Pinned primary source

Build FFmpeg and ffprobe from the same FFmpeg 8.1.2 source tree:

```text
archive URL  https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
signature    https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc
SHA-256      464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
release key  FCF986EA15E6E293A5644F10B4322F04D67658D8
```

Download the public key only from `https://ffmpeg.org/ffmpeg-devel.asc`, verify its full fingerprint,
then verify the detached signature before unpacking. A checksum without that primary-source
authentication is insufficient.

## 2. Required external-source ledger

The renderer hard-codes `libx264` and uses libass subtitles, so the resulting build is GPL rather
than LGPL. Before building a target, create a target-specific source ledger and corresponding-source
archive containing the exact sources and build scripts for:

- x264;
- libass;
- FreeType;
- FriBidi;
- HarfBuzz;
- Fontconfig and its transitive libraries if Fontconfig is enabled;
- every other non-system library reported by the final FFmpeg configuration or binary linkage.

For each component record project/version or commit, primary source URL, source SHA-256, license
expression, license-file SHA-256, patches, compiler/toolchain version, and deterministic build
arguments. Do not use a package-manager bottle as the corresponding source. The exact target source
tree, patches, and scripts—not only upstream links—must be included in
`corresponding-source.tar.xz` beside the distribution manifest.

This external-source ledger is the remaining manual packaging blocker. Legal review must confirm
the notices/source-offer policy for each shipped platform; this document is an engineering control,
not legal advice.

## 3. Build boundary

Build the audited dependencies into an isolated prefix, then configure the verified FFmpeg source
with the following minimum boundary. Add only options backed by the source ledger. Never add
`--enable-nonfree` or a library whose FFmpeg configure help classifies it as nonfree.

```bash
set -euo pipefail

PREFIX=/absolute/path/to/audited-prefix
SOURCE=/absolute/path/to/verified/ffmpeg-8.1.2
DEST=/absolute/path/to/bundle

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib"

# These must resolve from the audited prefix, not an ambient package manager.
pkg-config --exists --static x264 libass freetype2 fribidi harfbuzz

cd "$SOURCE"
./configure \
  --prefix="$PREFIX" \
  --pkg-config-flags=--static \
  --extra-cflags="$CPPFLAGS" \
  --extra-ldflags="$LDFLAGS" \
  --enable-gpl \
  --disable-nonfree \
  --enable-libx264 \
  --enable-libass \
  --enable-libfreetype \
  --enable-libfribidi \
  --enable-libharfbuzz \
  --disable-ffplay \
  --disable-debug \
  --disable-doc \
  --disable-network

make -j"$(sysctl -n hw.logicalcpu 2>/dev/null || getconf _NPROCESSORS_ONLN)" ffmpeg ffprobe
install -m 0755 ffmpeg ffprobe "$DEST/"
```

Do not strip before recording/debugging the reproducible build. If stripping is later approved,
record the exact strip tool/version/arguments and hash only the post-strip artifacts.

## 4. Manifest and release gate

Place the following regular files in one target directory:

```text
ffmpeg
ffprobe
FFMPEG_DISTRIBUTION.json
VERIFICATION_RECEIPT.json       # generated only after the live release smoke gate
BUILD.md                         # exact recipe used, including dependency steps
COPYING.GPLv2 (or approved GPL notice set)
THIRD_PARTY_NOTICES.md
corresponding-source.tar.xz
```

Populate `FFMPEG_DISTRIBUTION.json` from the example using the **live** `-version` output and file
hashes. Its capability arrays must contain at least every capability in
`server/ffmpeg-runtime.ts`. Then execute:

```bash
MANJU_FFMPEG_RELEASE_MODE=1 \
MANJU_FFMPEG_PATH="$DEST/ffmpeg" \
MANJU_FFPROBE_PATH="$DEST/ffprobe" \
MANJU_FFMPEG_MANIFEST="$DEST/FFMPEG_DISTRIBUTION.json" \
npm run verify:ffmpeg:release -- --receipt "$DEST/VERIFICATION_RECEIPT.json"
```

The verifier re-hashes every file, compares the exact live version and configuration, checks source
and target bindings, rejects nonfree/GPL declaration mismatches, verifies all renderer/QC codecs and
filters, and performs real encode/probe/subtitle/mask/QC/crop smoke tests. `npm run build:release`
runs the same gate and emits a verification receipt into the release legal archive.
Release startup re-hashes the legal files and requires that receipt to match the exact manifest
and complete smoke list before it binds a port.
