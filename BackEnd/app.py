"""
═══════════════════════════════════════════════════════════
  FormAI — Virtual Fitness Trainer
  BackEnd/app.py  ·  Flask + Flask-SocketIO backend
═══════════════════════════════════════════════════════════

  Folder layout expected:
    <project>/
    ├── BackEnd/
    │   ├── app.py            ← this file
    │   ├── pose_engine.py    ← created next
    │   ├── exercises.py      ← created next
    │   └── sessions.json     ← auto-created on first run
    └── FrontEnd/
        ├── HTML/
        │   └── index.html
        ├── Script/
        │   └── app.js
        └── Styles/
            └── main.css

  Run:
      cd BackEnd
      pip install -r requirements.txt
      python app.py

  Then open:  http://localhost:5000
═══════════════════════════════════════════════════════════
"""

import json
import time
import threading
import datetime
from pathlib import Path

import cv2
from flask import Flask, Response, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit


# ── PATHS ────────────────────────────────────────────────
BACKEND_DIR   = Path(__file__).parent        # <project>/BackEnd/
ROOT_DIR      = BACKEND_DIR.parent           # <project>/
FRONTEND_DIR  = ROOT_DIR  / "FrontEnd"
TEMPLATES_DIR = FRONTEND_DIR / "HTML"        # index.html lives here
SCRIPT_DIR    = FRONTEND_DIR / "Script"      # app.js lives here
STYLES_DIR    = FRONTEND_DIR / "Styles"      # main.css lives here
SESSIONS_FILE = BACKEND_DIR / "sessions.json"


# ── OPTIONAL TRACKING MODULES ────────────────────────────
# pose_engine.py and exercises.py live in BackEnd/ alongside
# this file. Until they are created the app runs in demo mode
# — the UI fully loads and all buttons work, but the webcam
# feed and automatic rep counting are inactive.
try:
    from pose_engine import PoseEngine
    from exercises import ExerciseTracker
    TRACKING_AVAILABLE = True
    print("[FormAI] Tracking modules loaded OK")
except ImportError:
    TRACKING_AVAILABLE = False
    print("[FormAI] pose_engine / exercises not found — running in demo mode")


# ── FLASK APP ────────────────────────────────────────────
app = Flask(
    __name__,
    template_folder=str(TEMPLATES_DIR),  # render_template looks here
    static_folder=str(SCRIPT_DIR),       # url_for('static') resolves here
    static_url_path="/script",           # served at  /script/app.js
)
app.config["SECRET_KEY"] = "formai-secret-change-in-production"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


# ── GLOBAL STATE ─────────────────────────────────────────
class AppState:
    """Thread-safe shared state between the camera thread and SocketIO events."""

    def __init__(self):
        self.lock             = threading.Lock()
        self.is_tracking      = False
        self.current_exercise = "squat"
        self.sensitivity      = "normal"   # lenient | normal | strict
        self.cap              = None       # cv2.VideoCapture instance
        self.latest_frame     = None       # most recent JPEG bytes
        self.frame_event      = threading.Event()

        # Session accumulators (reset each time Start is pressed)
        self.session_reps  = 0
        self.session_sets  = 0
        self.session_start = None
        self.form_scores   = []

        # Tracking objects (only initialised when modules are available)
        if TRACKING_AVAILABLE:
            self.pose_engine = PoseEngine()
            self.tracker     = ExerciseTracker()
        else:
            self.pose_engine = None
            self.tracker     = None

    # ── control helpers ───────────────────────────────────
    def start(self, exercise: str):
        with self.lock:
            self.is_tracking      = True
            self.current_exercise = exercise
            self.session_start    = time.time()
            self.session_reps     = 0
            self.session_sets     = 0
            self.form_scores      = []
            if self.tracker:
                self.tracker.reset(exercise)
            if self.cap is None or not self.cap.isOpened():
                self.cap = cv2.VideoCapture(0)
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    def pause(self):
        with self.lock:
            self.is_tracking = False

    def stop(self):
        with self.lock:
            self.is_tracking = False
            if self.cap and self.cap.isOpened():
                self.cap.release()
            self.cap = None

    def change_exercise(self, exercise: str):
        with self.lock:
            self.current_exercise = exercise
            if self.tracker:
                self.tracker.reset(exercise)

    def snapshot(self) -> dict:
        """Return a lightweight copy of state — avoids holding the lock."""
        with self.lock:
            return {
                "is_tracking":      self.is_tracking,
                "current_exercise": self.current_exercise,
                "sensitivity":      self.sensitivity,
                "session_reps":     self.session_reps,
                "session_sets":     self.session_sets,
            }


g = AppState()


