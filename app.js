


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

// ============================================================
// フルスクリーン / スリープ防止
// ============================================================
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

// ============================================================
// 音声合成（TTS）
// ============================================================
function loadVoices() {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) { resolve(v); return; }
    speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 3000);
  });
}

async function speak(text) {
  const voices  = await loadVoices();
  const jpVoice = voices.find(v => v.lang.startsWith('ja'));
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const utt   = new SpeechSynthesisUtterance(text);
    utt.lang    = 'ja-JP';
    utt.rate    = 1.3;
    utt.volume  = 1.0;
    if (jpVoice) utt.voice = jpVoice;
    utt.onend   = () => resolve();
    utt.onerror = () => resolve();
    speechSynthesis.speak(utt);
    setTimeout(resolve, 10000);
  });
}

// ============================================================
// カメラ録画（音声あり）
// ============================================================
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
  console.log('[録画] 開始');
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
  if (!res.ok) throw new Error('Dropbox ' + res.status + ': ' + resText);
  const data = JSON.parse(resText);
  console.log('[Dropbox] アップロード完了', data.path_display);
  return data.path_display;
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

async function uploadAndNotify(blob) {
  let infoText = 'お客様よりご連絡がありました';

  if (blob) {
    try {
      const path = await uploadToDropbox(blob);
      infoText = `Dropboxに録画を保存しました：${path}`;
    } catch (err) {
      console.error('[Dropbox] アップロード失敗:', err.message);
      infoText = '録画ファイル（端末に保存）';
      showDebug('Dropboxエラー: ' + err.message);
      downloadBlob(blob);
    }
  }

  try {
    await emailjs.send(CONFIG.EMAILJS_SERVICE_ID, CONFIG.EMAILJS_TEMPLATE_ID, {
      to_email:     CONFIG.EMAIL_TO,
      visitor_info: infoText,
    });
  } catch (err) {
    console.error('[メール送信エラー]', err);
  }

  setState(STATES.DONE);
  if (doneTimer) clearTimeout(doneTimer);
  doneTimer = setTimeout(goToIdle, CONFIG.DONE_RESET_MINUTES * 60 * 1000);
}

// ============================================================
// ドアトリガー（MacroDroidから隠しボタンをタップ）
// ============================================================
let announceTimer   = null;
let lastAnnouncedAt = 0;
let doneTimer       = null;

function onDoorOpened() {
  if (Date.now() - lastAnnouncedAt < 30000) return;
  if (announceTimer) return;
  announceTimer = setTimeout(async () => {
    announceTimer = null;
    if (currentState !== STATES.IDLE) return;
    lastAnnouncedAt = Date.now();
    enterFullscreen();
    setState(STATES.RECORDING);
    await startVideoRecording();
    speak(CONFIG.VOICE_GUIDANCE);
  }, CONFIG.ANNOUNCE_DELAY_SEC * 1000);
}

const _trigger = document.getElementById('door-trigger');
_trigger.addEventListener('click', onDoorOpened);
_trigger.addEventListener('touchstart', (e) => { e.preventDefault(); onDoorOpened(); }, { passive: false });


// ============================================================
// 画面フロー
// ============================================================
function goToIdle() {
  speechSynthesis.cancel();
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  releaseCamera();
  setState(STATES.IDLE);
}

// ============================================================
// イベントリスナー
// ============================================================
async function onSendClick() {
  if (currentState === STATES.RECORDING) {
    await stopAndSend();
  }
}
document.getElementById('btn-send').addEventListener('click', onSendClick);

// ============================================================
// 初期化
// ============================================================
requestWakeLock();
speechSynthesis.getVoices();
if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

// 起動タップ：音声ロック解除後にシステム起動
document.getElementById('screen-start').addEventListener('click', async () => {
  // Androidの音声ロックをユーザー操作で解除
  const utt = new SpeechSynthesisUtterance('');
  utt.volume = 0;
  speechSynthesis.speak(utt);

  document.getElementById('screen-start').style.display = 'none';
  enterFullscreen();
  setState(STATES.IDLE);
}, { once: true });
