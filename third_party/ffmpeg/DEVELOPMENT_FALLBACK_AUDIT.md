# Development fallback audit — macOS arm64

Observed on 2026-07-15 from the exact packages pinned by `package-lock.json`. This is evidence for
the release blocker, **not** an authorization manifest.

## FFmpeg

- Locator package: `ffmpeg-static@5.3.0`
- Binary-reported version: `ffmpeg version 6.0`
- SHA-256: `a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584`
- Architecture: `arm64`
- Configuration:

```text
--prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libvmaf --enable-libbluray --enable-libopenjpeg --enable-libopus --enable-libmp3lame --enable-libx264 --enable-libx265 --enable-libvpx --enable-libwebp --enable-libass --enable-libfreetype --enable-fontconfig --enable-libtheora --enable-libvorbis --enable-libsnappy --enable-libaom --enable-libvidstab --enable-libzimg --enable-libsvtav1 --enable-libkvazaar --enable-version3 --pkg-config-flags=--static --enable-ffplay --enable-postproc --enable-nonfree --enable-neon --enable-runtime-cpudetect --disable-indev=qtkit --disable-indev=x11grab_xcb
```

The explicit `--enable-nonfree` flag makes this binary fail the project release gate regardless of
which license text happens to be adjacent to it.

## ffprobe

- Locator package: `@ffprobe-installer/ffprobe@2.1.2`
- Binary-reported version: `ffprobe version n4.4.1`
- SHA-256: `c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff`
- Reported configuration: empty

The FFmpeg 6.0 / ffprobe 4.4.1 split also fails the same-source/version requirement for a release
bundle.

## Primary-source baseline selected for replacement

The replacement recipe pins FFmpeg 8.1.2, published by the FFmpeg project on 2026-06-17:

- Source: `https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz`
- Source SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- Signature: `https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc`
- Official release-key fingerprint: `FCF986EA15E6E293A5644F10B4322F04D67658D8`

The source tarball signature was verified against that exact fingerprint during this audit. FFmpeg's
official download page states that FFmpeg itself publishes source code and documents the same
release verification procedure: <https://ffmpeg.org/download.html>.

