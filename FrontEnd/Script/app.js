/* ═══════════════════════════════════════════════════════════
   FormAI — Virtual Fitness Trainer
   static/js/app.js
   ═══════════════════════════════════════════════════════════

   Responsibilities:
   - WebSocket connection to Flask-SocketIO backend
   - Camera feed display (MJPEG stream from /video_feed)
   - UI state management (reps, timer, score, feedback)
   - localStorage persistence (history, settings, streaks)
   - Progress charts (canvas-based, no external deps)
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ── EXERCISE CONFIG ────────────────────────────────────── */
const EXERCISES = {
  squat: {
    label:        'Squats',
    angleLabel1:  'Knee angle',
    angleLabel2:  'Hip angle',
    challenge:    'Squat Burn',
    challengeDesc:'Complete 50 squats with 80%+ form score.',
    challengeGoal: 50,
    calPerRep:    0.32,
    feedback: [
      { type: 'good', text: '<strong>Depth looks great</strong> — knee angle in target zone' },
      { type: 'warn', text: '<strong>Go deeper</strong> — aim for 90° at the knee' },
      { type: 'good', text: '<strong>Knees tracking</strong> over toes — excellent' },
      { type: 'warn', text: '<strong>Keep chest up</strong> — avoid rounding forward' },
      { type: 'good', text: '<strong>Strong drive up</strong> — great power phase' },
    ],
  },
  pushup: {
    label:        'Push-ups',
    angleLabel1:  'Elbow angle',
    angleLabel2:  'Body angle',
    challenge:    'Push Day',
    challengeDesc:'Complete 25 push-ups with a straight spine.',
    challengeGoal: 25,
    calPerRep:    0.45,
    feedback: [
      { type: 'good', text: '<strong>Core is braced</strong> — solid plank position' },
      { type: 'warn', text: '<strong>Go lower</strong> — chest should near the floor' },
      { type: 'good', text: '<strong>Elbow flare minimal</strong> — protecting shoulders' },
      { type: 'warn', text: '<strong>Hips sagging</strong> — squeeze glutes to stabilise' },
      { type: 'good', text: '<strong>Full lockout</strong> — nice range of motion' },
    ],
  },
  curl: {
    label:        'Bicep Curls',
    angleLabel1:  'Elbow angle',
    angleLabel2:  'Wrist angle',
    challenge:    'Arm Pump',
    challengeDesc:'Complete 30 bicep curls with full range of motion.',
    challengeGoal: 30,
    calPerRep:    0.22,
    feedback: [
      { type: 'good', text: '<strong>Full range</strong> — arms fully extending each rep' },
      { type: 'good', text: '<strong>Elbows pinned</strong> — great isolation' },
      { type: 'warn', text: '<strong>Slow the negative</strong> — control the descent' },
      { type: 'warn', text: '<strong>Elbow drifting</strong> — keep upper arm still' },
    ],
  },
  lunge: {
    label:        'Lunges',
    angleLabel1:  'Front knee',
    angleLabel2:  'Back knee',
    challenge:    'Lunge Circuit',
    challengeDesc:'Complete 20 alternating lunges with balanced knee alignment.',
    challengeGoal: 20,
    calPerRep:    0.38,
    feedback: [
      { type: 'good', text: '<strong>Step length good</strong> — 90° front knee at bottom' },
      { type: 'warn', text: '<strong>Back knee lower</strong> — get closer to floor' },
      { type: 'good', text: '<strong>Torso upright</strong> — great drive up' },
    ],
  },
  jumping_jack: {
    label:        'Jumping Jacks',
    angleLabel1:  'Arm angle',
    angleLabel2:  'Leg spread',
    challenge:    'Cardio Blast',
    challengeDesc:'Complete 60 jumping jacks without stopping.',
    challengeGoal: 60,
    calPerRep:    0.18,
    feedback: [
      { type: 'good', text: '<strong>Arms overhead</strong> — good range' },
      { type: 'warn', text: '<strong>Land softly</strong> — bend knees on landing' },
      { type: 'good', text: '<strong>Rhythm steady</strong> — nice pace' },
    ],
  },
};

