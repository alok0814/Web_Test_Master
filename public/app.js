const video = document.querySelector('#video');
const snap = document.querySelector('#snap');
const snapCtx = snap.getContext('2d', { willReadFrequently: true });

const startBtn = document.querySelector('#start');
const onceBtn = document.querySelector('#once');
const stopBtn = document.querySelector('#stop');
const flipBtn = document.querySelector('#flip');
const statusEl = document.querySelector('#status');
const answerEl = document.querySelector('#answer');
const summaryEl = document.querySelector('#summary');
const historyEl = document.querySelector('#history');
const meterBar = document.querySelector('#meter-bar');
const meterLabel = document.querySelector('#meter-label');
const phoneUrls = document.querySelector('#phone-urls');
const gateError = document.querySelector('#gate-error');
const settingsDialog = document.querySelector('#settings');
const apiKeyInput = document.querySelector('#api-key');
const saveKeyBtn = document.querySelector('#save-key');
const keyState = document.querySelector('#key-state');
const modelSelect = document.querySelector('#model');
const rateInput = document.querySelector('#rate');
const autoInput = document.querySelector('#auto');
const fileInput = document.querySelector('#file');
const zoomInput = document.querySelector('#zoom');
const zoomLabel = document.querySelector('#zoom-label');
const zoomInBtn = document.querySelector('#zoom-in');
const zoomOutBtn = document.querySelector('#zoom-out');

const READ_EVERY = 10000;
const FIRST_READ_DELAY = 1500;
const LOOP_MS = 200;

let stream = null;
let facing = 'environment';
let running = false;
let busy = false;
let needsSolve = false;
let loopTimer = null;
let wakeLock = null;
let hasKey = false;
let session = 0;
let nextReadAt = 0;
let lastSpoken = '';
let zoom = 1;
let zoomMin = 1;
let zoomMax = 4;
let zoomStep = 0.1;
let hardwareZoom = false;
let pinchStartDist = 0;
let pinchStartZoom = 1;

const settings = {
  model: localStorage.getItem('tm-model') || 'gpt-4o',
  rate: Number(localStorage.getItem('tm-rate') || 105),
  auto: localStorage.getItem('tm-auto') !== '0',
};

modelSelect.value = settings.model;
rateInput.value = String(settings.rate);
autoInput.checked = settings.auto;

function setStatus(text) {
  statusEl.textContent = text;
}

function remember(key, value) {
  localStorage.setItem(key, String(value));
}

function videoTrack() {
  return stream?.getVideoTracks?.()[0] || null;
}

function clampZoom(value) {
  return Math.min(zoomMax, Math.max(zoomMin, value));
}

function readZoomCaps() {
  const track = videoTrack();
  const caps = track?.getCapabilities?.() || {};
  const current = track?.getSettings?.() || {};
  const range = caps.zoom;
  if (range && Number.isFinite(range.max) && range.max > range.min) {
    hardwareZoom = true;
    zoomMin = range.min;
    zoomMax = range.max;
    zoomStep = range.step || 0.1;
    zoom = Number.isFinite(current.zoom) ? current.zoom : range.min;
  } else {
    hardwareZoom = false;
    zoomMin = 1;
    zoomMax = 4;
    zoomStep = 0.1;
    zoom = 1;
  }
  zoomInput.min = String(zoomMin);
  zoomInput.max = String(zoomMax);
  zoomInput.step = String(Math.min(zoomStep, 0.1));
  applyZoom(zoom);
}

function applyZoom(value) {
  zoom = Math.round(clampZoom(Number(value) || zoomMin) * 10) / 10;
  zoomInput.value = String(zoom);
  zoomLabel.textContent = `${zoom.toFixed(1)}倍`;
  const track = videoTrack();
  if (hardwareZoom && track) {
    video.style.transform = 'none';
    track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {
      hardwareZoom = false;
      video.style.transform = `scale(${zoom})`;
    });
    return;
  }
  video.style.transform = zoom > 1 ? `scale(${zoom})` : 'none';
}

function zoomBy(direction) {
  const step = Math.max(0.2, zoomStep);
  applyZoom(zoom + direction * step);
}

function touchDistance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const ja = voices.filter((voice) => voice.lang.toLowerCase().startsWith('ja'));
  return (
    ja.find((voice) => /kyoko|otoya|siri|google|nanami|haruka/i.test(voice.name)) ||
    ja[0] ||
    null
  );
}

