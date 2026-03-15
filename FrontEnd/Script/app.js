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

/* ── LEVEL SYSTEM ───────────────────────────────────────── */
const LEVELS = [
  { min: 0, title: 'Beginner'},
  {min: 50, title: 'Mover'},
  {min: 150, title: 'Active'},
  {min: 350, title: 'Athlete'},
  {min: 700, title: 'Advanced'},
  {min: 1200, title: 'Elite'},
  {min: 2000, title: 'Champion'},
];

/* ── BADGES ─────────────────────────────────────────────── */
const BADGE_DEFS = [
  { id: 'first_set',   label: '⚡ First Set',   check: s => s.sets >= 1 },
  { id: 'ten_streak',  label: '🎯 10-Streak',   check: s => s.reps >= 10 },
  { id: 'perfect_25',  label: '🏅 25 Perfect',  check: s => s.formScore >= 90 && s.reps >= 25 },
  { id: 'fifty_reps',  label: '🔥 50 Reps',     check: s => s.reps >= 50 },
  { id: 'week_streak', label: '📅 7-Day',       check: () => state.streak >= 7 },
  { id: 'elite_form',  label: '💎 Elite Form',  check: s => s.formScore >= 95 },
];

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

function el(id) { return document.getElementById(id); }

function formatTime(s)
{
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const ACCOUNTS_KEY = 'formai_accounts';
const SESSION_KEY = 'formai_current_user';

function currentUser()
{
  return localStorage.getItem(SESSION_KEY);
}

function userKey(key)
{
  const u = currentUser();
  return u ? `formai_${u}_${key}` : null;
}

function hashPassword(pw)
{
  let h = 0;
  for(let i = 0; i < pw.length; i++)
  {
    h = (Math.imul(31, h) + pw.charCodeAt(i)) | 0;
  }
  return String(h);
}

function getAccounts(){ return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); }
function saveAccounts(accounts){ localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); }

//Auth Modal Tab Switching
function showAuthTab(tab)
{
  el('auth-login').style.display = tab === 'login' ? 'block' : 'none';
  el('auth-register').style.display = tab === 'register' ? 'block' : 'none';
  el('login-tab-btn').classList.toggle('active', tab === 'login');
  el('register-tab-btn').classList.toggle('active', tab === 'register');
  el('login-error').textContent = '';
  el('reg-error').textContent = '';
}

function register()
{
  const username = el('reg-username').value.trim().toLowerCase();
  const displayName = el('reg-displayname').value.trim();
  const password = el('reg-password').value;
  const confirm = el('reg-confirm').value;
  const errEl = el('reg-error');

  if(!username) return (errEl.textContent = 'Username is required.');
  if(!/^[a-z0-9_]+$/.test(username)) return (errEl.textContent = 'Username: letters, numbers amd _ only.');
  if(password.legth < 4) return (errEl.textContent = 'Password must be at least 4 charavters long.');
  if(password !== confirm) return (errEl.textContent = 'Passwords do not match.');

  const accounts = getAccounts();
  if(accounts[username]) return (errEl.textContent = 'Username already taken.');

  accounts[username] = {
    passwordHash: hashPassword(password),
    displayName: displayName || username,
  };
  saveAccounts(accounts);

  localStorage.setItem(SESSION_KEY, username);
  el('auth-overlay').classList.remove('open');
  initUserUI();
}

//----LOGIN-----
function login()
{
  const username = el('login-username').value.trim().toLowerCase();
  const password = el('login-password').value;
  const errEl = el('login-error');

  if(!username || !password) return (errEl.textContent = 'Please enter username and password.');

  const accounts = getAccounts();
  const account = accounts[username];

  if(!account || account.passwordHash !== hashPassword(password))
  {
    return(errEl.textContent = 'Incorrect username or password.');
  }

  localStorage.setItem(SESSION_KEY, username);
  el('auth-overlay').classList.remove('open');
  initUserUI();
}

function logout()
{
  if(state.isRunning) endSession();
  localStorage.removeItem(SESSION_KEY);
  el('user-menu').classList.remove('open');
  el('auth-overlay').classList.add('open');
  el('login-username').value = '';
  el('login-password').value = '';
  el('login-error').textContent = '';
  showAuthTab('login');
}

//User mMenu Dropdown
function toggleUserMenu()
{
  el('user-menu').classList.toggle('open');
}

document.addEventListener('click', e => {
  const menu = el('user-menu');
  const avatar = el('user-avatar');
  if(menu && !menu.contains(e.target) && e.target !== avatar)
  {
    menu.classList.remove('open');
  }
});

//INIT User UI
function initUserUI()
{
  const username = currentUser();
  if(!username) return;

  const accounts = getAccounts();
  const displayName = accounts[username]?.displayName || username;
  const initials = displayName.slice(0, 2).toUpperCase();

  el('user-initials').textContent = initials;
  el('user-menu-name').textContent = displayName;

  el('profile-name').textContent = displayName;
  el('profile-username').textContent = `@${username}`;
  el('profile-avatar-lg').textContent = initials;

  const saved = getSettings();
  Object.assign(state.settings, saved);
  state.voiceOn = saved.voice;
  el('voice-btn').textContent = state.voiceOn ? '🔊 Voice on' : '🔇 Voice off';

  loadStreak();
  renderWeekChart();
  updateLevel();
}

