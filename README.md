# FormAI — Virtual Fitness Trainer

> An AI-powered web application that uses your webcam and pose detection to track exercises, count reps, score your form, and coach you in real time.

---

## What it does

FormAI watches you work out through your webcam. It detects your body position using MediaPipe, counts your reps automatically, scores your form on every rep, and gives you live coaching feedback — all running locally on your machine with no cloud subscription required.

**Supported exercises:**
- Squats
- Push-ups
- Bicep Curls
- Lunges
- Jumping Jacks

**Features:**
- Live pose detection with skeleton overlay on the camera feed
- Automatic rep counting and set tracking
- Per-rep form scoring (0–100) with a visual ring display
- Real-time coach feedback with smart deduplication (e.g. "Go deeper x3")
- Joint angle overlays (e.g. knee angle, hip angle) on the camera
- Pose confidence indicator
- Rep beep sound
- Daily challenge per exercise
- Session timer and calorie estimate
- User accounts — multiple users on the same device with separate data
- Streak tracking (daily workout streak)
- XP level system based on total all-time reps
- Badge system (First Set, 10-Streak, 50 Reps, Elite Form, 7-Day streak, 25 Perfect)
- Workout history (last 60 sessions per user)
- Profile tab with all-time stats, progress charts, and exercise breakdown
- Settings: angle overlays, beep, camera resolution, form sensitivity

---

## Project structure

```
FormAI/
├── BackEnd/
│   ├── index.py              ← Flask + Flask-SocketIO server
│   ├── pose_engine.py      ← MediaPipe pose detection wrapper
│   ├── exercises.py        ← Rep counting and form analysis per exercise
│   └── sessions.json       ← Auto-created on first run (server-side session log)
│
└── FrontEnd/
    ├── HTML/
    │   └── index.html      ← Single-page app
    ├── Script/
    │   └── app.js          ← All frontend logic
    └── Styles/
        └── main.css        ← All styles
```

---

## Requirements

- Python 3.9 or higher
- A webcam
- A modern browser (Chrome or Edge recommended)
- Git (optional, for cloning)

---

## Installation

**1. Clone the repository**
```bash
git clone https://github.com/yourusername/FormAI.git
cd FormAI
```

**2. Create and activate a virtual environment**
```bash
# Windows
python -m venv .venv
.venv\Scripts\activate

# Mac / Linux
python -m venv .venv
source .venv/bin/activate
```

**3. Install Python dependencies**
```bash
pip install flask flask-socketio opencv-python mediapipe
```

**4. Start the backend**
```bash
cd BackEnd
python index.py
```

You should see:
```
====================================================
  FormAI — Virtual Fitness Trainer
  Tracking available : True
  Open : http://localhost:5000
====================================================
```

**5. Open the app**

Go to **http://localhost:5000** in your browser.

---

## How to use

1. **Create an account** — enter a username and password on the login screen. Multiple accounts can exist on the same device.
2. **Select an exercise** — click one of the five exercise buttons in the left panel.
3. **Press Start Session** — your webcam activates and pose tracking begins.
4. **Work out** — reps are counted automatically. The form score ring and coach feedback update in real time.
5. **Press Stop Session** — your session is saved and a summary is shown.
6. **View your history** — click the History tab to see past sessions.
7. **View your profile** — click the Profile tab for all-time stats, badges, charts, and your level.

---

## Configuration

**Form sensitivity** can be adjusted in Settings (⚙ icon → user menu):
- **Lenient** — angle thresholds are ±10° more forgiving
- **Normal** — default thresholds
- **Strict** — angle thresholds are ±10° more demanding

**Camera resolution** can also be set in Settings (480p / 720p / 1080p).

---

## How pose detection works

```
Webcam (OpenCV)
      ↓
pose_engine.py  — MediaPipe Pose Landmarker (lite model, ~7 MB)
      ↓
exercises.py    — angle calculation → rep state machine → form score
      ↓
index.py          — Flask-SocketIO emits rep_data to browser
      ↓
app.js          — updates HUD, charts, badges, storage
```

The MediaPipe model file (`pose_landmarker.task`) is downloaded automatically on first run (~7 MB) and saved in the `BackEnd/` folder.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend server | Python, Flask, Flask-SocketIO |
| Pose detection | MediaPipe Tasks (PoseLandmarker) |
| Camera input | OpenCV |
| Video stream | MJPEG over HTTP (`/video_feed`) |
| Real-time comms | WebSocket (Socket.IO) |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Data storage | Browser localStorage (per user) |
| Fonts | Bebas Neue, DM Sans (Google Fonts) |

---

## Adding a new exercise

1. Add an entry to `EXERCISE_CONFIG` in `BackEnd/exercises.py`
2. Add an `_analyse_yourexercise` method to the `ExerciseTracker` class in `exercises.py`
3. Add the exercise to the `EXERCISES` object in `FrontEnd/Script/app.js`
4. Add an exercise button in `FrontEnd/HTML/index.html`

---

## Known limitations

- Pose tracking requires good lighting and a clear view of your full body
- The account system is client-side only (localStorage) — data does not sync across devices or browsers
- Only one person can be tracked at a time
- The MJPEG stream requires the backend to be running on the same machine as the browser

---

## License

MIT License — free to use, modify, and distribute.

---

## Authors

A. Brown, T. Jacobs, T. Robinson, J. Johnson

Built with FormAI. Powered by MediaPipe, Flask, and Socket.IO.
