"""
═══════════════════════════════════════════════════════════
  FormAI — Virtual Fitness Trainer
  BackEnd/exercises.py
═══════════════════════════════════════════════════════════

  Responsibilities:
  - Define angle thresholds for every supported exercise
  - Count reps using a simple DOWN → UP state machine
  - Score form on each rep (0–100)
  - Generate coach feedback messages
  - Draw angle labels onto the annotated frame

  Adding a new exercise:
    1. Add an entry to EXERCISE_CONFIG below
    2. Add a method  _analyse_<name>(self, lm, frame) → dict
    3. Done — everything else is automatic
═══════════════════════════════════════════════════════════
"""

import cv2
import numpy as np
from BackEnd.api.pose_engine import PoseEngine, LM


# ── THRESHOLDS BY SENSITIVITY ────────────────────────────
# Each exercise defines "down" and "up" angles.
# Sensitivity shifts how strict the thresholds are.
SENSITIVITY_OFFSET = {
    "lenient": 10,   # angles are ±10° more forgiving
    "normal":   0,
    "strict":  -10,  # angles are ±10° more demanding
}


# ── EXERCISE CONFIG ──────────────────────────────────────
# Each exercise defines:
#   angle_labels : (left_label, right_label) shown on screen
#   thresholds   : dict of angle values used in _analyse_*
EXERCISE_CONFIG = {
    "squat": {
        "angle_labels": ("Knee angle", "Hip angle"),
        "thresholds": {
            "knee_down":  95,   # knee should bend past this to count a rep
            "knee_up":   160,   # knee this straight = standing position
            "hip_down":  100,   # hip angle at bottom of squat
            "back_max":   50,   # max forward lean (torso vs vertical)
        },
    },
    "pushup": {
        "angle_labels": ("Elbow angle", "Body angle"),
        "thresholds": {
            "elbow_down":  80,   # elbow angle at bottom
            "elbow_up":   155,   # elbow angle at top (full extension)
            "body_min":   165,   # body should stay this straight
        },
    },
    "curl": {
        "angle_labels": ("Elbow angle", "Wrist angle"),
        "thresholds": {
            "elbow_down": 155,   # arm extended
            "elbow_up":    45,   # arm fully curled
            "elbow_drift": 20,   # max allowed shoulder movement
        },
    },
    "lunge": {
        "angle_labels": ("Front knee", "Back knee"),
        "thresholds": {
            "knee_down":  100,   # front knee at bottom of lunge
            "knee_up":    160,   # standing
            "knee_max":    85,   # front knee shouldn't collapse past this
        },
    },
    "jumping_jack": {
        "angle_labels": ("Arm spread", "Leg spread"),
        "thresholds": {
            "arm_open":  120,   # arms above horizontal
            "arm_close":  30,   # arms at sides
            "leg_open":   40,   # legs spread apart
            "leg_close":  10,   # legs together
        },
    },
}

# ── FEEDBACK MESSAGES ────────────────────────────────────
# Keyed by exercise → issue tag → message shown in the UI.
FEEDBACK = {
    "squat": {
        "good":        ("good", "✓ Good rep — solid depth and form"),
        "too_shallow": ("warn", "Go deeper — aim past 90° at the knee"),
        "lean_forward":("warn", "Keep chest up — you're leaning too far forward"),
        "fast":        ("warn", "Slow down — control the descent"),
        "ready":       ("good", "Stand tall — ready for next rep"),
    },
    "pushup": {
        "good":        ("good", "✓ Clean rep — full range of motion"),
        "too_high":    ("warn", "Go lower — chest should near the floor"),
        "body_sag":    ("warn", "Hips sagging — brace your core"),
        "fast":        ("warn", "Slow it down — control both directions"),
        "ready":       ("good", "Plank position — ready to go"),
    },
    "curl": {
        "good":        ("good", "✓ Full contraction — nice squeeze at the top"),
        "partial":     ("warn", "Extend fully — arms should straighten at the bottom"),
        "elbow_drift": ("warn", "Keep elbows pinned — don't swing"),
        "fast":        ("warn", "Slow the negative — resist on the way down"),
        "ready":       ("good", "Arms extended — ready for next rep"),
    },
    "lunge": {
        "good":        ("good", "✓ Strong lunge — great knee alignment"),
        "too_shallow": ("warn", "Step deeper — front knee to 90°"),
        "knee_in":     ("warn", "Front knee caving — push outward"),
        "ready":       ("good", "Standing — step forward when ready"),
    },
    "jumping_jack": {
        "good":        ("good", "✓ Full jack — arms and legs in sync"),
        "arms_low":    ("warn", "Raise arms fully overhead"),
        "legs_close":  ("warn", "Spread legs wider on the jump"),
        "ready":       ("good", "Feet together — ready"),
    },
}