//Page Load
document.addEventListener('DOMContentLoaded', () => {
  const username = currentUser();
  if(username)
  {
    el('auth-overlay').classList.remove('open');
    initUserUI();
  }
  else
  {
    showAuthTab('lgin');
  }

  initSocket();
  loadExerciseFeedback(EXERCISES['squat']);
  updateChallenge();
});

//Sessions - array of { id, date, exercose, reps, sets, calories, duration, formscore }
function getSessions() {const k = userKey('sessions'); return k ? JSON.parse(localStorage.getItem(k) || '[]') : []; }

// Settings — { voice, angles, beep, resolution, sensitivity }
function getSettings()      { const k = userKey('settings'); return k ? JSON.parse(localStorage.getItem(k) || '{}') : {}; }
function saveSettingsStore(s) { const k = userKey('settings'); if (k) localStorage.setItem(k, JSON.stringify(s)); }

// Streak — { streak: number, last: 'Mon Jan 01 2025' }
function getStreakData()   { const k = userKey('streak'); return k ? JSON.parse(localStorage.getItem(k) || '{"streak":0,"last":null}') : { streak: 0, last: null }; }
function saveStreakData(d) { const k = userKey('streak'); if (k) localStorage.setItem(k, JSON.stringify(d)); }

// Badges — array of earned badge ID strings e.g. ['first_set', 'fifty_reps']
function getBadges()        { const k = userKey('badges'); return k ? JSON.parse(localStorage.getItem(k) || '[]') : []; }
function saveBadgesStore(b) { const k = userKey('badges'); if (k) localStorage.setItem(k, JSON.stringify(b)); }

function getStreak() {return getStreakData().streak; }

/* ── TIMER ──────────────────────────────────────────────── */
let timerInterval = null;

