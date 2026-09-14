# InsightFace sidecar — single stateless container replacing the 5-container
# CompreFace stack. Multi-stage: the insightface 0.7.3 sdist needs a C++
# toolchain (Cython mesh extension) + preinstalled numpy/cython with
# --no-build-isolation; the runtime image stays slim.
#
# Models are baked at build time (buffalo_l.zip pinned by sha256) into the
# RUNTIME USER's HOME — insightface resolves ~/.insightface per-process, so
# baking into another user's HOME would trigger a runtime download and fail
# offline. audit-3 R3-DEP-F4: the runtime user is now NON-ROOT (uid/gid 1001,
# matching the sibling glm-ocr image's `USER 1001`), so HOME is set explicitly
# to that user's home and every baked model dir is chowned to it.
FROM python:3.11-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt .
# Preinstall numpy + cython BEFORE the resolver runs (insightface's setup.py
# imports numpy at build time), then install everything with
# --no-build-isolation so the pinned numpy headers are the ones it compiles
# against (build isolation would pull numpy 2.x → ABI mismatch).
RUN pip install --no-cache-dir numpy==1.26.4 cython==3.0.11 \
    && pip install --no-cache-dir --no-build-isolation -r requirements.txt

FROM python:3.11-slim

# audit-3 R3-DEP-F4: run as an unprivileged user. The process decodes and runs
# ONNX inference on request-supplied image bytes, so a parser/runtime bug must
# not execute as uid 0 in the container. 1001 mirrors docker/glm-ocr/Dockerfile.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --shell /usr/sbin/nologin app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=build /usr/local/bin /usr/local/bin

WORKDIR /srv
COPY app ./app

# Bake the buffalo_l model pack (pinned) into the runtime user's HOME.
# HOME is set below to /home/app; insightface looks in $HOME/.insightface.
ARG BUFFALO_L_SHA256=80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f
RUN mkdir -p /home/app/.insightface/models \
    && apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates wget \
    && wget -q -O /tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip \
    && echo "${BUFFALO_L_SHA256}  /tmp/buffalo_l.zip" | sha256sum -c - \
    && unzip -q /tmp/buffalo_l.zip -d /home/app/.insightface/models/buffalo_l \
    && rm /tmp/buffalo_l.zip \
    && apt-get purge -y unzip wget && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# audit-2 C-01: bake the MiniFASNet anti-spoofing ensemble (Silent-Face-
# Anti-Spoofing, Apache-2.0; ONNX conversion by QingHeYang/
# Silent-Face-Anti-Spoofing-onnx), pinned by sha256. app/spoof.py loads
# BOTH members — a missing/failed weight set degrades the verdict to null
# (route goes record-only or fail-closed per FACE_SPOOF_ENFORCE) instead
# of breaking /extract.
ARG SPOOF_V2_SHA256=0cbe5caec95c31de9d2ef845cb85407d76aecd1b6a2c0e343f7d35306bfbccb8
ARG SPOOF_V1SE_SHA256=a25886a85cdcfa2c4ea23edb71de35f250c17827b4cadd253a972b28c80fdf1e
RUN mkdir -p /srv/models/spoof \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && wget -q -O /srv/models/spoof/2.7_80x80_MiniFASNetV2.onnx \
         https://raw.githubusercontent.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/main/onnx/2.7_80x80_MiniFASNetV2.onnx \
    && echo "${SPOOF_V2_SHA256}  /srv/models/spoof/2.7_80x80_MiniFASNetV2.onnx" | sha256sum -c - \
    && wget -q -O /srv/models/spoof/4_0_0_80x80_MiniFASNetV1SE.onnx \
         https://raw.githubusercontent.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx/main/onnx/4_0_0_80x80_MiniFASNetV1SE.onnx \
    && echo "${SPOOF_V1SE_SHA256}  /srv/models/spoof/4_0_0_80x80_MiniFASNetV1SE.onnx" | sha256sum -c - \
    && apt-get purge -y wget && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# The runtime user must own the model trees (they are read-only at runtime, but
# insightface may write caches) and the app dir.
RUN chown -R app:app /home/app/.insightface /srv

# HOME drives insightface's ~/.insightface resolution — it MUST be the app
# user's home (see the header comment: baking into another HOME would trigger a
# runtime download). XDG_CACHE_HOME keeps any stray cache writes off /root.
ENV HOME=/home/app \
    XDG_CACHE_HOME=/home/app/.cache \
    PORT=8000 \
    WEB_CONCURRENCY=1 \
    OMP_NUM_THREADS=2 \
    FACE_MODEL_PACK=buffalo_l

USER app

EXPOSE 8000

# python:3.11-slim has no curl — probe via urllib.
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=90s \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health', timeout=5)"

CMD ["python", "-m", "app.main"]