class ExerciseTracker:
    """
    Stateful per-exercise rep counter and form analyser.

    Called once per frame from app.py:
        rep_data = tracker.update(landmarks, exercise, sensitivity, frame)

    Returns a dict (or None if nothing to report yet):
        {
          new_rep:       bool,
          rep_count:     int,
          phase:         str,
          form_score:    int,   (0–100)
          feedback:      str,
          feedback_type: str,   ('good' | 'warn' | 'bad')
          angle1:        float,
          angle2:        float,
          confidence:    float,
        }
    """

    def __init__(self):
        self.exercise    = "squat"
        self.rep_count   = 0
        self.phase       = "up"      # "up" | "down"
        self.last_angles = {}
        self.form_issues = []        # issues collected during a rep
        self.rep_times   = []        # timestamps for pace detection

    # ── PUBLIC API ────────────────────────────────────────
    def reset(self, exercise: str):
        """Call this when the user switches exercise or starts a new session."""
        self.exercise    = exercise
        self.rep_count   = 0
        self.phase       = "up"
        self.last_angles = {}
        self.form_issues = []
        self.rep_times   = []

    def update(
        self,
        landmarks,
        exercise: str,
        sensitivity: str,
        frame: np.ndarray,
    ) -> dict | None:
        """
        Process one frame worth of landmarks and return rep/form data.

        Args:
            landmarks:   results.pose_landmarks.landmark  (list of 33 NormalisedLandmark)
            exercise:    current exercise key
            sensitivity: 'lenient' | 'normal' | 'strict'
            frame:       annotated BGR frame (will be drawn on in-place)

        Returns:
            dict with rep/form info, or None if nothing to report.
        """
        if exercise != self.exercise:
            self.reset(exercise)

        offset = SENSITIVITY_OFFSET.get(sensitivity, 0)

        # Dispatch to per-exercise analyser
        analysers = {
            "squat":        self._analyse_squat,
            "pushup":       self._analyse_pushup,
            "curl":         self._analyse_curl,
            "lunge":        self._analyse_lunge,
            "jumping_jack": self._analyse_jumping_jack,
        }
        analyser = analysers.get(exercise)
        if analyser is None:
            return None

        result = analyser(landmarks, frame, offset)
        if result is None:
            return None

        # Draw angle labels on the frame
        cfg = EXERCISE_CONFIG.get(exercise, {})
        labels = cfg.get("angle_labels", ("Angle 1", "Angle 2"))
        self._draw_angles(frame, result.get("angle1"), result.get("angle2"), labels)

        return result

    # ── SQUAT ─────────────────────────────────────────────
    def _analyse_squat(self, lm, frame, offset) -> dict:
        cfg = EXERCISE_CONFIG["squat"]["thresholds"]

        l_hip    = lm[LM.LEFT_HIP]
        l_knee   = lm[LM.LEFT_KNEE]
        l_ankle  = lm[LM.LEFT_ANKLE]
        l_shoulder = lm[LM.LEFT_SHOULDER]

        knee_angle = PoseEngine.angle(l_hip,   l_knee,    l_ankle)
        hip_angle  = PoseEngine.angle(l_shoulder, l_hip,  l_knee)

        # Visibility check — skip if landmarks not visible
        if l_knee.visibility < 0.5 or l_hip.visibility < 0.5:
            return None

        knee_down = cfg["knee_down"] + offset
        knee_up   = cfg["knee_up"]   - offset

        new_rep   = False
        issues    = []

        if knee_angle < knee_down:
            # Reached bottom position
            if self.phase == "up":
                self.phase = "down"
                self.form_issues = [] # Start a timer