function startTimer() {
  timerInterval = setInterval(() => {
    state.timerSeconds++;
    el('timer-display').textContent = formatTime(state.timerSeconds);
    // Calories tick
    state.calories = Math.round(state.totalReps * (EXERCISES[state.currentExercise].calPerRep) + state.timerSeconds * 0.04);
    el('stat-cal').textContent = state.calories;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function stopTimer()
{
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

//Session Control

function toggleSession() {
  if (!state.isRunning) {
    startSession();
  } else {
    endSession();
  }
}

// startSession() — activates the camera, starts the timer, shows all HUD elements,
// and tells the backend to start tracking.
// Guard: does nothing if no user is logged in (data wouldn't be saveable).
function startSession() {
  if (!currentUser()) return;

  state.isRunning    = true;
  state.sessionStart = state.sessionStart || Date.now();

  // ── Toggle button to Stop (red) ───────────────────────
  el('session-btn').classList.remove('primary');
  el('session-btn').classList.add('danger');
  el('session-btn-label').textContent = '■ Stop Session';

  // ── Reveal all live HUD elements ──────────────────────
  // These are all hidden by default (style="display:none" in index.html)
  el('hud-phase').style.display       = 'block';
  el('hud-feedback').style.display    = 'block';
  el('timer-display').classList.add('running');   // turns green via CSS
  el('camera-waiting').style.display  = 'none';   // hide "camera not active" placeholder
  el('live-indicator').style.display  = 'flex';   // show red LIVE badge

  // ── Show form score ring (replace the idle message) ───
  el('score-idle-msg').style.display  = 'none';
  el('score-ring-wrap').style.display = 'block';

  // ── Show live feedback list (replace the idle message) ─
  el('feedback-idle-msg').style.display = 'none';
  el('feedback-list').style.display     = 'flex';

  // ── Show angle pills only if the setting is enabled ───
  if (state.settings.angles) {
    el('angle-left').style.display  = 'block';
    el('angle-right').style.display = 'block';
  }

  // ── Start MJPEG stream from the backend ───────────────
  // The ?exercise= param tells the backend which exercise to start tracking
  const feed        = el('camera-feed');
  feed.src          = `/video_feed?exercise=${state.currentExercise}`;
  feed.style.display = 'block';

  if (socket) socket.emit('start_tracking', { exercise: state.currentExercise });
  startTimer();
  updateStats(); // reset stat boxes to current (zeroed) values
}

// endSession() — stops everything, saves the session, shows the summary.
// Guard: does nothing if session had 0 reps (no point saving an empty session).
function endSession() {
  if (!state.isRunning && state.totalReps === 0) return;
  state.isRunning = false;

  // ── Toggle button back to Start (green) ───────────────
  el('session-btn').classList.remove('danger');
  el('session-btn').classList.add('primary');
  el('session-btn-label').textContent = '▶ Start Session';

  // ── Hide camera feed, show waiting placeholder ────────
  el('camera-feed').src           = '';
  el('camera-feed').style.display = 'none';
  el('camera-waiting').style.display = 'flex';
  el('live-indicator').style.display  = 'none';
  el('timer-display').classList.remove('running'); // turns white

  // ── Hide all live HUD elements ────────────────────────
  el('hud-phase').style.display       = 'none';
  el('hud-feedback').style.display    = 'none';
  el('angle-left').style.display      = 'none';
  el('angle-right').style.display     = 'none';
  el('confidence-wrap').style.display = 'none';

  // ── Restore form score panel to idle state ────────────
  el('score-ring-wrap').style.display = 'none';
  el('score-idle-msg').style.display  = 'block';

  // ── Restore feedback panel to idle state ─────────────
  el('feedback-list').style.display     = 'none';
  el('feedback-idle-msg').style.display = 'flex';
  el('feedback-list').innerHTML         = ''; // clear all live feedback items

  if (socket) socket.emit('stop_tracking');
  stopTimer();

  if (state.totalReps === 0) return; // nothing to save

  // ── Post-session updates ──────────────────────────────
  saveSession();     // write to localStorage, reset all session counters
  showSummary();     // open "Session Complete 🎉" modal
  updateStreak();    // increment streak if it's a new day
  awardBadges();     // check if any badges were newly earned
  updateLevel();     // recalculate XP level based on updated all-time reps
  renderWeekChart(); // refresh 7-day bar chart in left panel
}

// resetCurrentSet() — zeroes the per-set rep counter WITHOUT ending the session.
// Called by the "↺ Reset set" button in the control bar.
function resetCurrentSet() {
  state.reps = 0;
  el('hud-rep-num').textContent = '0';
  el('hud-phase').textContent   = 'Ready — stand in frame';
  updateChallenge();
}


/* ══════════════════════════════════════════════════════════
   9. REP & FORM UPDATES
   ──────────────────────────────────────────────────────────
   Called by handleRepData() every time the backend reports a new rep.
══════════════════════════════════════════════════════════ */

// onRepCompleted() — fires each time state.reps increases.
// Handles: flash animation, beep, voice coaching, and set completion.
// ✅ TO CHANGE REPS PER SET: edit state.targetReps at the top, or
//    add a UI input that updates state.targetReps dynamically.
function onRepCompleted() {
  const numEl = el('hud-rep-num');
  numEl.textContent = state.reps;

  // Re-trigger CSS flash animation — must remove class first to reset it
  numEl.classList.remove('flash');
  void numEl.offsetWidth; // force browser reflow so removal registers
  numEl.classList.add('flash');

  if (state.settings.beep) playBeep();
  if (state.voiceOn)       speak(String(state.reps));

  // Set completion — when reps hit the target, increment sets and reset reps
  if (state.reps >= state.targetReps) {
    state.sets++;
    state.reps = 0;
    el('hud-phase').textContent = `Set ${state.sets} complete! Rest…`;
    if (state.voiceOn) speak(`Set ${state.sets} complete. Rest up.`);
  }

  updateStats();
  updateChallenge();
}

// updateStats() — refreshes the four mini stat boxes in the left panel.
function updateStats() {
  el('stat-reps').textContent = state.totalReps;
  el('stat-cal').textContent  = state.calories;
  el('stat-sets').textContent = state.sets;

  // Average form score — shows "—" if no reps scored yet
  const avg = state.formScores.length
    ? Math.round(state.formScores.reduce((a, b) => a + b, 0) / state.formScores.length)
    : null;
  el('stat-acc').textContent = avg !== null ? avg + '%' : '—';
}

// updateFormScore(score) — updates the SVG ring and grade text in the right panel.
// score: integer 0–100 from the backend.
// ✅ TO CHANGE GRADE THRESHOLDS OR COLOURS: edit the if/else chain below.
function updateFormScore(score) {
  el('score-num').textContent = score;

  // 314 = circumference of circle (2π × r=50 px).
  // offset 314 = empty ring, offset 0 = full ring.
  const offset = Math.round(314 - (score / 100) * 314);
  el('score-ring-fill').setAttribute('stroke-dashoffset', offset);

  // Grade thresholds — ✅ TO CHANGE: edit numbers and strings here
  let color, grade;
  if      (score >= 90) { color = '#c8f135'; grade = 'Excellent'; }
  else if (score >= 75) { color = '#c8f135'; grade = 'Good'; }
  else if (score >= 55) { color = '#ff8c00'; grade = 'Fair'; }
  else                  { color = '#ff4040'; grade = 'Needs work'; }

  el('score-ring-fill').style.stroke = color;
  el('score-num').style.color        = color;
  el('score-grade').textContent      = grade;
}

// setFeedback(text, type) — updates the floating feedback text on the camera overlay.
// type: 'good' | 'warn' | 'bad' — controls colour via CSS class
function setFeedback(text, type = 'good') {
  const e     = el('hud-feedback');
  const prefix = type === 'good' ? '✓ ' : type === 'warn' ? '⚠ ' : '✗ ';
  e.textContent = prefix + text;
  e.className   = 'hud-feedback ' + type;
}

// pushFeedbackItem(text, type) — adds a line to the coach feedback list
// in the right panel. If the last item is the same message, increments
// a counter (e.g. "Spread wider x3") instead of adding a duplicate.
// List is capped at 5 items — oldest is dropped when full.
// ✅ TO CHANGE MAX ITEMS: edit the number 5 below.
function pushFeedbackItem(text, type) {
  const list = el('feedback-list');

  // If last item has the same text, just increment its counter
  const last = list.lastChild;
  if (last) {
    const lastText  = last.querySelector('.fi-text');
    const lastCount = last.querySelector('.fi-count');
    if (lastText && lastText.dataset.raw === text) {
      const n = parseInt(lastCount.textContent.replace('x', '') || '1') + 1;
      lastCount.textContent = `x${n}`;
      return;
    }
  }

  const item = document.createElement('div');
  item.className = 'feedback-item';
  item.innerHTML = `
    <div class="fi-dot ${type}"></div>
    <div class="fi-text" data-raw="${text}">${text}</div>
    <div class="fi-count"></div>
  `;

  if (list.children.length >= 5) list.removeChild(list.firstChild); // drop oldest
  list.appendChild(item);
}


/* ══════════════════════════════════════════════════════════
   10. EXERCISE SWITCH
   ──────────────────────────────────────────────────────────
   Called when the user clicks an exercise button in the left panel.
   If a session is running, also switches the backend tracking live.
══════════════════════════════════════════════════════════ */

// setExercise(exKey, btn) — switches the active exercise.
// exKey: must match a key in the EXERCISES object above.
// btn: the <button> element that was clicked (for CSS active state).
function setExercise(exKey, btn) {
  state.currentExercise = exKey;
  state.reps = 0; // reset per-set rep counter when switching

  // Update which button appears selected
  document.querySelectorAll('.exercise-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const ex = EXERCISES[exKey];

  // Update angle pill labels and challenge text
  el('angle-lbl-left').textContent  = ex.angleLabel1;
  el('angle-lbl-right').textContent = ex.angleLabel2;
  el('challenge-name').textContent  = ex.challenge;
  el('challenge-desc').textContent  = ex.challengeDesc;
  el('hud-rep-num').textContent     = '0';

  // Reset HUD text if mid-session
  if (state.isRunning) {
    el('hud-phase').textContent    = 'Ready — stand in frame';
    el('hud-feedback').textContent = 'Waiting for pose detection…';
    el('hud-feedback').className   = 'hud-feedback';
  }

  // Tell backend to switch exercises live (only if session is active)
  if (socket && state.isRunning) {
    socket.emit('change_exercise', { exercise: exKey });
    el('camera-feed').src = `/video_feed?exercise=${exKey}`;
  }

  updateChallenge();
  loadExerciseFeedback(ex);
}

// loadExerciseFeedback(ex) — resets the right panel feedback section to idle state.
// Called when switching exercises and when the page first loads.
function loadExerciseFeedback(ex) {
  if (!state.isRunning) {
    el('feedback-idle-msg').style.display = 'flex';
    el('feedback-list').style.display     = 'none';
  }
}


/* ══════════════════════════════════════════════════════════
   11. CHALLENGE
   ──────────────────────────────────────────────────────────
   Tracks total session reps against the exercise's challengeGoal.
   Resets on new session (since totalReps resets in saveSession).
══════════════════════════════════════════════════════════ */

// updateChallenge() — recalculates and redraws the challenge progress bar.
function updateChallenge() {
  const goal = EXERCISES[state.currentExercise].challengeGoal;
  const pct  = Math.min(100, Math.round(state.totalReps / goal * 100));
  el('challenge-fill').style.width  = pct + '%';
  el('challenge-count').textContent = `${state.totalReps} / ${goal} reps`;
  el('challenge-pct').textContent   = pct + '%';
}

// adjustTarget(delta) — changes the set target up or down by delta (+1 or -1).
// Called by the + and − buttons next to the target display in the left panel.
// Clamped to 1–10 sets.
function adjustTarget(delta) {
  state.targetSets = Math.max(1, Math.min(10, state.targetSets + delta));
  el('target-display').textContent = `${state.targetSets} sets × ${state.targetReps} reps`;
}


/* ══════════════════════════════════════════════════════════
   12. VOICE & BEEP
   ──────────────────────────────────────────────────────────
   Voice uses the browser's Web Speech API (no external library).
   Beep uses the Web Audio API — no audio file needed.

   ✅ TO CHANGE BEEP PITCH: edit osc.frequency.value (Hz). 880 = A5.
   ✅ TO CHANGE BEEP LENGTH: edit the 0.12 second values.
   ❌ TO DISABLE VOICE ENTIRELY: delete toggleVoice() and speak(),
      remove the voice button from index.html.
══════════════════════════════════════════════════════════ */

// toggleVoice() — called by the 🔇/🔊 button in the control bar.
function toggleVoice() {
  state.voiceOn = !state.voiceOn;
  el('voice-btn').textContent = state.voiceOn ? '🔊 Voice on' : '🔇 Voice off';
}

// speak(text) — reads text aloud via browser TTS.
// Cancels any ongoing speech first so sentences don't queue up.
function speak(text) {
  if (!window.speechSynthesis) return;
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 1.1; // ✅ TO CHANGE SPEED: 0.5 (slow) to 2.0 (fast)
  utt.pitch  = 1;   // ✅ TO CHANGE PITCH: 0 (low) to 2 (high)
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utt);
}

// playBeep() — generates a short sine-wave beep using the Web Audio API.
function playBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;    // ✅ TO CHANGE PITCH: Hz value (440 = A4, 880 = A5)
    osc.type            = 'sine'; // ✅ TO CHANGE TONE: 'square', 'sawtooth', 'triangle'
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12); // ✅ TO CHANGE LENGTH: seconds
  } catch (e) { /* browser blocked audio — ignore silently */ }
}


/* ══════════════════════════════════════════════════════════
   13. TABS
   ──────────────────────────────────────────────────────────
   Tabs work by toggling the CSS 'active' class on .tab-content divs.
   Only the active div is visible (CSS: display:none → display:flex).

   ✅ TO ADD A NEW TAB:
     1. Add <button class="tab-btn" onclick="switchTab('newtab', this)"> in topbar.
     2. Add <main class="tab-content" id="tab-newtab"> in index.html.
     3. Add a case below: if (tabId === 'newtab') renderNewTab();
     4. Write the renderNewTab() function.

   ❌ TO REMOVE A TAB:
     1. Delete its <button> from the topbar in index.html.
     2. Delete its <main> block from index.html.
     3. Remove its case from switchTab() below.
══════════════════════════════════════════════════════════ */

// switchTab(tabId, btn) — shows the clicked tab and hides all others.
// Render functions are called lazily so heavy rendering only happens
// when the tab is actually viewed, not on page load.
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  el('tab-' + tabId).classList.add('active');
  btn.classList.add('active');

  if (tabId === 'history') renderHistory();
  if (tabId === 'profile') renderProfile();
  // ✅ TO ADD: if (tabId === 'newtab') renderNewTab();
}


