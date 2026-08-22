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

// ─── 空室ベースライン（時間帯別・3スロット）──────────────────────────────
// スロット 0: 朝（6〜13時）
// スロット 1: 昼〜夕（13〜19時）
// スロット 2: 夜（19〜6時）
const CHK_W = 64, CHK_H = 48;
const EMPTY_THRESHOLD = 18; // 差がこれ以下なら空室と判定

let chkCanvas = document.createElement('canvas');
chkCanvas.width  = CHK_W;
chkCanvas.height = CHK_H;
let chkCtx = null;
try { chkCtx = chkCanvas.getContext('2d', { willReadFrequently: true }); } catch(e) {}

function getTimeSlot() {
  const h = new Date().getHours();
  if (h >= 6  && h < 13) return 0; // 朝
  if (h >= 13 && h < 19) return 1; // 昼〜夕
  return 2;                          // 夜
}

function saveBaseline(imageData) {
  const slot = getTimeSlot();
  try {
    localStorage.setItem('baseline_' + slot, JSON.stringify(Array.from(imageData.data)));
    localStorage.setItem('baseline_' + slot + '_saved', new Date().toLocaleString('ja-JP'));
  } catch(e) {}
}

function loadBaseline() {
  // 現在の時間帯→隣のスロット→残りの順に探す
  const slot = getTimeSlot();
  const order = [slot, (slot + 1) % 3, (slot + 2) % 3];
  for (const s of order) {
    try {
      const stored = localStorage.getItem('baseline_' + s);
      if (!stored) continue;
      const arr = JSON.parse(stored);
      const imgData = chkCtx.createImageData(CHK_W, CHK_H);
      imgData.data.set(new Uint8ClampedArray(arr));
      return imgData;
    } catch(e) {}
  }
  return null;
}

let emptyBaseline = null;

function refreshBaseline() {
  emptyBaseline = loadBaseline();
}

async function captureAndSaveBaseline(onDone) {
  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;font-size:20px;gap:16px;';
  overlay.innerHTML = '<p>📷 ベースライン撮影中...</p>';
  document.body.appendChild(overlay);

  try {
    const tmpStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CHK_W }, height: { ideal: CHK_H } },
      audio: false,
    });
    const tmpVideo = document.createElement('video');
    tmpVideo.muted = true;
    tmpVideo.srcObject = tmpStream;
    await tmpVideo.play();
    await new Promise(r => setTimeout(r, 2000)); // カメラ安定待ち

    chkCtx.drawImage(tmpVideo, 0, 0, CHK_W, CHK_H);
    const imgData = chkCtx.getImageData(0, 0, CHK_W, CHK_H);
    saveBaseline(imgData);
    emptyBaseline = imgData;

    tmpStream.getTracks().forEach(t => t.stop());
    tmpVideo.srcObject = null;

    const slotNames = ['朝（6〜13時）', '昼〜夕（13〜19時）', '夜（19〜6時）'];
    overlay.innerHTML = '<p>✅ 撮影完了</p><p style="font-size:14px">' + slotNames[getTimeSlot()] + 'のベースラインを保存しました</p>';
    setTimeout(() => {
      overlay.remove();
      if (onDone) onDone();
    }, 2000);
  } catch(e) {
    overlay.innerHTML = '<p>❌ カメラ起動失敗</p><p style="font-size:14px">' + e.message + '</p>';
    setTimeout(() => overlay.remove(), 3000);
  }
}

