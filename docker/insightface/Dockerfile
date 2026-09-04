# InsightFace sidecar — single stateless container replacing the 5-container
# CompreFace stack. Multi-stage: the insightface 0.7.3 sdist needs a C++
# toolchain (Cython mesh extension) + preinstalled numpy/cython with
# --no-build-isolation; the runtime image stays slim.
#
# Models are baked at build time (buffalo_l.zip pinned by sha256) into the
# RUNTIME USER's HOME — insightface resolves ~/.insightface per-process, so
# baking into another user's HOME would trigger a runtime download and fail
# offline.
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

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=build /usr/local/bin /usr/local/bin

WORKDIR /srv
COPY app ./app

# Bake the buffalo_l model pack (pinned) into the runtime user's HOME.
ARG BUFFALO_L_SHA256=80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f
RUN mkdir -p /root/.insightface/models \
    && apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates wget \
    && wget -q -O /tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip \
    && echo "${BUFFALO_L_SHA256}  /tmp/buffalo_l.zip" | sha256sum -c - \
    && unzip -q /tmp/buffalo_l.zip -d /root/.insightface/models/buffalo_l \
    && rm /tmp/buffalo_l.zip \
    && apt-get purge -y unzip wget && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

ENV PORT=8000 \
    WEB_CONCURRENCY=1 \
    OMP_NUM_THREADS=2 \
    FACE_MODEL_PACK=buffalo_l

EXPOSE 8000

# python:3.11-slim has no curl — probe via urllib.
HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=90s \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/health', timeout=5)"

CMD ["python", "-m", "app.main"]