/* ══════════════════════════════════════════════════════════
   14. SESSION SAVE
   ──────────────────────────────────────────────────────────
   Writes the completed session to localStorage and resets all
   session counters back to zero.

   Session object shape:
   {
     id:        number (timestamp in ms),
     date:      ISO date string,
     exercise:  string (exercise key),
     reps:      number,
     sets:      number,
     calories:  number,
     duration:  number (seconds),
     formScore: number (0–100, averaged across all reps)
   }

   ✅ TO ADD A NEW FIELD TO SESSIONS:
     1. Add it to the object below (e.g. targetReps: state.targetReps).
     2. Display it in renderHistory() and/or renderProfile().

   Max 60 sessions are kept per user. Oldest are silently dropped.
   ✅ TO CHANGE THE LIMIT: edit the 60 on the sessions.length check.
══════════════════════════════════════════════════════════ */

function saveSession() {
  const sessions = getSessions();

  // Average all per-rep form scores collected during the session
  const avgForm = state.formScores.length
    ? Math.round(state.formScores.reduce((a, b) => a + b, 0) / state.formScores.length)
    : state.formScore;

  sessions.unshift({ // prepend — newest first
    id:        Date.now(),
    date:      new Date().toISOString(),
    exercise:  state.currentExercise,
    reps:      state.totalReps,
    sets:      state.sets,
    calories:  state.calories,
    duration:  state.timerSeconds,
    formScore: avgForm,
  });

  if (sessions.length > 60) sessions.pop(); // drop oldest beyond limit
  saveSessions(sessions);

  // ── Reset all session counters ────────────────────────
  state.totalReps    = 0;
  state.sets         = 0;
  state.calories     = 0;
  state.formScores   = [];
  state.timerSeconds = 0;
  state.sessionStart = null;
  el('timer-display').textContent = '00:00';
  updateStats();
}


