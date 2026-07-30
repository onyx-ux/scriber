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

FROM node:20-bookworm-slim AS whisper-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
WORKDIR /build/whisper.cpp
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --config Release

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

# whisper.cpp binary + the shared libs it needs at runtime
COPY --from=whisper-build /build/whisper.cpp/build/bin/whisper-cli /app/whisper.cpp/build/bin/whisper-cli
COPY --from=whisper-build /build/whisper.cpp/build/src/*.so* /app/whisper.cpp/build/src/ 2>/dev/null || true
COPY --from=whisper-build /build/whisper.cpp/build/ggml/src/*.so* /app/whisper.cpp/build/ggml/src/ 2>/dev/null || true

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data /models && chmod +x /app/scripts/download-model.sh

ENV DATA_DIR=/data
ENV WHISPER_BIN=/app/whisper.cpp/build/bin/whisper-cli
ENV WHISPER_MODEL_PATH=/models/ggml-base.en.bin

CMD ["sh", "-c", "/app/scripts/download-model.sh && node src/index.js"]
