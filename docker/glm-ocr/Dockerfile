# GLM-OCR serving image — vLLM + Transformers-from-source.
#
# The stock `vllm/vllm-openai` image bundles a Transformers release that does
# not yet recognize the `glm_ocr` architecture. The official GLM-OCR docs
# require installing Transformers from source:
#   pip install git+https://github.com/huggingface/transformers.git
# This image layers that on top of the pinned vLLM image so `docker compose up`
# stays a one-command start (no manual pip step inside the container).
FROM vllm/vllm-openai:v0.19.0-ubuntu2404

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "git+https://github.com/huggingface/transformers.git@v4.49.0"

USER 1001