/* ══════════════════════════════════════════════════════════
   15. STREAK
   ──────────────────────────────────────────────────────────
   A streak increments when the user completes at least one session
   per calendar day. Missing a day resets it to 1 (not 0).
   Streak is stored as { streak: number, last: dateString }.
══════════════════════════════════════════════════════════ */

// updateStreak() — called after every session end.
// Increments streak if today is a new day, resets to 1 if a day was skipped.
function updateStreak() {
  const data  = getStreakData();
  const today = new Date().toDateString(); // e.g. "Mon Jan 06 2025"

  if (data.last === today) return; // already worked out today — no change

  const yesterday = new Date(Date.now() - 86400000).toDateString();
  data.streak     = data.last === yesterday ? data.streak + 1 : 1;
  data.last       = today;

  saveStreakData(data);
  el('streak-count').textContent   = data.streak;
  el('profile-streak').textContent = data.streak;
}

// loadStreak() — reads saved streak number and shows it in the topbar.
// Called on login and when switching to the Profile tab.
function loadStreak() {
  const n = getStreakData().streak;
  el('streak-count').textContent   = n;
  el('profile-streak').textContent = n;
}


/* ══════════════════════════════════════════════════════════
   16. BADGES
   ──────────────────────────────────────────────────────────
   Badges are checked at the end of each session. Each badge's
   check() function receives the most recently saved session object.
══════════════════════════════════════════════════════════ */

