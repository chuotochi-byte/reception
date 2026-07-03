
const STATES = {
  IDLE:      'idle',
  RECORDING: 'recording',
  UPLOADING: 'uploading',
  DONE:      'done',
  SLEEP:     'sleep',
};

let currentState = STATES.IDLE;
function setState(state) {
  currentState = state;
  document.body.dataset.state = state;
}

function isBusinessHours() {
  const h = new Date().getHours();
  return h >= CONFIG.OPEN_HOUR && h < CONFIG.CLOSE_HOUR;
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
      if (document.visibilityState === 'visible' && currentState !== STATES.SLEEP) {
        requestWakeLock();
      }
    });
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentState !== STATES.SLEEP) {
    requestWakeLock();
  }
});

// TTS
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

let videoStream     = null;
let videoRecorder   = null;
let recordingTimer  = null;
let recordingChunks = [];
let recordingMime   = '';

async function startVideoRecording() {
  if (videoRecorder) return;

  if (!videoStream) {
    const video = document.getElementById('motion-video');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: true,
      });
      videoStream     = stream;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      console.warn('[カメラ] 起動失敗:', err.message);
      return;
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
  recordingTimer = setTimeout(stopAndSend, 5 * 60 * 1000);
}

function releaseCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
    document.getElementById('motion-video').srcObject = null;
  }
}

async function stopAndSend() {
  if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }

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
  }

  releaseCamera();
  await uploadAndNotify(blob);
}

async function uploadToDropbox(blob) {
  const now = new Date();
  const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const path = `/reception_${ts}.webm`;

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }),
      'Content-Type': 'application/octet-stream',
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
    el.id = 'debug-msg';
    el.style = 'position:fixed;top:10px;left:10px;right:10px;background:rgba(255,0,0,0.85);color:#fff;padding:12px;font-size:14px;z-index:99999;border-radius:8px;word-break:break-all;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  setTimeout(() => { if (el) el.remove(); }, 15000);
}

async function uploadAndNotify(blob) {
  if (blob) {
    try {
      const path = await uploadToDropbox(blob);
      console.log('[Dropbox] 完了:', path);
    } catch (err) {
      console.error('[Dropbox] 失敗:', err.message);
      showError('Dropboxエラー: ' + err.message);
      downloadBlob(blob);
    }
  }

  setState(STATES.DONE);
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(goToIdle, CONFIG.DONE_RESET_MINUTES * 60 * 1000);
}

let announceTimer   = null;
let lastAnnouncedAt = 0;
let doneTimer       = null;

function onDoorOpened() {
  if (currentState === STATES.SLEEP) return;
  if (!isBusinessHours()) return;
  if (Date.now() - lastAnnouncedAt < 30000) return;
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    if (currentState !== STATES.IDLE) return;
    lastAnnouncedAt = Date.now();
    speak(CONFIG.VOICE_GUIDANCE);
    enterFullscreen();
    setState(STATES.RECORDING);
    startVideoRecording();
  }, CONFIG.ANNOUNCE_DELAY_SEC * 1000);
}

// ── スリープ管理 ──────────────────────────────────────────────
function enterSleepMode() {
  if (announceTimer) { clearTimeout(announceTimer); announceTimer = null; }
  if (doneTimer)     { clearTimeout(doneTimer);     doneTimer     = null; }
  if (wakeLock)      { wakeLock.release().catch(() => {}); wakeLock = null; }
  setState(STATES.SLEEP);
}

function exitSleepMode() {
  requestWakeLock();
  setState(STATES.IDLE);
}

function scheduleCheck() {
  // 業務時間外 かつ スリープ中でなければスリープへ
  if (!isBusinessHours() && currentState !== STATES.SLEEP) {
    if (currentState === STATES.IDLE || currentState === STATES.DONE) {
      enterSleepMode();
    }
    // 録画中・送信中は完了後に次のチェックで移行
  }
  // 業務時間内 かつ スリープ中なら復帰
  if (isBusinessHours() && currentState === STATES.SLEEP) {
    exitSleepMode();
  }
  // スリープ画面の時計を更新
  const clockEl = document.getElementById('sleep-clock');
  if (clockEl) {
    const now = new Date();
    clockEl.textContent =
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
  }
}

setTimeout(scheduleCheck, 2000);    // 起動直後に確認
setInterval(scheduleCheck, 60000);  // 以降は1分ごと

// ─────────────────────────────────────────────────────────────

function goToIdle() {
  speechSynthesis.cancel();
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  releaseCamera();
  setState(STATES.IDLE);
}

async function onSendClick() {
  if (currentState === STATES.RECORDING) {
    await stopAndSend();
  }
}
document.getElementById('btn-send').addEventListener('click', onSendClick);

// ── ドアトリガー（音声ロック解除も自動で行う）──────────────────
function unlockAudioIfNeeded() {
  const startEl = document.getElementById('screen-start');
  if (!startEl || startEl.style.display === 'none') return false; // すでに解除済み
  // まだ「タップして開始」が表示されている → ここで自動解除
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance('.');
  utt.volume = 0.01;
  speechSynthesis.speak(utt);
  startEl.style.display = 'none';
  enterFullscreen();
  return true; // 解除した
}

function handleDoorTrigger() {
  const justUnlocked = unlockAudioIfNeeded();
  if (justUnlocked) {
    // 音声解除と同時に業務時間チェック
    if (!isBusinessHours()) {
      enterSleepMode();
      return;
    }
    setState(STATES.IDLE);
  }
  onDoorOpened();
}

document.getElementById('door-trigger').addEventListener('click', handleDoorTrigger);
document.getElementById('door-trigger').addEventListener('touchstart', (e) => {
  e.preventDefault();
  handleDoorTrigger();
}, { passive: false });

// 起動時：業務時間内のみWakeLockを取得
if (isBusinessHours()) {
  requestWakeLock();
}

// 手動タップ用（ドアトリガーで自動処理されるため通常は不要）
document.getElementById('screen-start').addEventListener('click', () => {
  unlockAudioIfNeeded();
  enterFullscreen();
  if (isBusinessHours()) {
    setState(STATES.IDLE);
  } else {
    enterSleepMode();
  }
}, { once: true });
