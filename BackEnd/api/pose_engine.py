"""
═══════════════════════════════════════════════════════════
  FormAI — Virtual Fitness Trainer
  BackEnd/pose_engine.py
═══════════════════════════════════════════════════════════

  Uses the NEW mediapipe.tasks API (mediapipe >= 0.10).
  The old mp.solutions.pose API was removed in 0.10+.

  On first run this file automatically downloads the
  pose_landmarker model file (~7 MB) from Google and
  saves it as  BackEnd/pose_landmarker.task
═══════════════════════════════════════════════════════════
"""

import math
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from mediapipe.tasks.python.components.containers import landmark as mp_landmark


# ── MODEL FILE ───────────────────────────────────────────
# Download once on first run; reuse on subsequent runs.
MODEL_PATH = Path(__file__).parent / "pose_landmarker.task"
MODEL_URL  = (
    "https://storage.googleapis.com/mediapipe-models/"
    "pose_landmarker/pose_landmarker_lite/float16/latest/"
    "pose_landmarker_lite.task"
)

def _ensure_model():
    if not MODEL_PATH.exists():
        print("[FormAI] Downloading pose model (~7 MB) — one-time setup…")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print(f"[FormAI] Model saved to {MODEL_PATH}")

_ensure_model()


# ── LANDMARK INDEX CONSTANTS ─────────────────────────────
class LM:
    """MediaPipe Pose landmark indices (same numbering as the old API)."""
    NOSE           = 0
    LEFT_SHOULDER  = 11
    RIGHT_SHOULDER = 12
    LEFT_ELBOW     = 13
    RIGHT_ELBOW    = 14
    LEFT_WRIST     = 15
    RIGHT_WRIST    = 16
    LEFT_HIP       = 23
    RIGHT_HIP      = 24
    LEFT_KNEE      = 25
    RIGHT_KNEE     = 26
    LEFT_ANKLE     = 27
    RIGHT_ANKLE    = 28
    LEFT_HEEL      = 29
    RIGHT_HEEL     = 30
    LEFT_FOOT      = 31
    RIGHT_FOOT     = 32


# ── SKELETON CONNECTIONS ─────────────────────────────────
# Pairs of landmark indices to draw as bones.
SKELETON_CONNECTIONS = [
    # Torso
    (LM.LEFT_SHOULDER,  LM.RIGHT_SHOULDER),
    (LM.LEFT_SHOULDER,  LM.LEFT_HIP),
    (LM.RIGHT_SHOULDER, LM.RIGHT_HIP),
    (LM.LEFT_HIP,       LM.RIGHT_HIP),
    # Left arm
    (LM.LEFT_SHOULDER,  LM.LEFT_ELBOW),
    (LM.LEFT_ELBOW,     LM.LEFT_WRIST),
    # Right arm
    (LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW),
    (LM.RIGHT_ELBOW,    LM.RIGHT_WRIST),
    # Left leg
    (LM.LEFT_HIP,       LM.LEFT_KNEE),
    (LM.LEFT_KNEE,      LM.LEFT_ANKLE),
    # Right leg
    (LM.RIGHT_HIP,      LM.RIGHT_KNEE),
    (LM.RIGHT_KNEE,     LM.RIGHT_ANKLE),
]

# Brand accent colour: #C8F135 in BGR
_ACCENT = (53, 241, 200)
_DIM    = (40, 180, 150)


