# syntax=docker/dockerfile:1
#
# NOTE: this is a starting point, not a verified-on-real-hardware build.
# whisper.cpp's CMake build is generally straightforward on both amd64 and
# arm64, but Pi-specific quirks (available RAM during compile, exact Debian
# base image version) sometimes need small tweaks — expect to iterate here
# once you actually build this on the Pi. If compiling ON the Pi is too slow
# or runs out of memory, cross-compiling on your PC with `docker buildx build
# --platform linux/arm64` and pushing to a registry the Pi pulls from is the
# usual workaround.


# git clone runs on the BUILD platform (native, no QEMU) rather than the
# TARGET platform. Cloning is pure network I/O and gains nothing from
# emulation — but running it *under* QEMU for the arm64 leg of a multi-arch
# build is a known buildx footgun: git crashes with exit code 128 fairly
# often because QEMU's syscall emulation is flaky for git's process/spawn
# calls (see docker/buildx#528). Splitting the clone into its own
# always-native stage sidesteps that entirely.
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS whisper-source
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git

# The actual compile still needs to target the real platform (arm64 for the
# Pi), so this stage is left unpinned — buildx runs it under QEMU when
# cross-building for arm64 on an amd64 runner. That's slower than the clone
# but doesn't hit the same crash; it's just the compile time README already
# warned about (10-20 min for the arm64 leg).
FROM node:20-bookworm-slim AS whisper-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=whisper-source /build/whisper.cpp ./whisper.cpp
WORKDIR /build/whisper.cpp
# GGML_NATIVE=OFF is required here: ggml's default -march=native detection
# probes CPU features that are meaningless (or outright wrong) under QEMU
# emulation, and generates a self-contradictory -march string (adding and
# then un-adding the same extensions), which the assembler rejects with
# "must specify extensions to add before specifying those to remove". This
# is a known ggml/llama.cpp issue under emulated arm64 builds (ggml-org/
# llama.cpp#10933) -- pinning a plain generic armv8-a target sidesteps the
# broken autodetection instead of trying to fix the probe itself.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8-a \
    && cmake --build build -j --config Release

# Stage runtime artifacts into a fixed layout. Shared libs are collected with
# `find` rather than a fixed glob path — different whisper.cpp versions have
# put them in different places (build/src + build/ggml/src at one point,
# build/bin/ as of the version this was last tested against), and a Dockerfile
# that assumes one fixed layout silently ships a binary that can't find its
# own libraries at runtime (confirmed: `whisper-cli` failed with
# "libwhisper.so.1: cannot open shared object file" until this was fixed to
# search build/ instead of guessing a path). The `|| true` has to live in a
# RUN/shell step, not a COPY — COPY has no shell and can't do `2>/dev/null
# || true`.
RUN mkdir -p /out/bin /out/lib && \
    cp build/bin/whisper-cli /out/bin/ && \
    find build -name '*.so*' -exec cp -n {} /out/lib/ \; 2>/dev/null || true

FROM node:20-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# rclone and ffmpeg are straightforward Debian packages on both amd64 and
# arm64 — no separate cross-compile step needed like whisper.cpp required.
# ffmpeg does the 48kHz stereo -> 16kHz mono resample for captured audio
# (see voice/capture.js) — its resampler is properly anti-aliased, unlike a
# hand-rolled decimator, which matters for whisper's transcription accuracy.
RUN apt-get update && apt-get install -y --no-install-recommends rclone ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp binary + the shared libs it needs at runtime. These are plain
# unconditional COPYs of the staged /out layout from the build stage — safe
# even if /out/lib ended up empty (a fully static build). LD_LIBRARY_PATH is
# set explicitly below rather than relying on the binary's RPATH, since that
# depends on exactly how whisper.cpp's CMake config built it.
COPY --from=whisper-build /out/bin/whisper-cli /app/whisper.cpp/build/bin/whisper-cli
COPY --from=whisper-build /out/lib/ /app/whisper.cpp/build/lib/

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data /models && chmod +x /app/scripts/download-model.sh

ENV DATA_DIR=/data
ENV WHISPER_BIN=/app/whisper.cpp/build/bin/whisper-cli
ENV WHISPER_MODEL_PATH=/models/ggml-base.en.bin
ENV LD_LIBRARY_PATH=/app/whisper.cpp/build/lib

CMD ["sh", "-c", "/app/scripts/download-model.sh && node src/index.js"]