// checkBadgeProgress() — loops through BADGE_DEFS and awards any
// newly earned badges. Returns an array of new badge labels
// (shown in the session summary modal and on the profile).
function checkBadgeProgress() {
  const earned    = getBadges();
  const newBadges = [];
  const sessions  = getSessions();

  // Use the session just saved; fall back to live state values
  const latest = sessions[0] || {
    reps:      state.totalReps,
    sets:      state.sets,
    formScore: state.formScore,
  };

  BADGE_DEFS.forEach(def => {
    if (!earned.includes(def.id) && def.check(latest)) {
      earned.push(def.id);
      newBadges.push(def.label);
    }
  });

  if (newBadges.length) {
    saveBadgesStore(earned);
    renderProfileBadges(earned); // update profile page immediately
  }
  return newBadges;
}

// awardBadges() — alias called from endSession()
function awardBadges() { return checkBadgeProgress(); }

// renderProfileBadges(earned) — redraws the entire badges grid in the Profile tab.
// earned: array of badge ID strings (e.g. ['first_set', 'fifty_reps'])
// Unearned badges are shown greyed out.
function renderProfileBadges(earned) {
  const grid = el('profile-badges-grid');
  if (!grid) return;
  grid.innerHTML = BADGE_DEFS.map(def => `
    <div class="badge ${earned.includes(def.id) ? 'earned' : ''}" title="${def.label}">
      ${def.label}
    </div>
  `).join('');
}


/* ══════════════════════════════════════════════════════════
   17. SUMMARY MODAL
   ──────────────────────────────────────────────────────────
   Shown automatically after every session that had at least 1 rep.
   Displays the stats from the just-saved session plus any new badges.
══════════════════════════════════════════════════════════ */

// showSummary() — populates and opens the "Session Complete 🎉" modal.
function showSummary() {
  const sessions = getSessions();
  const s        = sessions[0]; // the session we just saved
  if (!s) return;

  el('sum-reps').textContent = s.reps;
  el('sum-cal').textContent  = s.calories;
  el('sum-time').textContent = formatTime(s.duration);
  el('sum-form').textContent = s.formScore + '%';

  const newBadges = checkBadgeProgress();
  el('summary-badges').innerHTML = newBadges
    .map(b => `<div class="badge earned">${b}</div>`)
    .join('');

  el('summary-overlay').classList.add('open');
}

// closeSummary() — called by the "Keep going 💪" button inside the modal.
function closeSummary() {
  el('summary-overlay').classList.remove('open');
}


/* ══════════════════════════════════════════════════════════
   18. LEVEL SYSTEM
   ──────────────────────────────────────────────────────────
   Level is derived from total all-time reps across all sessions.
   Thresholds are defined in the LEVELS array at the top of the file.
══════════════════════════════════════════════════════════ */

// updateLevel() — recalculates and displays the current level everywhere.
// Called after a session ends and when switching to the Profile tab.
function updateLevel() {
  const total = getSessions().reduce((a, s) => a + s.reps, 0);
  let level = 1, title = 'Beginner';
  LEVELS.forEach((l, i) => {
    if (total >= l.min) { level = i + 1; title = l.title; }
  });
  el('user-level').textContent    = level;
  el('user-title').textContent    = title;
  el('profile-level').textContent = level;
  el('profile-title').textContent = title;
}


/* ══════════════════════════════════════════════════════════
   19. HISTORY TAB
   ──────────────────────────────────────────────────────────
   Renders the list of past sessions as cards with key stats.
   Called lazily each time the History tab is opened.

   ✅ TO ADD MORE FIELDS TO EACH CARD:
     Add HTML inside the .history-card template literal below.
     The session object 's' contains: exercise, reps, sets,
     calories, duration, formScore, date, id.
══════════════════════════════════════════════════════════ */

