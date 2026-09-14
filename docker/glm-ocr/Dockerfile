# GLM-OCR serving image — vLLM + a Transformers that knows the `glm_ocr`
# architecture.
#
# WHY A TRANSFORMERS LAYER AT ALL: the `zai-org/GLM-OCR` checkpoint declares
# `model_type: "glm_ocr"` / `architectures: ["GlmOcrForConditionalGeneration"]`.
# vLLM 0.19.0 ships the MODEL implementation (vllm/model_executor/models/
# glm_ocr.py) but resolves the checkpoint's config through Transformers, and no
# RELEASED Transformers tag knows that architecture — `glm_ocr` first appears in
# the source tree with commit 4854dbf9da40 ("[GLM-OCR] GLM-OCR Support"). So the
# image must install Transformers from git.
#
# WHY THIS EXACT PIN (verified by building and importing, see below):
#   * `@v4.49.0` (the previous pin) is FATAL: vLLM 0.19.0 imports Gemma3Config,
#     which does not exist at 4.49.0 →
#     `ImportError: cannot import name 'Gemma3Config' from 'transformers'`.
#     The API server could not start, so OCR was dead in every deployment.
#   * The base image's own 4.57.6 satisfies vLLM but does NOT know `glm_ocr`
#     (no such module in any released tag) → `ValueError: ... does not recognize
#     this architecture`.
#   * The commit below is the newest commit that touched the glm_ocr config,
#     i.e. a stable point well past the architecture landing. It satisfies both
#     constraints.
# Pinning a COMMIT (not `main`) keeps the build reproducible; `main` is a moving
# target that would silently change the OCR engine's behavior.
#
# VERIFICATION (run after any change to this pin):
#   python3 -c "import vllm.entrypoints.openai.api_server as m; print(hasattr(m,'build_app'))"
#   python3 -c "from vllm.transformers_utils.config import get_config; \
#     c=get_config('zai-org/GLM-OCR', revision='<pin>', trust_remote_code=False); \
#     print(c.model_type, c.architectures)"
# Both must succeed. The second is the one that catches a bad Transformers pin.
FROM vllm/vllm-openai:v0.19.0-ubuntu2404

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Transformers from source at a pinned commit. pip warns that this violates
# vLLM's `transformers<5,>=4.56.0` constraint — the installed version string is
# `5.17.0.dev0`, because Transformers' development line has moved to 5.x and NO
# 4.x commit contains `glm_ocr` (checked: every commit that touched the
# glm_ocr config reports a 5.x-dev version). vLLM imports and serves correctly
# against it anyway (verified end-to-end, including a real OCR inference), so
# the `<5` bound is a soft declaration rather than a hard requirement here.
# Do NOT "fix" the warning by switching to a released 4.x tag — none of them
# know the architecture, which is the whole reason this layer exists.
ARG TRANSFORMERS_REF=4177486a9f199bd7be520eff14431071d5d41ec5
RUN pip install --no-cache-dir \
    "git+https://github.com/huggingface/transformers.git@${TRANSFORMERS_REF}"

# audit-3 (found by building this image): `USER 1001` with NO matching passwd
# entry made the service CRASH ON STARTUP. torch's inductor cache resolves a
# cache directory via `getpass.getuser()` → `pwd.getpwuid(os.getuid())[0]`,
# which raises `KeyError: 'getpwuid(): uid not found: 1001'` for a bare uid, so
# the container died before loading the model. Create a real user with a home.
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /home/app

# HOME must be writable: torch/vLLM write caches under it (TORCHINDUCTOR_CACHE_DIR)
# and Hugging Face weights land in HF_HOME on first start (compose documents the
# cold-start pull). Keeping them off /root avoids a permission failure now that
# the runtime user is unprivileged.
ENV HOME=/home/app \
    XDG_CACHE_HOME=/home/app/.cache \
    HF_HOME=/home/app/.cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1

USER app