/* ── STATE ──────────────────────────────────────────────── */
const state = {
  currentExercise: 'squat',
  reps:            0,         // reps this set
  totalReps:       0,         // reps this session
  sets:            0,
  calories:        0,
  formScores:      [],        // collect to compute avg
  formScore:       80,
  isRunning:       false,
  voiceOn:         false,
  timerSeconds:    0,
  targetSets:      3,
  targetReps:      10,

  // Timestamps
  sessionStart:    null,

  // Settings
  settings: {
    voice:       false,
    angles:      true,
    beep:        true,
    resolution:  '720',
    sensitivity: 'normal',
    username:    '',
  },

  // Streak
  streak: 0,
  lastSessionDate: null,
};

/* ── TIMER ──────────────────────────────────────────────── */
let timerInterval = null;

function startTimer() {
  timerInterval = setInterval(() => {
    state.timerSeconds++;
    updateTimerDisplay();
    // Calories tick
    state.calories = Math.round(state.totalReps * (EXERCISES[state.currentExercise].calPerRep) + state.timerSeconds * 0.04);
    el('stat-cal').textContent = state.calories;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimerDisplay() {
  const m = String(Math.floor(state.timerSeconds / 60)).padStart(2, '0');
  const s = String(state.timerSeconds % 60).padStart(2, '0');
  el('timer-display').textContent = `${m}:${s}`;
}

/* ── WEBSOCKET ──────────────────────────────────────────── */
let socket = null;

function initSocket() {
  // SocketIO connects to same host/port as Flask
  if (typeof io === 'undefined') {
    console.warn('SocketIO not loaded — running in demo mode');
    return;
  }

  socket = io();

  socket.on('connect', () => {
    console.log('Connected to FormAI backend');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from backend');
    setFeedback('Connection lost — reconnecting…', 'warn');
  });

  // Received rep data from backend
  socket.on('rep_data', (data) => {
    /*
      Expected shape:
      {
        exercise:    string,
        rep_count:   int,
        phase:       string,
        form_score:  int (0–100),
        feedback:    string,
        feedback_type: 'good' | 'warn' | 'bad',
        angle1:      float,
        angle2:      float,
        confidence:  float (0–1),
      }
    */
    handleRepData(data);
  });

  socket.on('pose_lost', () => {
    setFeedback('Pose not detected — move into frame', 'warn');
    el('hud-phase').textContent = 'No pose detected';
  });
}

function handleRepData(data) {
  // Rep count
  if (data.rep_count !== undefined && data.rep_count > state.reps) {
    const diff = data.rep_count - state.reps;
    state.reps       += diff;
    state.totalReps  += diff;
    onRepCompleted();
  }

  // Phase
  if (data.phase) el('hud-phase').textContent = data.phase;

  // Form score
  if (data.form_score !== undefined) {
    state.formScore = data.form_score;
    state.formScores.push(data.form_score);
    updateFormScore(data.form_score);
  }

  // Angles
  if (data.angle1 !== undefined) {
    el('angle-val-left').textContent  = Math.round(data.angle1) + '°';
    el('angle-val-right').textContent = Math.round(data.angle2) + '°';
  }

  // Pose confidence bar
  if (data.confidence !== undefined) {
    const pct = Math.round(data.confidence * 100);
    el('confidence-fill').style.width = pct + '%';
    el('confidence-wrap').style.display = 'block';
  }

  // Coach feedback
  if (data.feedback) {
    setFeedback(data.feedback, data.feedback_type || 'good');
    pushFeedbackItem(data.feedback, data.feedback_type || 'good');
  }
}

/* ── WORKOUT CONTROL ────────────────────────────────────── */
function toggleWorkout() {
  if (!state.isRunning) {
    startWorkout();
  } else {
    pauseWorkout();
  }
}

function startWorkout() {
  state.isRunning = true;
  state.sessionStart = state.sessionStart || Date.now();

  // Update UI
  el('start-btn-label').textContent = '⏸ Pause';
  el('timer-display').classList.add('running');
  el('camera-waiting').style.display = 'none';
  el('live-indicator').style.display = 'flex';

  // Start MJPEG stream
  const feed = el('camera-feed');
  feed.src = `/video_feed?exercise=${state.currentExercise}`;
  feed.style.display = 'block';

  // Notify backend
  if (socket) socket.emit('start_tracking', { exercise: state.currentExercise });

  startTimer();
  updateStats();
}

function pauseWorkout() {
  state.isRunning = false;
  el('start-btn-label').textContent = '▶ Resume';
  el('timer-display').classList.remove('running');
  stopTimer();
  if (socket) socket.emit('pause_tracking');
}

function resetCurrentSet() {
  state.reps = 0;
  el('hud-rep-num').textContent = '0';
  el('hud-phase').textContent = 'Ready — stand in frame';
  updateChallenge();
}

function endSession() {
  if (state.isRunning) pauseWorkout();

  // Stop feed
  el('camera-feed').src = '';
  el('camera-feed').style.display = 'none';
  el('camera-waiting').style.display = 'flex';
  el('live-indicator').style.display = 'none';
  el('start-btn-label').textContent = '▶ Start';
  el('timer-display').classList.remove('running');

  if (socket) socket.emit('stop_tracking');

  if (state.totalReps === 0) return; // Nothing to save

  saveSession();
  showSummary();
  updateStreak();
  awardBadges();
}

/* ── REP EVENTS ─────────────────────────────────────────── */
function onRepCompleted() {
  // Flash animation
  const numEl = el('hud-rep-num');
  numEl.textContent = state.reps;
  numEl.classList.remove('flash');
  void numEl.offsetWidth; // reflow
  numEl.classList.add('flash');

  // Beep
  if (state.settings.beep) playBeep();

  // Voice
  if (state.settings.voice && state.voiceOn) speakRep(state.reps);

  // Set logic
  if (state.reps >= state.targetReps) {
    state.sets++;
    state.reps = 0;
    el('hud-phase').textContent = `Set ${state.sets} complete! Rest…`;
    if (state.settings.voice && state.voiceOn) speak(`Set ${state.sets} complete. Rest up.`);
  }

  updateStats();
  updateChallenge();
  checkBadgeProgress();
}

/* ── STATS UPDATE ───────────────────────────────────────── */
function updateStats() {
  el('stat-reps').textContent = state.totalReps;
  el('stat-cal').textContent  = state.calories;
  el('stat-sets').textContent = state.sets;

  const avg = state.formScores.length
    ? Math.round(state.formScores.reduce((a, b) => a + b, 0) / state.formScores.length)
    : null;
  el('stat-acc').textContent = avg !== null ? avg + '%' : '—';
}

/* ── FORM SCORE ─────────────────────────────────────────── */
function updateFormScore(score) {
  el('score-num').textContent = score;

  const circumference = 314; // 2πr where r=50
  const offset = Math.round(circumference - (score / 100) * circumference);
  const ring = el('score-ring-fill');
  ring.setAttribute('stroke-dashoffset', offset);

  // Color & grade
  let color, grade;
  if (score >= 90) { color = '#c8f135'; grade = 'Excellent'; }
  else if (score >= 75) { color = '#c8f135'; grade = 'Good'; }
  else if (score >= 55) { color = '#ff8c00'; grade = 'Fair'; }
  else { color = '#ff4040'; grade = 'Needs work'; }

  ring.style.stroke = color;
  el('score-num').style.color = color;
  el('score-grade').textContent = grade;
}

/* ── FEEDBACK ───────────────────────────────────────────── */
function setFeedback(text, type = 'good') {
  const el2 = el('hud-feedback');
  el2.textContent = (type === 'good' ? '✓ ' : type === 'warn' ? '⚠ ' : '✗ ') + text;
  el2.className = 'hud-feedback ' + type;
}

function pushFeedbackItem(text, type) {
  const list = el('feedback-list');
  const item = document.createElement('div');
  item.className = 'feedback-item';
  item.innerHTML = `
    <div class="fi-dot ${type}"></div>
    <div class="fi-text">${text}</div>
  `;
  // Keep max 5 items
  if (list.children.length >= 5) list.removeChild(list.firstChild);
  list.appendChild(item);
}

/* ── EXERCISE SWITCH ────────────────────────────────────── */
function setExercise(exKey, btn) {
  state.currentExercise = exKey;
  state.reps = 0;

  // Update active button
  document.querySelectorAll('.exercise-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const ex = EXERCISES[exKey];

  // Angle labels
  el('angle-lbl-left').textContent  = ex.angleLabel1;
  el('angle-lbl-right').textContent = ex.angleLabel2;

  // Challenge
  el('challenge-name').textContent = ex.challenge;
  el('challenge-desc').textContent = ex.challengeDesc;

  // Reset rep display
  el('hud-rep-num').textContent  = '0';
  el('hud-phase').textContent    = 'Ready — stand in frame';
  el('hud-feedback').textContent = 'Waiting for pose detection…';
  el('hud-feedback').className   = 'hud-feedback';

  // Notify backend
  if (socket && state.isRunning) {
    socket.emit('change_exercise', { exercise: exKey });
    el('camera-feed').src = `/video_feed?exercise=${exKey}`;
  }

  updateChallenge();
  loadExerciseFeedback(ex);
}

function loadExerciseFeedback(ex) {
  const list = el('feedback-list');
  list.innerHTML = ex.feedback.map(f => `
    <div class="feedback-item">
      <div class="fi-dot ${f.type}"></div>
      <div class="fi-text">${f.text}</div>
    </div>
  `).join('');
}

/* ── CHALLENGE ──────────────────────────────────────────── */
function updateChallenge() {
  const goal = EXERCISES[state.currentExercise].challengeGoal;
  const pct  = Math.min(100, Math.round(state.totalReps / goal * 100));
  el('challenge-fill').style.width   = pct + '%';
  el('challenge-count').textContent  = `${state.totalReps} / ${goal} reps`;
  el('challenge-pct').textContent    = pct + '%';
}

/* ── SET TARGET ─────────────────────────────────────────── */
function adjustTarget(delta) {
  state.targetSets = Math.max(1, Math.min(10, state.targetSets + delta));
  el('target-display').textContent = `${state.targetSets} sets × ${state.targetReps} reps`;
}

/* ── VOICE ──────────────────────────────────────────────── */
function toggleVoice() {
  state.voiceOn = !state.voiceOn;
  el('voice-btn').textContent = state.voiceOn ? '🔊 Voice on' : '🔇 Voice off';
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 1.1;
  utt.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utt);
}

function speakRep(count) {
  speak(String(count));
}

/* ── BEEP ───────────────────────────────────────────────── */
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch (e) { /* silence */ }
}

/* ── TABS ───────────────────────────────────────────────── */
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  el('tab-' + tabId).classList.add('active');
  btn.classList.add('active');

  if (tabId === 'history') renderHistory();
  if (tabId === 'progress') renderProgress();
}

/* ── LOCAL STORAGE ──────────────────────────────────────── */
const STORAGE_KEY_SESSIONS  = 'formai_sessions';
const STORAGE_KEY_SETTINGS  = 'formai_settings';
const STORAGE_KEY_STREAK    = 'formai_streak';
const STORAGE_KEY_BADGES    = 'formai_badges';
const STORAGE_KEY_WEEK      = 'formai_week';

function getSessions()  { return JSON.parse(localStorage.getItem(STORAGE_KEY_SESSIONS)  || '[]'); }
function getSettings()  { return JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS)  || '{}'); }
function getStreakData() { return JSON.parse(localStorage.getItem(STORAGE_KEY_STREAK)   || '{"streak":0,"last":null}'); }
function getBadges()    { return JSON.parse(localStorage.getItem(STORAGE_KEY_BADGES)    || '[]'); }

