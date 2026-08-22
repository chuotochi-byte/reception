const STATES = {
  IDLE:      'idle',
  RECORDING: 'recording',
  UPLOADING: 'uploading',
  DONE:      'done',
};

let currentState = STATES.IDLE;
function setState(state) {
  currentState = state;
  document.body.dataset.state = state;
}

function enterFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) fn.call(el).catch(() => {});
}

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      if (document.visibilityState === 'visible') requestWakeLock();
    });
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

function speak(text) {
  try {
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang   = 'ja-JP';
    utt.rate   = 1.0;
    utt.volume = 1.0;
    speechSynthesis.speak(utt);
  } catch (e) {}
}

// ─── カメラ・録画 ──────────────────────────────────────────────────────────
let videoStream     = null;
let videoRecorder   = null;
let recordingChunks = [];
let recordingMime   = '';

async function startVideoRecording() {
  if (videoRecorder) return;

  if (!videoStream) {
    const video = document.getElementById('motion-video');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: true,
      });
      videoStream     = stream;
      video.srcObject = stream;
      await video.play();
    } catch (videoErr) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
        videoStream     = audioOnly;
        document.getElementById('motion-video').srcObject = audioOnly;
      } catch (audioErr) {
        showError('カメラ・マイク起動失敗: ' + audioErr.message);
        return;
      }
    }
  }

  recordingMime   = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  recordingChunks = [];
  videoRecorder   = new MediaRecorder(videoStream, { mimeType: recordingMime });
  videoRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordingChunks.push(e.data);
  };
  videoRecorder.start(1000);
}

function releaseCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
    document.getElementById('motion-video').srcObject = null;
  }
}

async function stopAndSend() {
  if (currentState !== STATES.RECORDING) return;
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  setState(STATES.UPLOADING);

  let blob = null;
  if (videoRecorder && videoRecorder.state !== 'inactive') {
    blob = await new Promise(resolve => {
      videoRecorder.onstop = () => {
        resolve(new Blob(recordingChunks, { type: recordingMime }));
        videoRecorder = null;
      };
      videoRecorder.stop();
    });
  } else {
    videoRecorder = null;
  }

  releaseCamera();
  await uploadAndNotify(blob);
}

// ─── Dropbox ──────────────────────────────────────────────────────────────
async function getDropboxToken() {
  const expiry = parseInt(localStorage.getItem('dbx_token_expiry') || '0');
  const stored = localStorage.getItem('dbx_access_token');
  if (stored && Date.now() < expiry) return stored;

  const refresh = localStorage.getItem('dbx_refresh_token');
  if (!refresh) return CONFIG.DROPBOX_TOKEN;

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refresh,
      client_id:     'go6xm0yq8trg9pu',
    }),
  });
  const json = await res.json();
  if (!res.ok) return CONFIG.DROPBOX_TOKEN;
  localStorage.setItem('dbx_access_token', json.access_token);
  localStorage.setItem('dbx_token_expiry', Date.now() + (json.expires_in - 300) * 1000);
  return json.access_token;
}

async function uploadToDropbox(blob) {
  const token = await getDropboxToken();
  const now = new Date();
  const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const path = `/reception_${ts}.webm`;
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }),
      'Content-Type':    'application/octet-stream',
    },
    body: blob,
  });
  const resText = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + resText.substring(0, 200));
  return JSON.parse(resText).path_display;
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  const now = new Date();
  const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  a.href     = url;
  a.download = `受付録画_${ts}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

function showError(msg) {
  let el = document.getElementById('debug-msg');
  if (!el) {
    el = document.createElement('div');
    el.id    = 'debug-msg';
    el.style = 'position:fixed;top:10px;left:10px;right:10px;background:rgba(255,0,0,0.85);color:#fff;padding:12px;font-size:14px;z-index:99999;border-radius:8px;word-break:break-all;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  setTimeout(() => { if (el) el.remove(); }, 15000);
}

async function uploadAndNotify(blob) {
  if (blob) {
    try {
      await uploadToDropbox(blob);
    } catch (err) {
      showError('Dropboxエラー: ' + err.message);
      downloadBlob(blob);
    }
  } else {
    showError('録音なし：カメラ・マイクの許可を確認してください');
  }
  setState(STATES.DONE);
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(goToIdle, CONFIG.DONE_RESET_MINUTES * 60 * 1000);
}

// ─── 状態管理 ──────────────────────────────────────────────────────────────
let announceTimer = null;
let lastDoorTime  = 0;
let doneTimer     = null;
let hardTimer     = null;

function onDoorOpened() {
  if (currentState !== STATES.IDLE) return;
  if (Date.now() - lastDoorTime < 10000) return;
  if (announceTimer) return;

  lastDoorTime = Date.now();
  enterFullscreen();
  setState(STATES.RECORDING);
  startVideoRecording();

  // 5分で自動送信（安全弁）
  hardTimer = setTimeout(() => {
    if (currentState === STATES.RECORDING) stopAndSend();
  }, 5 * 60 * 1000);

  announceTimer = setTimeout(() => {
    announceTimer = null;
    speak(CONFIG.VOICE_GUIDANCE);
  }, CONFIG.ANNOUNCE_DELAY_SEC * 1000);
}

function goToIdle() {
  try { speechSynthesis.cancel(); } catch(e) {}
  if (doneTimer)     { clearTimeout(doneTimer);     doneTimer     = null; }
  if (announceTimer) { clearTimeout(announceTimer); announceTimer = null; }
  if (hardTimer)     { clearTimeout(hardTimer);     hardTimer     = null; }
  setState(STATES.IDLE);
}

async function onSendClick() {
  if (currentState === STATES.RECORDING) await stopAndSend();
}
document.getElementById('btn-send').addEventListener('click', onSendClick);

let audioUnlocked = false;
function ensureAudioUnlocked() {
  if (audioUnlocked) return;
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
    audioUnlocked = true;
  } catch(e) {}
}

function handleDoorTrigger() {
  ensureAudioUnlocked();
  enterFullscreen();
  onDoorOpened();
}

document.getElementById('door-trigger').addEventListener('click', handleDoorTrigger);
document.getElementById('door-trigger').addEventListener('touchstart', (e) => {
  e.preventDefault();
  handleDoorTrigger();
}, { passive: false });

// ─── 起動 ──────────────────────────────────────────────────────────────────
requestWakeLock();

(function () {
  const startEl = document.getElementById('screen-start');
  if (startEl) startEl.style.display = 'none';
  enterFullscreen();
  setState(STATES.IDLE);

  const bc = new BroadcastChannel('reception_door');
  bc.onmessage = (e) => {
    if (e.data === 'door_open') {
      setTimeout(() => onDoorOpened(), 1000);
    }
  };

  if (new URLSearchParams(window.location.search).get('door') === '1') {
    history.replaceState({}, '', location.pathname);
    bc.postMessage('door_open');
    setTimeout(() => { try { window.close(); } catch(e) {} }, 300);
  }
}());
