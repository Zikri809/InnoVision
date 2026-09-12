"""MiniFASNet face anti-spoofing (print / screen-replay detection).

audit-2 C-01: the verify route needed a SERVER-JUDGED liveness signal. This
module loads the two ONNX MiniFASNet models of minivision-ai's
Silent-Face-Anti-Spoofing (Apache-2.0; ONNX conversion by
QingHeYang/Silent-Face-Anti-Spoofing-onnx), baked into the image at build
time by the Dockerfile (pinned by sha256):

  2.7_80x80_MiniFASNetV2.onnx       (scale 2.7 margin)
  4_0_0_80x80_MiniFASNetV1SE.onnx   (scale 4.0 margin)

3-class softmax per model (0 = paper photo, 1 = real face, 2 = screen
replay); the ensemble AVERAGES the softmax outputs. We expose the averaged
P(real) so the Next.js route applies one threshold on one number.

Preprocessing (must match the models' training pipeline EXACTLY):
  - crop around the face box scaled by the model's margin (2.7 / 4.0) with
    the original boundary-adjusting `_new_box` logic,
  - resize to 80x80, keep BGR, float32 CHW in the [0, 255] range (the
    models were trained on raw cv2.imread values — NO /255, NO mean/std).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("insightface-sidecar.spoof")

SPOOF_MODEL_DIR = Path(os.environ.get("FACE_SPOOF_MODEL_DIR", "/srv/models/spoof"))

# (filename, crop margin). Both ensemble members are REQUIRED — a single-
# model verdict is measurably weaker, so a half-present weight set counts
# as "unavailable" (the route degrades to record-only / fail-closed per
# its own FACE_SPOOF_ENFORCE policy).
SPOOF_MODELS: List[Tuple[str, float]] = [
    ("2.7_80x80_MiniFASNetV2.onnx", 2.7),
    ("4_0_0_80x80_MiniFASNetV1SE.onnx", 4.0),
]

INPUT_SIZE = (80, 80)


def _new_box(src_w: int, src_h: int, box: Tuple[float, float, float, float], scale: float) -> Tuple[int, int, int, int]:
    """Expand `box` (x1, y1, x2, y2) around its center by `scale`, keeping the
    crop inside the frame (original Silent-Face boundary logic)."""
    x1, y1, x2, y2 = box
    w = max(1.0, x2 - x1)
    h = max(1.0, y2 - y1)
    # The original operates on [x, y, w, h] with scale capped to the frame.
    scale = min((src_h - 1) / h, min((src_w - 1) / w, scale))
    new_w = w * scale
    new_h = h * scale
    center_x = w / 2 + x1
    center_y = h / 2 + y1
    left = center_x - new_w / 2
    top = center_y - new_h / 2
    right = center_x + new_w / 2
    bottom = center_y + new_h / 2
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > src_w - 1:
        left -= right - src_w + 1
        right = src_w - 1
    if bottom > src_h - 1:
        top -= bottom - src_h + 1
        bottom = src_h - 1
    return int(left), int(top), int(right), int(bottom)


class SpoofChecker:
    """Ensemble of MiniFASNet ONNX sessions; `available=False` when the
    weights are absent (dev sidecar without the baked models) — callers
    degrade to a null verdict instead of failing."""

    def __init__(self, model_dir: Path = SPOOF_MODEL_DIR):
        self._sessions: List[Tuple[object, float]] = []
        self.available = False
        try:
            import onnxruntime as ort

            for filename, scale in SPOOF_MODELS:
                path = model_dir / filename
                if not path.is_file():
                    logger.warning("spoof model missing: %s", path)
                    return
                session = ort.InferenceSession(
                    str(path), providers=["CPUExecutionProvider"]
                )
                self._sessions.append((session, scale))
            self.available = True
            logger.info("anti-spoof ensemble ready (%d models)", len(self._sessions))
        except Exception as exc:  # weights corrupt / ORT mismatch — degrade
            logger.warning("anti-spoof ensemble unavailable: %s", exc)
            self._sessions = []

    def _preprocess(self, img: "np.ndarray", box: Tuple[float, float, float, float], scale: float) -> "np.ndarray":
        import cv2

        src_h, src_w = img.shape[:2]
        left, top, right, bottom = _new_box(src_w, src_h, box, scale)
        crop = img[top : bottom + 1, left : right + 1]
        if crop.size == 0:
            raise ValueError("empty spoof crop")
        resized = cv2.resize(crop, INPUT_SIZE)
        chw = np.transpose(resized.astype(np.float32), (2, 0, 1))
        return np.expand_dims(chw, axis=0)

    def check(self, img: "np.ndarray", box: Tuple[float, float, float, float]) -> Optional[Dict[str, object]]:
        """Ensemble verdict for the face at `box` (x1, y1, x2, y2).

        Returns {"real": bool, "score": float} where score is the averaged
        P(real face) in [0, 1] — or None when the ensemble is unavailable.
        """
        if not self.available or not self._sessions:
            return None
        probs = np.zeros(3, dtype=np.float64)
        try:
            for session, scale in self._sessions:
                blob = self._preprocess(img, box, scale)
                input_name = session.get_inputs()[0].name
                output_name = session.get_outputs()[0].name
                # [0][0]: run() → (1, 1, 3) batched logits → single (3,) row.
                logits = session.run([output_name], {input_name: blob})[0][0].astype(np.float64)
                shifted = logits - np.max(logits)
                probs += np.exp(shifted) / np.sum(np.exp(shifted))
        except Exception as exc:
            logger.warning("spoof inference failed: %s", exc)
            return None
        probs /= len(self._sessions)
        score = float(probs[1])  # P(real face)
        return {"real": bool(score >= 0.5), "score": round(score, 4)}


def primary_box(faces_bboxes: List[Tuple[float, float, float, float]]) -> Optional[Tuple[float, float, float, float]]:
    """Largest-area bbox — mirrors the route's primary-face selection."""
    if not faces_bboxes:
        return None
    return max(faces_bboxes, key=lambda b: max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1]))


def build_checker() -> SpoofChecker:
    checker = SpoofChecker()
    if not checker.available:
        logger.warning(
            "anti-spoof DISABLED: bake the ONNX weights (see Dockerfile) or "
            "mount them into %s",
            SPOOF_MODEL_DIR,
        )
    return checker


# Type alias for the response builder in main.py (avoids importing cv2 here).
SpoofVerdict = Dict[str, object]
EnsureCallable = Callable[[], None]