function saveSession() {
  const sessions = getSessions();
  const avgForm  = state.formScores.length
    ? Math.round(state.formScores.reduce((a, b) => a + b, 0) / state.formScores.length)
    : state.formScore;

  const session = {
    id:        Date.now(),
    date:      new Date().toISOString(),
    exercise:  state.currentExercise,
    reps:      state.totalReps,
    sets:      state.sets,
    calories:  state.calories,
    duration:  state.timerSeconds,
    formScore: avgForm,
  };

  sessions.unshift(session);
  if (sessions.length > 60) sessions.pop();
  localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));

  // Reset session state
  state.totalReps   = 0;
  state.sets        = 0;
  state.calories    = 0;
  state.formScores  = [];
  state.timerSeconds = 0;
  state.sessionStart = null;
  updateTimerDisplay();
  updateStats();
}

/* ── STREAK ─────────────────────────────────────────────── */
function updateStreak() {
  const data = getStreakData();
  const today = new Date().toDateString();

  if (data.last === today) return; // Already counted today

  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (data.last === yesterday) {
    data.streak += 1;
  } else {
    data.streak = 1;
  }
  data.last = today;

  state.streak = data.streak;
  localStorage.setItem(STORAGE_KEY_STREAK, JSON.stringify(data));
  el('streak-count').textContent = data.streak;
}

