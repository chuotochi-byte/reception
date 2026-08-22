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

// ─── AI画像チェック ────────────────────────────────────────────────────────
// 録画中の映像からスナップショットを撮り、人が映っているか判定する
async function isRoomEmpty() {
  const video = document.getElementById('motion-video');
  if (!video || video.readyState < 2) return false;

  // ── AIチェック（Anthropic APIキーがある場合）──
  if (CONFIG.ANTHROPIC_API_KEY) {
    try {
      const snap = document.createElement('canvas');
      snap.width  = 320;
      snap.height = 240;
      snap.getContext('2d').drawImage(video, 0, 0, 320, 240);
      const b64 = snap.toDataURL('image/jpeg', 0.6).split(',')[1];

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-api-key':      CONFIG.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{
            role: 'user',
            content: [
              {
                type:   'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
              },
              {
                type: 'text',
                text: 'この画像に人間が映っていますか？YESまたはNOのみ答えてください。',
              },
            ],
          }],
        }),
      });

      if (!res.ok) throw new Error('API ' + res.status);
      const json = await res.json();
      const ans  = (json.content?.[0]?.text || '').trim().toUpperCase();
      return ans.startsWith('NO'); // NOなら空室
    } catch (e) {
      showError('AI画像チェック失敗: ' + e.message);
      return false; // エラー時は人がいると仮定して続行
    }
  }

  // ── ピクセル比較フォールバック（APIキーなし）──
  if (!baseline) return false;
  presCtx.drawImage(video, 0, 0, PRES_W, PRES_H);
  const curr = presCtx.getImageData(0, 0, PRES_W, PRES_H);
  return frameDiff(curr, baseline) < ABSENT_THRESHOLD;
}

// ─── ピクセル比較（フォールバック用）─────────────────────────────────────
const PRES_W = 64, PRES_H = 48;
const ABSENT_THRESHOLD = 18;
let presCanvas = document.createElement('canvas');
presCanvas.width  = PRES_W;
presCanvas.height = PRES_H;
let presCtx = null;
try { presCtx = presCanvas.getContext('2d', { willReadFrequently: true }); } catch(e) {}
let baseline = null;

function captureBaseline() {
  const v = document.getElementById('motion-video');
  if (!presCtx || !v || v.readyState < 2) return;
  presCtx.drawImage(v, 0, 0, PRES_W, PRES_H);
  baseline = presCtx.getImageData(0, 0, PRES_W, PRES_H);
}

function frameDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i]   - b.data[i]);
    sum += Math.abs(a.data[i+1] - b.data[i+1]);
    sum += Math.abs(a.data[i+2] - b.data[i+2]);
  }
  return sum / (PRES_W * PRES_H * 3);
}

// ─── スケジュール画像チェック ───────────────────────────────────────────
// 1分・2分・3分・4分にチェック、5分で強制終了
let checkTimers = [];

function schedulePresenceChecks() {
  clearPresenceChecks();
  [1, 2, 3, 4].forEach(min => {
    const t = setTimeout(async () => {
      if (currentState !== STATES.RECORDING) return;
      const empty = await isRoomEmpty();
      if (empty && currentState === STATES.RECORDING) {
        stopAndSend(); // 人なし → 自動送信
      }
    }, min * 60 * 1000);
    checkTimers.push(t);
  });
  // 5分で強制終了
  const t5 = setTimeout(() => {
    if (currentState === STATES.RECORDING) stopAndSend();
  }, 5 * 60 * 1000);
  checkTimers.push(t5);
}

function clearPresenceChecks() {
  checkTimers.forEach(t => clearTimeout(t));
  checkTimers = [];
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
      // 3秒後にベースライン記録（人が来る前の状態）
      setTimeout(captureBaseline, 3000);
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
  schedulePresenceChecks(); // 1・2・3・4分チェック＋5分強制終了
}

function releaseCamera() {
  if (videoStream) {
    // 退出後3秒でベースライン更新→次の来客に備える
    setTimeout(captureBaseline, 3000);
    setTimeout(() => {
      videoStream.getTracks().forEach(t => t.stop());
      videoStream = null;
      document.getElementById('motion-video').srcObject = null;
    }, 4000);
  }
}

async function stopAndSend() {
  clearPresenceChecks();
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

function onDoorOpened() {
  if (currentState !== STATES.IDLE) return;
  if (Date.now() - lastDoorTime < 10000) return;
  if (announceTimer) return;

  lastDoorTime = Date.now();
  enterFullscreen();
  setState(STATES.RECORDING);
  startVideoRecording();

  announceTimer = setTimeout(() => {
    announceTimer = null;
    speak(CONFIG.VOICE_GUIDANCE);
  }, CONFIG.ANNOUNCE_DELAY_SEC * 1000);
}

function goToIdle() {
  try { speechSynthesis.cancel(); } catch(e) {}
  if (doneTimer)     { clearTimeout(doneTimer);     doneTimer     = null; }
  if (announceTimer) { clearTimeout(announceTimer); announceTimer = null; }
  setState(STATES.IDLE);
}

async function onSendClick() {
  if (currentState === STATES.RECORDING) await stopAndSend();
}
document.getElementById('btn-send').addEventListener('click', onSendClick);

// ─── 画面タップ（手動テスト）──────────────────────────────────────────────
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