function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = Number(rateInput.value) / 100;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.onstart = () => setStatus('答えを話しています');
  utterance.onend = () => {
    if (running) paintCountdown(Date.now());
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function unlockSpeech() {
  speak('始めます');
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return '';
  const level = hardwareZoom ? 1 : Math.max(1, zoom);
  const cropW = vw / level;
  const cropH = vh / level;
  const cropX = (vw - cropW) / 2;
  const cropY = (vh - cropH) / 2;
  const scale = Math.min(1, 1600 / cropW);
  snap.width = Math.round(cropW * scale);
  snap.height = Math.round(cropH * scale);
  snapCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, snap.width, snap.height);
  return snap.toDataURL('image/jpeg', 0.72);
}

function pushHistory(text) {
  const item = document.createElement('li');
  item.textContent = text;
  historyEl.prepend(item);
  while (historyEl.children.length > 5) historyEl.lastElementChild.remove();
}

function paintCountdown(now) {
  const left = Math.max(0, Math.ceil((nextReadAt - now) / 1000));
  const span = READ_EVERY / 1000;
  const ratio = autoInput.checked ? Math.max(0, Math.min(1, 1 - left / span)) : 0;
  meterBar.style.width = `${ratio * 100}%`;
  meterLabel.textContent = autoInput.checked ? `${left}秒後に読み取ります` : '自動読み取りはオフです';
  if (!running || busy) return;
  if ('speechSynthesis' in window && speechSynthesis.speaking) return;
  setStatus(autoInput.checked ? `${left}秒後に読み取ります` : '自動読み取りはオフです');
}

async function solveImage(image, reason) {
  if (!image) return;
  if (busy) {
    needsSolve = true;
    return;
  }
  busy = true;
  needsSolve = false;
  const ticket = session;
  setStatus(reason === 'manual' ? '今の画面を読んでいます' : '画面を読んでいます');
  answerEl.textContent = '読み取り中…';
  try {
    const response = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, model: modelSelect.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (ticket !== session) return;
    if (!response.ok) throw new Error(data.error || '読み取りに失敗しました');
    if (!data.hasProblem || !data.speech) {
      summaryEl.textContent = '';
      answerEl.textContent = '問題が読めませんでした';
      setStatus('問題が見つかりません。映し方を変えてください');
      return;
    }
    const same = data.speech === lastSpoken;
    lastSpoken = data.speech;
    summaryEl.textContent = data.summary || '';
    answerEl.textContent = data.speech;
    if (same && reason !== 'manual') {
      setStatus('同じ問題です');
      return;
    }
    pushHistory(data.speech);
    if (navigator.vibrate) navigator.vibrate(80);
    speak(data.speech);
  } catch (error) {
    if (ticket !== session) return;
    answerEl.textContent = error.message;
    setStatus('失敗しました');
  } finally {
    busy = false;
    if (needsSolve && running && ticket === session) {
      needsSolve = false;
      const again = captureFrame();
      if (again) solveImage(again, 'auto');
    }
  }
}

function loop() {
  if (!running) return;
  const now = Date.now();
  paintCountdown(now);
  if (autoInput.checked && now >= nextReadAt) {
    nextReadAt = now + READ_EVERY;
    solveImage(captureFrame(), 'auto');
  }
  loopTimer = setTimeout(loop, LOOP_MS);
}

async function openCamera() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  const attempts = [
    { video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: { facingMode: facing }, audio: false },
    { video: true, audio: false },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      readZoomCaps();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('カメラを開始できません');
}

async function start() {
  gateError.textContent = '';
  await refreshHealth();
  if (!window.isSecureContext) {
    gateError.textContent = 'カメラを使うには https で開いてください。下に出ているスマホ用のアドレスを使ってください。';
    return;
  }
  if (!hasKey) {
    keyState.textContent = '先にAPIキーを保存してください。';
    keyState.className = 'hint is-bad';
    settingsDialog.showModal();
    return;
  }
  startBtn.disabled = true;
  try {
    await openCamera();
    await requestWakeLock();
    unlockSpeech();
    running = true;
    lastSpoken = '';
    nextReadAt = Date.now() + FIRST_READ_DELAY;
    document.body.classList.add('is-live');
    answerEl.textContent = '最初の読み取りを待っています';
    paintCountdown(Date.now());
    loop();
  } catch (error) {
    const insecure = location.protocol !== 'https:' && location.hostname !== 'localhost';
    gateError.textContent = insecure
      ? 'このアドレスではカメラを使えません。https のアドレスで開き直してください。'
      : `カメラを開始できません。${error.message}`;
  } finally {
    startBtn.disabled = false;
  }
}