function showBaselineStatus() {
  const slotNames = ['朝（6〜13時）', '昼〜夕（13〜19時）', '夜（19〜6時）'];
  const currentSlot = getTimeSlot();

  function buildHTML() {
    let rows = '';
    for (let s = 0; s < 3; s++) {
      const saved = localStorage.getItem('baseline_' + s + '_saved');
      const data  = localStorage.getItem('baseline_' + s);
      const hasData = !!(data);
      const isCurrent = s === currentSlot;
      rows += `
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:14px 16px;margin-bottom:12px;display:flex;align-items:center;gap:12px;">
          <div style="flex:1;">
            <div style="font-size:15px;font-weight:bold;">${isCurrent ? '▶ ' : ''}${slotNames[s]}</div>
            <div style="font-size:13px;margin-top:4px;opacity:0.8;">
              ${hasData ? '✅ 保存済み: ' + saved : '❌ 未撮影'}
            </div>
          </div>
          ${hasData ? `<button onclick="deleteSlot(${s})" style="background:#e74c3c;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;">削除</button>` : ''}
          <button onclick="captureSlot(${s})" style="background:#27ae60;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;">撮影</button>
        </div>`;
    }
    return rows;
  }

  const overlay = document.createElement('div');
  overlay.id = 'baseline-status-overlay';
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;padding:20px;';
  overlay.innerHTML = `
    <div style="max-width:420px;width:100%;">
      <h2 style="text-align:center;margin-bottom:20px;font-size:18px;">📷 ベースライン管理</h2>
      <div id="baseline-rows">${buildHTML()}</div>
      <button onclick="document.getElementById('baseline-status-overlay').remove()" style="width:100%;margin-top:16px;background:rgba(255,255,255,0.2);color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;cursor:pointer;">閉じる</button>
    </div>`;
  document.body.appendChild(overlay);

  window.deleteSlot = function(s) {
    localStorage.removeItem('baseline_' + s);
    localStorage.removeItem('baseline_' + s + '_saved');
    refreshBaseline();
    document.getElementById('baseline-rows').innerHTML = buildHTML();
  };

  window.captureSlot = function(s) {
    overlay.remove();
    captureAndSaveBaseline(() => showBaselineStatus());
  };
}

function isRoomEmpty() {
  if (!emptyBaseline || !chkCtx) return false;
  const v = document.getElementById('motion-video');
  if (!v || v.readyState < 2) return false;
  chkCtx.drawImage(v, 0, 0, CHK_W, CHK_H);
  const curr = chkCtx.getImageData(0, 0, CHK_W, CHK_H);
  let diff = 0;
  for (let i = 0; i < curr.data.length; i += 4) {
    diff += Math.abs(curr.data[i]   - emptyBaseline.data[i]);
    diff += Math.abs(curr.data[i+1] - emptyBaseline.data[i+1]);
    diff += Math.abs(curr.data[i+2] - emptyBaseline.data[i+2]);
  }
  diff /= (CHK_W * CHK_H * 3);
  return diff < EMPTY_THRESHOLD;
}

// ─── スケジュール（1〜4分チェック＋5分強制）─────────────────────────────
let checkTimers = [];
let hardTimer   = null;

function startSchedule() {
  clearSchedule();
  refreshBaseline(); // チェック開始時に現在の時間帯のベースラインを再読込

  [1, 2, 3, 4].forEach(min => {
    const t = setTimeout(() => {
      if (currentState !== STATES.RECORDING) return;
      if (isRoomEmpty()) stopAndSend();
    }, min * 60 * 1000);
    checkTimers.push(t);
  });

  hardTimer = setTimeout(() => {
    if (currentState === STATES.RECORDING) stopAndSend();
  }, 5 * 60 * 1000);
}

function clearSchedule() {
  checkTimers.forEach(t => clearTimeout(t));
  checkTimers = [];
  if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
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
  clearSchedule();
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
  startSchedule();
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

async function onSendClick(e) {
  if (e && e.cancelable) e.preventDefault();
  if (currentState === STATES.RECORDING) await stopAndSend();
}
document.getElementById('btn-send').addEventListener('click', onSendClick);
document.getElementById('btn-send').addEventListener('touchstart', onSendClick, { passive: false });

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

  // 保存済みベースラインを読み込む
  refreshBaseline();

  const bc = new BroadcastChannel('reception_door');
  bc.onmessage = (e) => {
    if (e.data === 'door_open') {
      setTimeout(() => onDoorOpened(), 1000);
    }
  };

  // ?baseline=status でベースライン確認・削除画面
  if (new URLSearchParams(window.location.search).get('baseline') === 'status') {
    history.replaceState({}, '', location.pathname);
    showBaselineStatus();
    return;
  }

  // ?baseline=1 でベースライン撮影モード
  if (new URLSearchParams(window.location.search).get('baseline') === '1') {
    history.replaceState({}, '', location.pathname);
    captureAndSaveBaseline(null);
    return;
  }

  if (new URLSearchParams(window.location.search).get('door') === '1') {
    history.replaceState({}, '', location.pathname);
    bc.postMessage('door_open');
    setTimeout(() => { try { window.close(); } catch(e) {} }, 300);
  }
}());