# ── CAMERA THREAD ─────────────────────────────────────────
def camera_loop():
    """
    Runs forever as a daemon thread.
    Reads webcam frames → pose detection → annotation →
    stores JPEG for MJPEG stream → emits rep_data to browsers.
    """
    while True:
        snap = g.snapshot()

        if not snap["is_tracking"] or g.cap is None:
            time.sleep(0.05)
            continue

        ret, frame = g.cap.read()
        if not ret:
            time.sleep(0.05)
            continue

        # Mirror so it feels like a selfie camera
        frame     = cv2.flip(frame, 1)
        annotated = frame.copy()
        rep_data  = None

        if TRACKING_AVAILABLE and g.pose_engine and g.tracker:
            landmarks, annotated = g.pose_engine.process(frame)

            if landmarks:
                rep_data = g.tracker.update(
                    landmarks   = landmarks,
                    exercise    = snap["current_exercise"],
                    sensitivity = snap["sensitivity"],
                    frame       = annotated,
                )
            else:
                socketio.emit("pose_lost", {})

        # Update session state and push to browsers
        if rep_data:
            with g.lock:
                if rep_data.get("new_rep"):
                    g.session_reps += 1
                    if g.session_reps % 10 == 0:
                        g.session_sets += 1
                score = rep_data.get("form_score", 80)
                g.form_scores.append(score)
                rep_data["session_reps"] = g.session_reps

            socketio.emit("rep_data", rep_data)

        # Store latest JPEG for the MJPEG stream
        _, jpeg = cv2.imencode(
            ".jpg", annotated,
            [cv2.IMWRITE_JPEG_QUALITY, 80],
        )
        with g.lock:
            g.latest_frame = jpeg.tobytes()
        g.frame_event.set()
        g.frame_event.clear()

        time.sleep(1 / 30)   # ~30 fps


cam_thread = threading.Thread(target=camera_loop, daemon=True)
cam_thread.start()


# ── MJPEG HELPERS ─────────────────────────────────────────
def _blank_jpeg() -> bytes:
    """Small black frame returned while waiting for the first real frame."""
    import numpy as np
    img = np.zeros((480, 640, 3), dtype="uint8")
    _, jpeg = cv2.imencode(".jpg", img)
    return jpeg.tobytes()


def generate_frames():
    """Generator that yields a continuous MJPEG stream to the browser."""
    while True:
        g.frame_event.wait(timeout=0.5)
        with g.lock:
            frame = g.latest_frame

        if frame is None:
            frame = _blank_jpeg()
            time.sleep(0.1)

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        )


# ── ROUTES ───────────────────────────────────────────────
@app.route("/")
def index():
    """Serve FrontEnd/HTML/index.html."""
    return render_template("index.html")


@app.route("/styles/<path:filename>")
def serve_styles(filename):
    """Serve CSS files from FrontEnd/Styles/."""
    return send_from_directory(str(STYLES_DIR), filename)