class PoseEngine:
    """
    Wraps the new mediapipe.tasks PoseLandmarker API.

    Usage (from app.py camera_loop):
        engine = PoseEngine()
        results, annotated_frame = engine.process(bgr_frame)
        if results:
            landmarks = results   # list of NormalizedLandmark
    """

    def __init__(self):
        base_options = mp_python.BaseOptions(
            model_asset_path=str(MODEL_PATH)
        )
        options = mp_vision.PoseLandmarkerOptions(
            base_options=base_options,
            output_segmentation_masks=False,
            num_poses=1,
            min_pose_detection_confidence=0.6,
            min_pose_presence_confidence=0.6,
            min_tracking_confidence=0.5,
            running_mode=mp_vision.RunningMode.IMAGE,
        )
        self.landmarker = mp_vision.PoseLandmarker.create_from_options(options)

    # ── MAIN METHOD ───────────────────────────────────────
    def process(self, frame: np.ndarray):
        """
        Run pose detection on one BGR OpenCV frame.

        Returns:
            (landmarks, annotated_frame)

            landmarks       — flat list of 33 NormalizedLandmark objects,
                              or None if no person detected.
                              Access like: landmarks[LM.LEFT_KNEE].x

            annotated_frame — copy of frame with skeleton drawn on it.
        """
        # Convert BGR → RGB for MediaPipe
        rgb        = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image   = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        detection  = self.landmarker.detect(mp_image)

        annotated = frame.copy()

        if not detection.pose_landmarks:
            return None, annotated

        # The new API returns a list-of-lists (one per detected person).
        # We only track the first person.
        landmarks = detection.pose_landmarks[0]

        self._draw_skeleton(annotated, landmarks)
        self._draw_confidence_dot(annotated, landmarks)

        return landmarks, annotated

    # ── DRAWING ───────────────────────────────────────────
    def _draw_skeleton(self, frame: np.ndarray, landmarks: list) -> None:
        """Draw bones and joint dots using FormAI brand colours."""
        h, w = frame.shape[:2]

        # Draw bones first (so dots render on top)
        for a_idx, b_idx in SKELETON_CONNECTIONS:
            a = landmarks[a_idx]
            b = landmarks[b_idx]
            if a.visibility < 0.4 or b.visibility < 0.4:
                continue
            pt_a = (int(a.x * w), int(a.y * h))
            pt_b = (int(b.x * w), int(b.y * h))
            color = _ACCENT if (a.visibility > 0.65 and b.visibility > 0.65) else _DIM
            cv2.line(frame, pt_a, pt_b, color, 3, cv2.LINE_AA)

        # Draw joint dots
        for lm in landmarks:
            if lm.visibility < 0.4:
                continue
            pt    = (int(lm.x * w), int(lm.y * h))
            color = _ACCENT if lm.visibility > 0.65 else _DIM
            cv2.circle(frame, pt, 5, color,     -1, cv2.LINE_AA)
            cv2.circle(frame, pt, 5, (0, 0, 0),  1, cv2.LINE_AA)

    def _draw_confidence_dot(self, frame: np.ndarray, landmarks: list) -> None:
        """Small coloured dot in top-left: green/orange/red based on visibility."""
        key = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
               LM.LEFT_HIP,      LM.RIGHT_HIP,
               LM.LEFT_KNEE,     LM.RIGHT_KNEE]
        avg = sum(landmarks[i].visibility for i in key) / len(key)

        color = (53, 241, 200) if avg >= 0.75 else (0, 140, 255) if avg >= 0.5 else (50, 50, 255)
        cv2.circle(frame, (28, 28), 10, color,     -1)
        cv2.circle(frame, (28, 28), 10, (0, 0, 0),  1)

    # ── STATIC UTILITIES ──────────────────────────────────
    @staticmethod
    def angle(a, b, c) -> float:
        """
        Angle at B in the A–B–C triangle, in degrees (0–180).
        Accepts NormalizedLandmark objects or plain (x, y) tuples.
        """
        if hasattr(a, "x"):
            ax, ay = a.x, a.y
            bx, by = b.x, b.y
            cx, cy = c.x, c.y
        else:
            ax, ay = a
            bx, by = b
            cx, cy = c

        rad   = math.atan2(cy - by, cx - bx) - math.atan2(ay - by, ax - bx)
        deg   = abs(math.degrees(rad))
        return round(360 - deg if deg > 180 else deg, 1)

    @staticmethod
    def pixel(landmark, frame: np.ndarray) -> tuple:
        """Convert normalised landmark coordinates to pixel (x, y)."""
        h, w = frame.shape[:2]
        return (int(landmark.x * w), int(landmark.y * h))

    @staticmethod
    def midpoint(a, b) -> tuple:
        """Midpoint between two landmarks as normalised (x, y)."""
        return ((a.x + b.x) / 2, (a.y + b.y) / 2)

    def close(self):
        """Release MediaPipe resources."""
        self.landmarker.close()