function loadStreak() {
  const data = getStreakData();
  state.streak = data.streak;
  el('streak-count').textContent = data.streak;
}

/* ── BADGES ─────────────────────────────────────────────── */
const BADGE_DEFS = [
  { id: 'first_set',   label: '⚡ First Set',   check: s => s.sets >= 1 },
  { id: 'ten_streak',  label: '🎯 10-Streak',   check: s => s.reps >= 10 },
  { id: 'perfect_25',  label: '🏅 25 Perfect',  check: s => s.formScore >= 90 && s.reps >= 25 },
  { id: 'fifty_reps',  label: '🔥 50 Reps',     check: s => s.reps >= 50 },
  { id: 'week_streak', label: '📅 7-Day',       check: () => state.streak >= 7 },
  { id: 'elite_form',  label: '💎 Elite Form',  check: s => s.formScore >= 95 },
];

function checkBadgeProgress() {
  const earned = getBadges();
  const newBadges = [];
  const sessions = getSessions();
  const latestSession = sessions[0] || { reps: state.totalReps, sets: state.sets, formScore: state.formScore };

  BADGE_DEFS.forEach(def => {
    if (!earned.includes(def.id) && def.check(latestSession)) {
      earned.push(def.id);
      newBadges.push(def.label);
    }
  });

  if (newBadges.length) {
    localStorage.setItem(STORAGE_KEY_BADGES, JSON.stringify(earned));
    renderBadges(earned);
  }
  return newBadges;
}