# VALIDATION: 
    # 1. Rep must be faster than 4 seconds (Sitting usually lasts longer)
    # 2. Hip must have moved vertically (not just knees bending)
            # Check depth and lean
            if knee_angle > cfg["knee_down"] + 15 + offset:
                issues.append("too_shallow")

            torso_angle = PoseEngine.angle(
                lm[LM.LEFT_SHOULDER], lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE]
            )
            if torso_angle < (180 - cfg["back_max"] - offset):
                issues.append("lean_forward")

        elif knee_angle > knee_up and self.phase == "down":
            # Completed the upward drive — count the rep
            self.phase     = "up"
            self.rep_count += 1
            new_rep        = True
            self.rep_times.append(cv2.getTickCount())

        # Form score
        depth_score = max(0, min(100, int(
            100 - max(0, knee_angle - cfg["knee_down"]) * 2
        )))
        form_score  = depth_score if not issues else max(50, depth_score - 15 * len(issues))

        # Feedback
        if new_rep and not issues:
            fb_key = "good"
        elif issues:
            fb_key = issues[0]
        else:
            fb_key = "ready" if self.phase == "up" else "good"

        fb_type, fb_text = FEEDBACK["squat"].get(fb_key, ("good", ""))

        phase_label = "Standing" if self.phase == "up" else "Bottom — drive up"

        return {
            "new_rep":      new_rep,
            "rep_count":    self.rep_count,
            "phase":        phase_label,
            "form_score":   form_score,
            "feedback":     fb_text,
            "feedback_type": fb_type,
            "angle1":       knee_angle,
            "angle2":       hip_angle,
            "confidence":   float(l_knee.visibility),
        }

    # ── PUSH-UP ───────────────────────────────────────────
    def _analyse_pushup(self, lm, frame, offset) -> dict:
        cfg = EXERCISE_CONFIG["pushup"]["thresholds"]

        l_shoulder = lm[LM.LEFT_SHOULDER]
        l_elbow    = lm[LM.LEFT_ELBOW]
        l_wrist    = lm[LM.LEFT_WRIST]
        l_hip      = lm[LM.LEFT_HIP]
        l_ankle    = lm[LM.LEFT_ANKLE]

        if l_elbow.visibility < 0.5:
            return None

        elbow_angle = PoseEngine.angle(l_shoulder, l_elbow, l_wrist)
        body_angle  = PoseEngine.angle(l_shoulder, l_hip,   l_ankle)

        elbow_down = cfg["elbow_down"] + offset
        elbow_up   = cfg["elbow_up"]   - offset

        new_rep = False
        issues  = []

        if elbow_angle < elbow_down and self.phase == "up":
            self.phase       = "down"
            self.form_issues = []

        elif elbow_angle > elbow_up and self.phase == "down":
            self.phase     = "up"
            self.rep_count += 1
            new_rep        = True

        # Form checks
        if elbow_angle < elbow_down + 20 + offset:
            if body_angle < cfg["body_min"] - offset:
                issues.append("body_sag")

        depth_score = max(0, min(100, int(
            100 - max(0, elbow_angle - cfg["elbow_down"]) * 1.5
        )))
        form_score  = depth_score if not issues else max(50, depth_score - 20)

        if new_rep and not issues:
            fb_key = "good"
        elif issues:
            fb_key = issues[0]
        else:
            fb_key = "ready" if self.phase == "up" else "good"

        fb_type, fb_text = FEEDBACK["pushup"].get(fb_key, ("good", ""))

        phase_label = (
            "Top — lower down" if self.phase == "up"
            else "Bottom — push up"
        )

        return {
            "new_rep":       new_rep,
            "rep_count":     self.rep_count,
            "phase":         phase_label,
            "form_score":    form_score,
            "feedback":      fb_text,
            "feedback_type": fb_type,
            "angle1":        elbow_angle,
            "angle2":        body_angle,
            "confidence":    float(l_elbow.visibility),
        }

    # ── BICEP CURL ────────────────────────────────────────
    def _analyse_curl(self, lm, frame, offset) -> dict:
        cfg = EXERCISE_CONFIG["curl"]["thresholds"]

        # Use whichever arm is more visible
        l_vis = lm[LM.LEFT_ELBOW].visibility
        r_vis = lm[LM.RIGHT_ELBOW].visibility

        if l_vis >= r_vis:
            shoulder, elbow, wrist = lm[LM.LEFT_SHOULDER], lm[LM.LEFT_ELBOW],  lm[LM.LEFT_WRIST]
        else:
            shoulder, elbow, wrist = lm[LM.RIGHT_SHOULDER],lm[LM.RIGHT_ELBOW], lm[LM.RIGHT_WRIST]

        if elbow.visibility < 0.4:
            return None

        elbow_angle = PoseEngine.angle(shoulder, elbow, wrist)

        # Shoulder drift: compare current shoulder x to baseline
        baseline_x = getattr(self, "_curl_shoulder_baseline", shoulder.x)
        if not hasattr(self, "_curl_shoulder_baseline"):
            self._curl_shoulder_baseline = shoulder.x
        drift = abs(shoulder.x - baseline_x)

        elbow_down = cfg["elbow_down"] - offset
        elbow_up   = cfg["elbow_up"]   + offset

        new_rep = False
        issues  = []

        if elbow_angle > elbow_down and self.phase == "down":
            self.phase = "up"

        elif elbow_angle < elbow_up and self.phase == "up":
            self.phase       = "down"
            self.rep_count  += 1
            new_rep          = True
            # Reset shoulder baseline each rep
            self._curl_shoulder_baseline = shoulder.x

        if drift > 0.04:
            issues.append("elbow_drift")

        form_score = 90 if not issues else 65

        if new_rep and not issues:
            fb_key = "good"
        elif issues:
            fb_key = issues[0]
        else:
            fb_key = "ready" if elbow_angle > elbow_down - 20 else "good"

        fb_type, fb_text = FEEDBACK["curl"].get(fb_key, ("good", ""))

        phase_label = (
            "Extend arm down" if self.phase == "up"
            else "Curl up — squeeze"
        )

        return {
            "new_rep":       new_rep,
            "rep_count":     self.rep_count,
            "phase":         phase_label,
            "form_score":    form_score,
            "feedback":      fb_text,
            "feedback_type": fb_type,
            "angle1":        elbow_angle,
            "angle2":        round(drift * 100, 1),  # drift as %
            "confidence":    float(elbow.visibility),
        }

    # ── LUNGE ─────────────────────────────────────────────
    def _analyse_lunge(self, lm, frame, offset) -> dict:
        cfg = EXERCISE_CONFIG["lunge"]["thresholds"]

        l_hip   = lm[LM.LEFT_HIP]
        l_knee  = lm[LM.LEFT_KNEE]
        l_ankle = lm[LM.LEFT_ANKLE]
        r_hip   = lm[LM.RIGHT_HIP]
        r_knee  = lm[LM.RIGHT_KNEE]
        r_ankle = lm[LM.RIGHT_ANKLE]

        if l_knee.visibility < 0.5 or r_knee.visibility < 0.5:
            return None

        l_knee_angle = PoseEngine.angle(l_hip, l_knee, l_ankle)
        r_knee_angle = PoseEngine.angle(r_hip, r_knee, r_ankle)

        # The front knee is the one that bends more
        front_angle = min(l_knee_angle, r_knee_angle)
        back_angle  = max(l_knee_angle, r_knee_angle)

        knee_down = cfg["knee_down"] + offset
        knee_up   = cfg["knee_up"]   - offset

        new_rep = False
        issues  = []

        if front_angle < knee_down and self.phase == "up":
            self.phase       = "down"
            self.form_issues = []

        elif front_angle > knee_up and self.phase == "down":
            self.phase     = "up"
            self.rep_count += 1
            new_rep        = True

        if front_angle < cfg["knee_max"] - offset:
            issues.append("too_shallow")

        form_score = 85 if not issues else 60

        if new_rep and not issues:
            fb_key = "good"
        elif issues:
            fb_key = issues[0]
        else:
            fb_key = "ready"

        fb_type, fb_text = FEEDBACK["lunge"].get(fb_key, ("good", ""))

        phase_label = "Standing" if self.phase == "up" else "Step forward — lower down"

        return {
            "new_rep":       new_rep,
            "rep_count":     self.rep_count,
            "phase":         phase_label,
            "form_score":    form_score,
            "feedback":      fb_text,
            "feedback_type": fb_type,
            "angle1":        front_angle,
            "angle2":        back_angle,
            "confidence":    float((l_knee.visibility + r_knee.visibility) / 2),
        }

    # ── JUMPING JACK ──────────────────────────────────────
    def _analyse_jumping_jack(self, lm, frame, offset) -> dict:
        cfg = EXERCISE_CONFIG["jumping_jack"]["thresholds"]

        l_shoulder = lm[LM.LEFT_SHOULDER]
        l_elbow    = lm[LM.LEFT_ELBOW]
        l_hip      = lm[LM.LEFT_HIP]
        l_knee     = lm[LM.LEFT_KNEE]
        r_shoulder = lm[LM.RIGHT_SHOULDER]
        r_hip      = lm[LM.RIGHT_HIP]

        if l_shoulder.visibility < 0.5:
            return None

        # Arm spread: angle at shoulder (hip–shoulder–elbow)
        arm_angle = PoseEngine.angle(l_hip, l_shoulder, l_elbow)

        # Leg spread: horizontal distance between hips (normalised)
        leg_spread = abs(l_hip.x - r_hip.x) * 100  # as rough angle proxy

        arm_open  = cfg["arm_open"]  - offset
        arm_close = cfg["arm_close"] + offset

        new_rep = False
        issues  = []

        if arm_angle > arm_open and self.phase == "up":
            self.phase = "down"   # arms up = "open" position

        elif arm_angle < arm_close and self.phase == "down":
            self.phase     = "up"
            self.rep_count += 1
            new_rep        = True

        if arm_angle < arm_open - 15 and self.phase == "down":
            issues.append("arms_low")

        if leg_spread < cfg["leg_open"] - offset:
            issues.append("legs_close")

        form_score = 90 if not issues else 70

        if new_rep and not issues:
            fb_key = "good"
        elif issues:
            fb_key = issues[0]
        else:
            fb_key = "ready"

        fb_type, fb_text = FEEDBACK["jumping_jack"].get(fb_key, ("good", ""))

        phase_label = "Open — arms up" if self.phase == "down" else "Close — feet together"

        return {
            "new_rep":       new_rep,
            "rep_count":     self.rep_count,
            "phase":         phase_label,
            "form_score":    form_score,
            "feedback":      fb_text,
            "feedback_type": fb_type,
            "angle1":        arm_angle,
            "angle2":        round(leg_spread, 1),
            "confidence":    float(l_shoulder.visibility),
        }

    # ── FRAME ANNOTATION ─────────────────────────────────
    def _draw_angles(
        self,
        frame: np.ndarray,
        angle1: float | None,
        angle2: float | None,
        labels: tuple,
    ) -> None:
        """
        Draw the two angle readout pills in the bottom corners of the frame.
        Matches the .angle-pill positions defined in main.css.
        """
        h, w = frame.shape[:2]
        pill_w, pill_h = 120, 52
        pad = 28

        def draw_pill(x, y, label, value):
            # Background pill
            cv2.rectangle(
                frame,
                (x, y),
                (x + pill_w, y + pill_h),
                (26, 26, 26),
                -1,
            )
            cv2.rectangle(
                frame,
                (x, y),
                (x + pill_w, y + pill_h),
                (60, 60, 60),
                1,
            )
            # Value
            val_str = f"{value:.0f}" + ("\xb0" if value < 360 else "")
            cv2.putText(
                frame, val_str,
                (x + 10, y + 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (53, 241, 200), 2, cv2.LINE_AA,
            )
            # Label
            cv2.putText(
                frame, label,
                (x + 10, y + 46),
                cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                (150, 150, 150), 1, cv2.LINE_AA,
            )

        if angle1 is not None:
            draw_pill(pad, h // 2 - pill_h // 2, labels[0], angle1)
        if angle2 is not None:
            draw_pill(w - pad - pill_w, h // 2 - pill_h // 2, labels[1], angle2)