@app.route("/video_feed")
def video_feed():
    """
    MJPEG stream consumed by the <img id='camera-feed'> in index.html.
    Optional query param: ?exercise=squat
    """
    exercise = request.args.get("exercise", g.current_exercise)
    with g.lock:
        g.current_exercise = exercise
    return Response(
        generate_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


# ── SESSION PERSISTENCE ───────────────────────────────────
def load_sessions() -> list:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def save_sessions(sessions: list):
    try:
        SESSIONS_FILE.write_text(json.dumps(sessions, indent=2))
    except OSError as exc:
        print(f"[FormAI] Could not save sessions: {exc}")


@app.route("/api/sessions", methods=["GET"])
def api_get_sessions():
    """Return all saved sessions as JSON."""
    return jsonify(load_sessions())


@app.route("/api/sessions", methods=["POST"])
def api_save_session():
    """
    Save a session record POSTed from the browser.
    Body: { exercise, reps, sets, calories, duration, formScore }
    """
    data = request.get_json(silent=True) or {}
    sessions = load_sessions()
    session = {
        "id":        int(time.time() * 1000),
        "date":      datetime.datetime.utcnow().isoformat() + "Z",
        "exercise":  data.get("exercise", "unknown"),
        "reps":      int(data.get("reps", 0)),
        "sets":      int(data.get("sets", 0)),
        "calories":  int(data.get("calories", 0)),
        "duration":  int(data.get("duration", 0)),
        "formScore": int(data.get("formScore", 0)),
    }
    sessions.insert(0, session)
    save_sessions(sessions[:60])
    return jsonify({"status": "ok", "session": session}), 201


@app.route("/api/sessions", methods=["DELETE"])
def api_clear_sessions():
    """Wipe all saved sessions."""
    save_sessions([])
    return jsonify({"status": "cleared"})


@app.route("/api/status")
def api_status():
    """
    Health-check endpoint.
    Open http://localhost:5000/api/status in your browser to verify
    the backend is running and see current tracking state.
    """
    snap = g.snapshot()
    return jsonify({
        "status":           "running",
        "tracking_modules": TRACKING_AVAILABLE,
        "is_tracking":      snap["is_tracking"],
        "exercise":         snap["current_exercise"],
        "session_reps":     snap["session_reps"],
        "session_sets":     snap["session_sets"],
    })


# ── SOCKETIO EVENTS ───────────────────────────────────────
@socketio.on("connect")
def on_connect():
    print(f"[FormAI] Client connected   : {request.sid}")
    emit("status", {
        "message":          "Connected to FormAI backend",
        "tracking_modules": TRACKING_AVAILABLE,
    })


@socketio.on("disconnect")
def on_disconnect():
    print(f"[FormAI] Client disconnected: {request.sid}")


@socketio.on("start_tracking")
def on_start_tracking(data):
    """Browser → { exercise: 'squat' }  ·  Starts webcam + processing."""
    exercise = data.get("exercise", "squat")
    print(f"[FormAI] Start tracking — {exercise}")
    g.start(exercise)
    emit("tracking_started", {"exercise": exercise})


@socketio.on("pause_tracking")
def on_pause_tracking():
    print("[FormAI] Paused")
    g.pause()
    emit("tracking_paused", {})


@socketio.on("stop_tracking")
def on_stop_tracking():
    """
    Browser sends this on 'End session'.
    Computes summary, saves to sessions.json, emits back to browser.
    """
    print("[FormAI] Session ended")
    with g.lock:
        reps     = g.session_reps
        sets     = g.session_sets
        scores   = g.form_scores[:]
        started  = g.session_start
        exercise = g.current_exercise
    g.stop()

    duration = int(time.time() - started) if started else 0
    avg_form = int(sum(scores) / len(scores)) if scores else 0
    calories = int(reps * 0.35 + duration * 0.04)

    summary = {
        "exercise":  exercise,
        "reps":      reps,
        "sets":      sets,
        "calories":  calories,
        "duration":  duration,
        "formScore": avg_form,
    }

    sessions = load_sessions()
    sessions.insert(0, {
        "id":   int(time.time() * 1000),
        "date": datetime.datetime.utcnow().isoformat() + "Z",
        **summary,
    })
    save_sessions(sessions[:60])

    emit("session_summary", summary)


@socketio.on("change_exercise")
def on_change_exercise(data):
    exercise = data.get("exercise", "squat")
    print(f"[FormAI] Exercise changed → {exercise}")
    g.change_exercise(exercise)
    emit("exercise_changed", {"exercise": exercise})


@socketio.on("update_settings")
def on_update_settings(data):
    """Browser → { sensitivity: 'normal' }"""
    sensitivity = data.get("sensitivity", "normal")
    with g.lock:
        g.sensitivity = sensitivity
    print(f"[FormAI] Sensitivity → {sensitivity}")
    emit("settings_updated", {"sensitivity": sensitivity})
 #Schedule event 
SCHEDULE_FILE = BACKEND_DIR / "schedule.json"

def load_schedule():
    if SCHEDULE_FILE.exists():
        return json.loads(SCHEDULE_FILE.read_text())
    return {day: [] for day in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]}

def save_schedule(data):
    SCHEDULE_FILE.write_text(json.dumps(data, indent=2))

# --- New Routes ---

@app.route("/api/schedule", methods=["GET"])
def get_schedule():
    return jsonify(load_schedule())

@app.route("/api/schedule", methods=["POST"])
def update_schedule():
    """Body: { "day": "Monday", "exercises": ["squat", "pushup"] }"""
    data = request.get_json()
    day = data.get("day")
    exercises = data.get("exercises", [])
    
    full_schedule = load_schedule()
    if day in full_schedule:
        full_schedule[day] = exercises
        save_schedule(full_schedule)
        return jsonify({"status": "success"})
    return jsonify({"status": "error", "message": "Invalid day"}), 400

@app.route("/api/schedule/today")
def get_today_schedule():
    import datetime
    day_name = datetime.datetime.now().strftime("%A")
    full_schedule = load_schedule() # Uses your load_schedule function
    return jsonify({
        "day": day_name, 
        "exercises": full_schedule.get(day_name, [])
    })

# ── ENTRY POINT ───────────────────────────────────────────
if __name__ == "__main__": 
    print("=" * 52)
    print("  FormAI — Virtual Fitness Trainer")
    print(f"  Tracking available : {TRACKING_AVAILABLE}")
    print("  Open : http://localhost:5000")
    print("=" * 52)
    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=True,
        use_reloader=False,          # reloader would restart camera thread
        allow_unsafe_werkzeug=True,
    ) 
   