function renderHistory() {
  const sessions = getSessions();
  const list     = el('history-list');
  const empty    = el('history-empty');

  if (!sessions.length) {
    empty.style.display = 'block';
    list.innerHTML      = '';
    list.appendChild(empty);
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = sessions.map(s => {
    const d       = new Date(s.date);
    const dateStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const exName  = EXERCISES[s.exercise]?.label || s.exercise;

    // Form score colour thresholds
    // ✅ TO CHANGE: edit the numbers 80 and 60 below
    const formColor = s.formScore >= 80 ? 'var(--green)' :
                      s.formScore >= 60 ? 'var(--orange)' : 'var(--red)';

    return `
      <div class="history-card">
        <div class="history-card-left">
          <h3>${exName}</h3>
          <p>${dateStr} at ${timeStr} · ${formatTime(s.duration)}</p>
        </div>
        <div class="history-card-stats">
          <div><div class="hcs-val">${s.reps}</div><div class="hcs-lbl">Reps</div></div>
          <div><div class="hcs-val" style="color:${formColor}">${s.formScore}%</div><div class="hcs-lbl">Form</div></div>
          <div><div class="hcs-val">${s.calories}</div><div class="hcs-lbl">Cal</div></div>
        </div>
      </div>`;
  }).join('');
}


/* ══════════════════════════════════════════════════════════
   20. PROFILE TAB
   ──────────────────────────────────────────────────────────
   Renders all-time stats, badges, progress charts, and exercise breakdown.
   Called lazily each time the Profile tab is opened.

   ✅ TO ADD A NEW ALL-TIME STAT:
     1. Add a <div class="alltime-stat"> in index.html inside the profile grid.
     2. Calculate the value from 'sessions' below and set its textContent.
══════════════════════════════════════════════════════════ */

function renderProfile() {
  updateLevel();
  loadStreak();

  const sessions  = getSessions();
  const totalReps = sessions.reduce((a, s) => a + s.reps, 0);
  const totalCal  = sessions.reduce((a, s) => a + s.calories, 0);
  const totalSecs = sessions.reduce((a, s) => a + s.duration, 0);

  // All-time stats grid
  el('at-reps').textContent     = totalReps.toLocaleString();
  el('at-sessions').textContent = sessions.length;
  el('at-cal').textContent      = totalCal.toLocaleString();
  el('at-time').textContent     = Math.round(totalSecs / 60) + 'm';

  // Badges grid
  renderProfileBadges(getBadges());

  // Exercise breakdown — horizontal proportion bars per exercise
  const counts   = {};
  sessions.forEach(s => { counts[s.exercise] = (counts[s.exercise] || 0) + s.reps; });
  const maxCount = Math.max(...Object.values(counts), 1);

  el('ex-breakdown').innerHTML = Object.entries(counts).map(([k, v]) => `
    <div class="ex-breakdown-item">
      <div class="ex-breakdown-name">${EXERCISES[k]?.label || k}</div>
      <div class="ex-breakdown-track">
        <div class="ex-breakdown-fill" style="width:${Math.round(v / maxCount * 100)}%"></div>
      </div>
      <div class="ex-breakdown-count">${v}</div>
    </div>
  `).join('') || '<p style="color:var(--text-dim);font-size:13px;">No data yet</p>';

  // Line charts — most recent 14 sessions (oldest → newest, left → right)
  const recent = sessions.slice(0, 14).reverse();
  const dates  = recent.map(s => new Date(s.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));

  drawLineChart('chart-reps', recent.map(s => s.reps),      dates, '#C8F135');
  drawLineChart('chart-form', recent.map(s => s.formScore), dates, '#3b9eff');
}


/* ══════════════════════════════════════════════════════════
   21. CHARTS
   ──────────────────────────────────────────────────────────
   Custom canvas-based line chart — no external libraries.
   Draws horizontal grid lines, a filled line, data point dots,
   and X-axis date labels.

   ✅ TO CHANGE CHART HEIGHT: edit the H constant inside the function.
   ✅ TO CHANGE LINE THICKNESS: edit ctx.lineWidth in the line path section.
   ✅ TO ADD A NEW CHART: call drawLineChart() with a new <canvas id>
      in index.html, and pass your data and label arrays.
══════════════════════════════════════════════════════════ */

// drawLineChart(canvasId, data, labels, color)
//   canvasId — ID of a <canvas> element in index.html
//   data     — array of numbers (Y values)
//   labels   — array of strings (X axis labels, same length as data)
//   color    — hex color string for the line and dots
function drawLineChart(canvasId, data, labels, color) {
  const canvas = el(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const W   = canvas.offsetWidth || 400;
  const H   = 180; // ✅ TO CHANGE HEIGHT: edit this value
  canvas.width  = W;
  canvas.height = H;

  const pad  = { top: 16, right: 16, bottom: 32, left: 36 }; // space for labels
  const w    = W - pad.left - pad.right;
  const h    = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  if (!data.length) {
    ctx.fillStyle = '#555'; ctx.font = '13px DM Sans, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('No data yet', W / 2, H / 2);
    return;
  }

  const maxVal = Math.max(...data, 1);
  const range  = maxVal || 1;
  const xStep  = data.length > 1 ? w / (data.length - 1) : w;

  // Horizontal grid lines (5 lines = 0%, 25%, 50%, 75%, 100%)
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + h - (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + w, y); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '10px DM Sans, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round((i / 4) * range), pad.left - 6, y + 4);
  }

  // Line path
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  data.forEach((val, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top  + h - (val / range) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Filled area under the line (~10% opacity)
  ctx.lineTo(pad.left + (data.length - 1) * xStep, pad.top + h);
  ctx.lineTo(pad.left, pad.top + h);
  ctx.closePath(); ctx.fillStyle = color + '18'; ctx.fill();

  // Data point dots
  data.forEach((val, i) => {
    const x = pad.left + i * xStep;
    const y = pad.top  + h - (val / range) * h;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  });

  // X axis labels — skip some if there are too many to fit
  const step = data.length > 7 ? Math.ceil(data.length / 7) : 1;
  ctx.fillStyle = '#555'; ctx.font = '10px DM Sans, sans-serif'; ctx.textAlign = 'center';
  data.forEach((_, i) => {
    if (i % step !== 0) return;
    ctx.fillText(labels[i] || '', pad.left + i * xStep, H - 6);
  });
}

// renderWeekChart() — draws the 7-bar chart in the left panel showing
// reps per day for the past week. Today's bar is highlighted in green.
function renderWeekChart() {
  const sessions   = getSessions();
  const now        = Date.now();
  const days       = ['M','T','W','T','F','S','S'];
  const repsPerDay = new Array(7).fill(0);

  sessions.forEach(s => {
    const daysAgo = Math.floor((now - new Date(s.date).getTime()) / 86400000);
    if (daysAgo < 7) repsPerDay[6 - daysAgo] += s.reps; // index 6 = today
  });

  const maxReps = Math.max(...repsPerDay, 1);
  el('week-chart').innerHTML = repsPerDay.map((v, i) => `
    <div class="bar-col">
      <div class="bar ${i === 6 ? 'today' : ''}" style="height:${Math.round(v / maxReps * 52) + 4}px"></div>
      <div class="bar-day">${days[i]}</div>
    </div>
  `).join('');
}


/* ══════════════════════════════════════════════════════════
   22. SETTINGS
   ──────────────────────────────────────────────────────────
   The settings modal lets users configure voice, angle overlays,
   rep beep, camera resolution, and form sensitivity.
   Settings are saved per-user in localStorage.

   ✅ TO ADD A NEW SETTING:
     1. Add a <div class="setting-row"> in the settings modal in index.html.
     2. Add the field to state.settings at the top of this file.
     3. Read the new input element in saveSettings() below.
     4. Apply the setting wherever it affects behaviour.

   ❌ TO REMOVE A SETTING:
     1. Delete its .setting-row from the modal in index.html.
     2. Remove the field from state.settings.
     3. Remove its line from saveSettings().
══════════════════════════════════════════════════════════ */

// toggleSettings() — opens or closes the settings modal.
// Called by the ⚙ Settings item in the user menu dropdown.
function toggleSettings() {
  const overlay = el('settings-overlay');
  overlay.classList.toggle('open');
  if (overlay.classList.contains('open')) loadSettingsUI();
}

// closeSettings(e) — closes the modal when the dark backdrop is clicked.
// The onclick="closeSettings(event)" is on the .modal-overlay div in index.html.
function closeSettings(e) {
  if (e.target === el('settings-overlay')) toggleSettings();
}

// loadSettingsUI() — reads saved settings and pre-fills all form inputs.
// Called every time the modal opens so it always shows the current saved state.
function loadSettingsUI() {
  const s = getSettings();
  el('setting-voice').checked      = s.voice      || false;
  el('setting-angles').checked     = s.angles     !== false; // defaults true
  el('setting-beep').checked       = s.beep       !== false; // defaults true
  el('setting-resolution').value   = s.resolution  || '720';
  el('setting-sensitivity').value  = s.sensitivity || 'normal';
}

// updateSettings() — called live as the user changes inputs (via onchange in HTML).
// Currently only applies the angles toggle live mid-session.
// ✅ TO APPLY OTHER SETTINGS LIVE: add them here.
function updateSettings() {
  const angles = el('setting-angles').checked;
  if (state.isRunning) {
    el('angle-left').style.display  = angles ? 'block' : 'none';
    el('angle-right').style.display = angles ? 'block' : 'none';
  }
}

// saveSettings() — writes all settings to localStorage and applies them.
// Called by the "Save settings" button in the modal.
function saveSettings() {
  const s = {
    voice:       el('setting-voice').checked,
    angles:      el('setting-angles').checked,
    beep:        el('setting-beep').checked,
    resolution:  el('setting-resolution').value,
    sensitivity: el('setting-sensitivity').value,
  };

  Object.assign(state.settings, s); // update runtime state immediately
  saveSettingsStore(s);             // persist to localStorage for this user

  state.voiceOn = s.voice;
  el('voice-btn').textContent = state.voiceOn ? '🔊 Voice on' : '🔇 Voice off';

  // Tell the backend about the sensitivity change — it affects angle thresholds
  // in BackEnd/exercises.py (SENSITIVITY_OFFSET dictionary)
  if (socket) socket.emit('update_settings', { sensitivity: s.sensitivity });

  toggleSettings(); // close the modal
}

// clearAllData() — deletes ALL workout data for the current user (not the account).
// Called by "Clear all data" button in the settings modal.
// ✅ TO ALSO DELETE THE ACCOUNT: add the following lines before toggleSettings():
//   const accounts = getAccounts();
//   delete accounts[currentUser()];
//   saveAccounts(accounts);
//   logout();
function clearAllData() {
  if (!confirm('Clear ALL your workout history and settings? This cannot be undone.')) return;

  const u = currentUser();
  if (!u) return;

  // ✅ TO ADD A NEW DATA TYPE that should be wiped: add its key name to this array
  ['sessions', 'settings', 'streak', 'badges'].forEach(key => {
    localStorage.removeItem(`formai_${u}_${key}`);
  });

  toggleSettings();
  renderWeekChart();
  updateLevel();
  loadStreak();
  renderProfileBadges([]);
  alert('All data cleared.');
}