function stop() {
  session += 1;
  running = false;
  clearTimeout(loopTimer);
  video.style.transform = 'none';
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  speechSynthesis.cancel();
  document.body.classList.remove('is-live');
  setStatus('待機しています');
}

async function refreshHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    hasKey = Boolean(data.hasKey);
    keyState.textContent = hasKey ? 'APIキーは保存済みです。' : 'APIキーが未設定です。';
    keyState.className = hasKey ? 'hint is-ok' : 'hint is-bad';
    if (!localStorage.getItem('tm-model') && data.model) modelSelect.value = data.model;
    if (Array.isArray(data.phoneUrls) && data.phoneUrls.length) {
      phoneUrls.textContent = `スマホからは ${data.phoneUrls.join(' または ')} を開いてください。警告が出たら詳細から進みます。`;
    }
  } catch {
    keyState.textContent = 'サーバーに接続できません。';
    keyState.className = 'hint is-bad';
  }
}

async function saveKey() {
  saveKeyBtn.disabled = true;
  try {
    const response = await fetch('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKeyInput.value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '保存できませんでした');
    apiKeyInput.value = '';
    await refreshHealth();
  } catch (error) {
    keyState.textContent = error.message;
    keyState.className = 'hint is-bad';
  } finally {
    saveKeyBtn.disabled = false;
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.body.classList.add('is-live');
    solveImage(String(reader.result), 'manual');
  };
  reader.readAsDataURL(file);
});

startBtn.addEventListener('click', start);
onceBtn.addEventListener('click', () => {
  if (!video.videoWidth) return;
  nextReadAt = Date.now() + READ_EVERY;
  solveImage(captureFrame(), 'manual');
});
stopBtn.addEventListener('click', stop);
flipBtn.addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  if (!running) return;
  try {
    await openCamera();
  } catch (error) {
    setStatus(error.message);
  }
});

zoomInput.addEventListener('input', () => applyZoom(zoomInput.value));
zoomInBtn.addEventListener('click', () => zoomBy(1));
zoomOutBtn.addEventListener('click', () => zoomBy(-1));

document.addEventListener('touchstart', (event) => {
  if (!running || event.touches.length !== 2) return;
  pinchStartDist = touchDistance(event.touches[0], event.touches[1]);
  pinchStartZoom = zoom;
}, { passive: true });

document.addEventListener('touchmove', (event) => {
  if (!running || event.touches.length !== 2 || !pinchStartDist) return;
  event.preventDefault();
  const dist = touchDistance(event.touches[0], event.touches[1]);
  applyZoom(pinchStartZoom * (dist / pinchStartDist));
}, { passive: false });

document.addEventListener('touchend', () => {
  pinchStartDist = 0;
});

video.addEventListener('wheel', (event) => {
  if (!running) return;
  event.preventDefault();
  zoomBy(event.deltaY < 0 ? 1 : -1);
}, { passive: false });

document.querySelector('#close-settings').addEventListener('click', () => settingsDialog.close());
document.querySelector('#settings-form').addEventListener('submit', (event) => event.preventDefault());
document.querySelector('#open-settings').addEventListener('click', () => settingsDialog.showModal());
document.querySelector('#settings-btn').addEventListener('click', () => settingsDialog.showModal());

saveKeyBtn.addEventListener('click', saveKey);
modelSelect.addEventListener('change', () => remember('tm-model', modelSelect.value));
rateInput.addEventListener('input', () => remember('tm-rate', rateInput.value));
autoInput.addEventListener('change', () => {
  remember('tm-auto', autoInput.checked ? '1' : '0');
  if (autoInput.checked && running) nextReadAt = Date.now() + 500;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) requestWakeLock();
});

if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener?.('voiceschanged', () => pickVoice());
  setInterval(() => {
    if (speechSynthesis.speaking && speechSynthesis.paused) speechSynthesis.resume();
  }, 800);
}

refreshHealth();
