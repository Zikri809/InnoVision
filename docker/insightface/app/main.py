"""InsightFace sidecar — single stateless face service (detection + pose +
embedding in ONE call), replacing the 5-container CompreFace stack.

Contract (docs/PLAN_INSIGHTFACE_MIGRATION.md, v3):
  GET  /health   → {"status":"ok","model":"buffalo_l","providers":[...]}
  POST /extract  → {"frame": "data:image/jpeg;base64,..."} →
                   {"faces":[{embedding(512, L2-normalized), yaw, pitch,
                              roll, det_score, bbox:[x1,y1,x2,y2]}]}

Privacy: frames are decoded in memory and NEVER written to disk.

Security: optional shared-secret header (`x-sidecar-token`, compared with
`FACE_SIDECAR_TOKEN`) — the loopback publish is the primary control, the
token guards bind drift (compose edits, `network_mode: host`). Request body
is capped (FACE_MAX_BODY_MB, default 2 MB) — well above the ~150KB frames
the Next.js routes send, far below memory-exhaustion abuse.

Models: buffalo_l pack restricted to detection + 3D-68 landmark + recognition
(`allowed_modules`) — pose comes ONLY from the 3d68 landmark model (output
shape 3309 → `require_pose`; the 2d106det landmark model never emits pose).
`/extract` is `async def` but pushes the blocking FaceAnalysis call to a
worker thread (`asyncio.to_thread`) — without that, a single `async def`
endpoint runs inference ON the event loop and every request (including
/health) serializes behind it. ONNX Runtime releases the GIL during Run(), so
concurrent extracts genuinely overlap up to the threadpool's saturation point
(anyio's default = 40 threads); decode + embed stay CPU-bound per call.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os

import numpy as np
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("insightface-sidecar")

MODEL_PACK = os.environ.get("FACE_MODEL_PACK", "buffalo_l")
TOKEN = os.environ.get("FACE_SIDECAR_TOKEN", "")
MAX_BODY_BYTES = int(os.environ.get("FACE_MAX_BODY_MB", "2")) * 1024 * 1024
DATA_URL_PREFIX = "data:image/"
POSE_YAW_MAX_ABS = float(os.environ.get("FACE_POSE_YAW_MAX_ABS", "360"))
# SCRFD's default det_thresh (0.5) drops hard synthetic / low-light faces
# entirely, and the smoke fixtures (tiny 256px synthetic faces) score 0.13-0.44.
# The DETECTOR threshold here is only "candidate generation" — it must be LOW
# so weak-but-real faces reach the response. The QUALITY gate is route-side
# (DETECTION_SCORE_MIN, default 0.6): a below-floor detection = 0-vote =
# FAIL, so a permissive detector costs integrity nothing. 0.05 keeps the
# detector honest about "is there anything face-shaped at all".
DET_THRESH = float(os.environ.get("FACE_DET_THRESH", "0.05"))

app = FastAPI(title="InnoVision InsightFace sidecar", docs_url=None, redoc_url=None)

# Prepared once per process at import time (before uvicorn serves traffic).
# `providers` pinned to CPU; intra/inter op threads are kept small so the
# sidecar never oversubscribes the dev machine against the Supabase stack
# and the (optional) GPU vLLM container.
from insightface.app import FaceAnalysis  # noqa: E402

_ctx = FaceAnalysis(
    name=MODEL_PACK,
    allowed_modules=["detection", "landmark_3d_68", "recognition"],
    providers=["CPUExecutionProvider"],
)
_ctx.prepare(ctx_id=0, det_size=(640, 640))
_ctx.models["detection"].det_thresh = DET_THRESH
logger.info(
    "model pack %s ready (detection + landmark_3d_68 + recognition), det_thresh=%.2f",
    MODEL_PACK,
    DET_THRESH,
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_PACK, "providers": ["CPUExecutionProvider"]}


def _check_token(x_sidecar_token: str | None) -> None:
    if TOKEN and x_sidecar_token != TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")


def _decode_frame(frame: str) -> np.ndarray:
    """data-URL/base64 → BGR image array. Raises 400 on any malformed input."""
    if not isinstance(frame, str) or len(frame) < 32 or len(frame) > MAX_BODY_BYTES:
        raise HTTPException(status_code=400, detail="invalid_frame")
    payload = frame
    if payload.startswith(DATA_URL_PREFIX):
        head, sep, payload = payload.partition(",")
        if not sep:
            raise HTTPException(status_code=400, detail="invalid_frame")
    try:
        buf = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid_frame")
    if not buf:
        raise HTTPException(status_code=400, detail="invalid_frame")
    import cv2  # headless build; imported here so /health stays dependency-light

    img = cv2.imdecode(np.frombuffer(buf, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="invalid_frame")
    return img


def _pose_from_kps(face) -> tuple[float, float, float]:
    """Fallback pose estimate from the 5-point keypoints when the landmark
    model did not populate `pose` (defensive; buffalo_l's 3d68 model does)."""
    kps = face.get("kps")
    if kps is None or len(kps) != 5:
        return (0.0, 0.0, 0.0)
    left_eye, right_eye, nose = kps[0], kps[1], kps[2]
    yaw = float(np.degrees(np.arctan2(nose[0] - (left_eye[0] + right_eye[0]) / 2.0,
                                      max(1e-3, abs(right_eye[0] - left_eye[0])))))
    pitch = float(np.degrees(np.arctan2(nose[1] - (left_eye[1] + right_eye[1]) / 2.0, 30.0)))
    roll = float(np.degrees(np.arctan2(right_eye[1] - left_eye[1],
                                       max(1e-3, right_eye[0] - left_eye[0]))))
    return (pitch, yaw, roll)


@app.post("/extract")
async def extract(request: Request, x_sidecar_token: str | None = Header(default=None)):
    _check_token(x_sidecar_token)
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="frame_too_large")
    import json

    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid_json")
    frame = payload.get("frame") if isinstance(payload, dict) else None
    img = _decode_frame(frame)

    # Blocking ONNX inference OFF the event loop: with `to_thread` concurrent
    # extracts overlap (ORT releases the GIL) and /health stays responsive
    # during a burst; running inline serialized everything behind one call.
    faces = await asyncio.to_thread(_ctx.get, img)
    out = []
    for face in faces:
        pose = face.get("pose")
        if pose is None:
            pose = _pose_from_kps(face)
        pitch, yaw, roll = (float(pose[0]), float(pose[1]), float(pose[2]))
        # Pose sanity: the 3d68 regressor is reliable in-distribution, but a
        # wild extrapolation must not fail the route's yaw gate silently —
        # clamp to a generous envelope.
        yaw = max(-POSE_YAW_MAX_ABS, min(POSE_YAW_MAX_ABS, yaw))
        bbox = [float(x) for x in face.get("bbox", [0, 0, 0, 0])][:4]
        emb = face.get("embedding")
        embedding = None
        if emb is not None:
            v = np.asarray(emb, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(v))
            if norm > 1e-6:
                embedding = [float(x) for x in (v / norm)]
        if embedding is None:
            continue
        out.append(
            {
                "embedding": embedding,
                "yaw": yaw,
                "pitch": pitch,
                "roll": roll,
                "det_score": float(face.get("det_score", 0.0)),
                "bbox": bbox,
            }
        )
    return JSONResponse({"faces": out})


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        workers=int(os.environ.get("WEB_CONCURRENCY", "1")),
        log_level="info",
    )