function awardBadges() {
  return checkBadgeProgress();
}

function renderBadges(earned) {
  const grid = el('badges-grid');
  grid.innerHTML = BADGE_DEFS.map(def => `
    <div class="badge ${earned.includes(def.id) ? 'earned' : ''}" title="${def.label}">
      ${def.label}
    </div>
  `).join('');
}

function loadBadges() {
  renderBadges(getBadges());
}

/* ── SUMMARY MODAL ──────────────────────────────────────── */
function showSummary() {
  const sessions = getSessions();
  const s = sessions[0];
  if (!s) return;

  el('sum-reps').textContent = s.reps;
  el('sum-cal').textContent  = s.calories;
  el('sum-time').textContent = formatTime(s.duration);
  el('sum-form').textContent = s.formScore + '%';

  const newBadges = checkBadgeProgress();
  el('summary-badges').innerHTML = newBadges.map(b => `
    <div class="badge earned">${b}</div>
  `).join('');

  el('summary-overlay').classList.add('open');
}

function closeSummary() {
  el('summary-overlay').classList.remove('open');
}

/* ── HISTORY TAB ────────────────────────────────────────── */
function renderHistory() {
  const sessions = getSessions();
  const list = el('history-list');
  const empty = el('history-empty');

  if (sessions.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = sessions.map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const exName  = EXERCISES[s.exercise]?.label || s.exercise;

    return `
      <div class="history-card">
        <div class="history-card-left">
          <h3>${exName}</h3>
          <p>${dateStr} at ${timeStr} · ${formatTime(s.duration)}</p>
        </div>
        <div class="history-card-stats">
          <div>
            <div class="hcs-val">${s.reps}</div>
            <div class="hcs-lbl">Reps</div>
          </div>
          <div>
            <div class="hcs-val">${s.formScore}%</div>
            <div class="hcs-lbl">Form</div>
          </div>
          <div>
            <div class="hcs-val">${s.calories}</div>
            <div class="hcs-lbl">Cal</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* ── PROGRESS TAB ───────────────────────────────────────── */
function renderProgress() {
  const sessions = getSessions();

  // All-time stats
  const totalReps  = sessions.reduce((a, s) => a + s.reps, 0);
  const totalCal   = sessions.reduce((a, s) => a + s.calories, 0);
  const totalSecs  = sessions.reduce((a, s) => a + s.duration, 0);
  const avgForm    = sessions.length
    ? Math.round(sessions.reduce((a, s) => a + s.formScore, 0) / sessions.length)
    : 0;

  el('at-reps').textContent     = totalReps.toLocaleString();
  el('at-sessions').textContent = sessions.length;
  el('at-cal').textContent      = totalCal.toLocaleString();
  el('at-time').textContent     = Math.round(totalSecs / 60) + 'm';

  // Exercise breakdown
  const counts = {};
  sessions.forEach(s => { counts[s.exercise] = (counts[s.exercise] || 0) + s.reps; });
  const maxCount = Math.max(...Object.values(counts), 1);
  el('ex-breakdown').innerHTML = Object.entries(counts).map(([k, v]) => `
    <div class="ex-breakdown-item">
      <div class="ex-breakdown-name">${EXERCISES[k]?.label || k}</div>
      <div class="ex-breakdown-track">
        <div class="ex-breakdown-fill" style="width:${Math.round(v/maxCount*100)}%"></div>
      </div>
      <div class="ex-breakdown-count">${v}</div>
    </div>
  `).join('') || '<p style="color:var(--text-dim);font-size:13px;">No data yet</p>';

  // Charts
  drawLineChart('chart-reps',
    sessions.slice(0, 14).reverse().map(s => s.reps),
    sessions.slice(0, 14).reverse().map(s => new Date(s.date).toLocaleDateString('en-GB', { day:'numeric', month:'short' })),
    '#C8F135'
  );
  drawLineChart('chart-form',
    sessions.slice(0, 14).reverse().map(s => s.formScore),
    sessions.slice(0, 14).reverse().map(s => new Date(s.date).toLocaleDateString('en-GB', { day:'numeric', month:'short' })),
    '#3b9eff'
  );
}

function drawLineChart(canvasId, data, labels, color) {
  const canvas = el(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 400;
  const H = 180;
  canvas.width  = W;
  canvas.height = H;

  const pad = { top: 16, right: 16, bottom: 32, left: 36 };
  const w   = W - pad.left - pad.right;
  const h   = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  if (!data.length) {
    ctx.fillStyle = '#555';
    ctx.font = '13px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data yet', W / 2, H / 2);
    return;
  }

  const maxVal = Math.max(...data, 1);
  const minVal = 0;
  const range  = maxVal - minVal || 1;

  const xStep  = data.length > 1 ? w / (data.length - 1) : w;

  // Grid lines
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + h - (i / 4) * h;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
    // Y label
    ctx.fillStyle = '#555';
    ctx.font      = '10px DM Sans, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(minVal + (i / 4) * range), pad.left - 6, y + 4);
  }

  // Line path
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';

  data.forEach((val, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top  + h - ((val - minVal) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill under line
  ctx.lineTo(pad.left + (data.length - 1) * xStep, pad.top + h);
  ctx.lineTo(pad.left, pad.top + h);
  ctx.closePath();
  ctx.fillStyle = color + '18'; // ~10% opacity
  ctx.fill();

  // Dots
  data.forEach((val, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top  + h - ((val - minVal) / range) * h;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // X labels (skip some if crowded)
  const step = data.length > 7 ? Math.ceil(data.length / 7) : 1;
  ctx.fillStyle = '#555';
  ctx.font      = '10px DM Sans, sans-serif';
  ctx.textAlign = 'center';
  data.forEach((_, i) => {
    if (i % step !== 0) return;
    const x = pad.left + i * xStep;
    ctx.fillText(labels[i] || '', x, H - 6);
  });
}

/* ── WEEK CHART (sidebar) ───────────────────────────────── */
function renderWeekChart() {
  const sessions = getSessions();
  const now  = Date.now();
  const days = ['M','T','W','T','F','S','S'];
  const repsPerDay = new Array(7).fill(0);

  sessions.forEach(s => {
    const daysAgo = Math.floor((now - new Date(s.date).getTime()) / 86400000);
    if (daysAgo < 7) {
      const dayIdx = 6 - daysAgo;
      repsPerDay[dayIdx] += s.reps;
    }
  });

  const maxReps = Math.max(...repsPerDay, 1);
  const chart = el('week-chart');
  chart.innerHTML = repsPerDay.map((v, i) => `
    <div class="bar-col">
      <div class="bar ${i === 6 ? 'today' : ''}" style="height:${Math.round(v / maxReps * 52) + 4}px"></div>
      <div class="bar-day">${days[i]}</div>
    </div>
  `).join('');
}

/* ── SETTINGS ───────────────────────────────────────────── */
function toggleSettings() {
  const overlay = el('settings-overlay');
  overlay.classList.toggle('open');
  if (overlay.classList.contains('open')) loadSettingsUI();
}

function closeSettings(e) {
  if (e.target === el('settings-overlay')) toggleSettings();
}

function loadSettingsUI() {
  const s = getSettings();
  el('setting-voice').checked        = s.voice      || false;
  el('setting-angles').checked       = s.angles     !== false;
  el('setting-beep').checked         = s.beep       !== false;
  el('setting-resolution').value     = s.resolution || '720';
  el('setting-sensitivity').value    = s.sensitivity || 'normal';
  el('setting-username').value       = s.username   || '';
}

function updateSettings() {
  // Live preview of angle overlay toggle
  const angles = el('setting-angles').checked;
  el('angle-left').style.display  = angles ? 'block' : 'none';
  el('angle-right').style.display = angles ? 'block' : 'none';
}

function saveSettings() {
  const s = {
    voice:       el('setting-voice').checked,
    angles:      el('setting-angles').checked,
    beep:        el('setting-beep').checked,
    resolution:  el('setting-resolution').value,
    sensitivity: el('setting-sensitivity').value,
    username:    el('setting-username').value.trim(),
  };
  Object.assign(state.settings, s);
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(s));

  // Update voice toggle button
  state.voiceOn = s.voice;
  el('voice-btn').textContent = state.voiceOn ? '🔊 Voice on' : '🔇 Voice off';

  if (socket) socket.emit('update_settings', { sensitivity: s.sensitivity });

  toggleSettings();
}

function clearAllData() {
  if (!confirm('Clear ALL workout history and settings? This cannot be undone.')) return;
  localStorage.clear();
  toggleSettings();
  renderHistory();
  renderWeekChart();
  loadBadges();
  loadStreak();
  alert('All data cleared.');
}

/* ── LEVEL SYSTEM ───────────────────────────────────────── */
const LEVELS = [
  { min: 0,    label: 'Beginner',   title: 'Beginner' },
  { min: 50,   label: 'Mover',      title: 'Mover' },
  { min: 150,  label: 'Active',     title: 'Active' },
  { min: 350,  label: 'Athlete',    title: 'Athlete' },
  { min: 700,  label: 'Advanced',   title: 'Advanced' },
  { min: 1200, label: 'Elite',      title: 'Elite' },
  { min: 2000, label: 'Champion',   title: 'Champion' },
];

function updateLevel() {
  const sessions  = getSessions();
  const totalReps = sessions.reduce((a, s) => a + s.reps, 0);
  let level = 1, title = 'Beginner';
  LEVELS.forEach((l, i) => {
    if (totalReps >= l.min) { level = i + 1; title = l.title; }
  });
  el('user-level').textContent = level;
  el('user-title').textContent = title;
}

/* ── UTILITIES ──────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

/* ── INIT ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Load persisted data
  loadStreak();
  loadBadges();
  renderWeekChart();
  updateLevel();
  loadExerciseFeedback(EXERCISES['squat']);

  // Load saved settings
  const saved = getSettings();
  Object.assign(state.settings, saved);
  if (state.settings.voice) {
    state.voiceOn = true;
    el('voice-btn').textContent = '🔊 Voice on';
  }

  // Apply angle visibility
  if (!state.settings.angles) {
    el('angle-left').style.display  = 'none';
    el('angle-right').style.display = 'none';
  }

  // Init WebSocket (SocketIO injected by Flask template)
  initSocket();

  console.log('FormAI initialised');
});