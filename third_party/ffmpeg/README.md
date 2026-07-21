# FFmpeg distribution boundary

The repository currently has **no redistributable FFmpeg bundle**. Local development resolves
`ffmpeg-static` and `@ffprobe-installer/ffprobe`, but that pair is deliberately marked
development-only. It must not be copied into an installer or hosted release.

## Runtime selection

The server resolves binaries in this order:

1. `MANJU_FFMPEG_PATH` + `MANJU_FFPROBE_PATH` + `MANJU_FFMPEG_MANIFEST`;
2. `third_party/ffmpeg/bundled/<platform>-<arch>/` containing `ffmpeg`, `ffprobe`, and
   `FFMPEG_DISTRIBUTION.json`;
3. the development-only locator packages, but only when `MANJU_FFMPEG_RELEASE_MODE` is not `1`.

An incomplete explicit configuration fails closed and does not silently fall back. An audited
bundle is hash-bound to its manifest and legal files at runtime. Release startup additionally
requires `VERIFICATION_RECEIPT.json` beside a bundle, or an absolute `MANJU_FFMPEG_RECEIPT` for
explicit paths. The release build executes
the binaries to verify their exact version/configuration, rejects `--enable-nonfree`, checks every
renderer/QC capability, and runs MP4, subtitle, mask, QC, and PNG smoke tests.

```bash
MANJU_FFMPEG_RELEASE_MODE=1 \
MANJU_FFMPEG_PATH=/absolute/path/ffmpeg \
MANJU_FFPROBE_PATH=/absolute/path/ffprobe \
MANJU_FFMPEG_MANIFEST=/absolute/path/FFMPEG_DISTRIBUTION.json \
npm run build:release
```

After the build writes `dist/legal/FFmpeg/VERIFICATION_RECEIPT.json`, start through the separate
fail-closed path (a packaged bundle may instead put the same receipt beside its manifest):

```bash
MANJU_FFMPEG_PATH=/absolute/path/ffmpeg \
MANJU_FFPROBE_PATH=/absolute/path/ffprobe \
MANJU_FFMPEG_MANIFEST=/absolute/path/FFMPEG_DISTRIBUTION.json \
MANJU_FFMPEG_RECEIPT=/absolute/path/to/VERIFICATION_RECEIPT.json \
npm run start:release
```

`FFMPEG_DISTRIBUTION.example.json` documents the required manifest shape. All referenced files
must be regular non-symlink files located beside the manifest; absolute paths and `..` escapes are
rejected. The corresponding-source archive must include the exact FFmpeg and linked-library
sources plus the scripts/configuration needed to rebuild the binaries.

## Current blocker

See `DEVELOPMENT_FALLBACK_AUDIT.md`. The installed macOS arm64 pair is not eligible because the
FFmpeg binary contains `--enable-nonfree`, FFmpeg and ffprobe are different versions from different
packages, and there is no complete corresponding-source archive for that exact pair. No audited
replacement binary is checked in yet.

`BUILD.md` is the fail-closed source-build handoff. It pins and verifies the primary FFmpeg source,
defines the only accepted configure boundary, and lists the external source ledger that still must
be completed per target. This repository does not download or bless an opaque third-party binary.
