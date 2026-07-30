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

# Stage runtime artifacts into a fixed layout. The `|| true` fallback for
# the .so globs has to live here (in a RUN/shell step) rather than on a
# COPY instruction — COPY has no shell and doesn't understand `2>/dev/null
# || true`; those tokens get parsed as literal extra arguments instead of
# being suppressed, which is its own footgun (see the runtime stage below,
# this used to be parsed as a bogus extra source path). Directories are
# created up front so the later unconditional COPY never fails even on a
# static build that produces no .so files.
RUN mkdir -p /out/bin /out/src /out/ggml/src && \
    cp build/bin/whisper-cli /out/bin/ && \
    cp build/src/*.so* /out/src/ 2>/dev/null || true && \
    cp build/ggml/src/*.so* /out/ggml/src/ 2>/dev/null || true

FROM node:20-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# rclone is a straightforward Debian package on both amd64 and arm64 —
# no separate cross-compile step needed like whisper.cpp required.
RUN apt-get update && apt-get install -y --no-install-recommends rclone \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp binary + the shared libs it needs at runtime. These are plain
# unconditional COPYs of the staged /out layout from the build stage — safe
# even if the .so directories ended up empty (static build).
COPY --from=whisper-build /out/bin/whisper-cli /app/whisper.cpp/build/bin/whisper-cli
COPY --from=whisper-build /out/src/ /app/whisper.cpp/build/src/
COPY --from=whisper-build /out/ggml/src/ /app/whisper.cpp/build/ggml/src/

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data /models && chmod +x /app/scripts/download-model.sh

ENV DATA_DIR=/data
ENV WHISPER_BIN=/app/whisper.cpp/build/bin/whisper-cli
ENV WHISPER_MODEL_PATH=/models/ggml-base.en.bin

CMD ["sh", "-c", "/app/scripts/download-model.sh && node src/index.js"]
