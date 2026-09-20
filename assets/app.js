/* Parlor — the room.
   Wires the page to a PeerLink: message log, camera/mic/screen controls, and
   picture transfer over the data channel. */

import { PeerLink } from './rtc.js';
import { prefs, log, pictures, prepare, formatBytes } from './store.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v; else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
};

const CHUNK = 16 * 1024;
const ID_BYTES = 16;
const TYPING_TIMEOUT = 3000;

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const newId = () => (crypto.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(36, '0'))
  .replace(/-/g, '').slice(0, 32);

/* ── State ─────────────────────────────────────────────────────────────── */

const state = {
  link: null,
  bot: null,              // the loopback demo's second peer, when running
  role: null,             // 'host' | 'guest' | 'demo'
  peerName: 'Them',
  myName: (prefs.read().name || '').trim(),
  entries: [],
  urls: new Map(),        // picture id → object URL
  incoming: new Map(),    // picture id → { meta, parts, got }
  camera: null,           // MediaStream from getUserMedia
  screen: null,           // MediaStream from getDisplayMedia
  cam: false,
  mic: false,
  share: false,
  typingTimer: null,
  lastTypingSent: 0,
};

/* ── Theme ─────────────────────────────────────────────────────────────── */

const THEMES = ['auto', 'light', 'dark'];

function setTheme(name) {
  document.documentElement.dataset.theme = name;
  $('theme-label').textContent = name[0].toUpperCase() + name.slice(1);
  prefs.patch({ theme: name });
}

$('theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length];
  setTheme(next);
});

setTheme(THEMES.includes(prefs.read().theme) ? prefs.read().theme : 'auto');

/* ── Status ────────────────────────────────────────────────────────────── */

function setStatus(stateName, text) {
  $('status-dot').dataset.state = stateName;
  $('status-text').textContent = text;
}

function setRoomSub(text) {
  $('room-sub').textContent = text;
}

/* ── The log ───────────────────────────────────────────────────────────── */

function persist() {
  log.write(state.entries.filter((e) => e.kind !== 'system' && e.state !== 'failed'));
}

function addEntry(entry, { save = true } = {}) {
  state.entries.push(entry);
  $('log').append(renderEntry(entry));
  $('log-empty').hidden = true;
  scrollLog();
  if (save) persist();
  return entry;
}

function scrollLog() {
  const box = $('log');
  box.scrollTop = box.scrollHeight;
}

function entryNode(id) {
  return $('log').querySelector(`[data-entry="${id}"]`);
}

function renderEntry(entry) {
  const li = el('li', { class: `bubble ${entry.kind === 'system' ? 'system' : entry.mine ? 'me' : 'them'}`, 'data-entry': entry.id });

  if (entry.kind === 'system') {
    li.append(el('p', { class: 'bubble-body' }, entry.text));
    return li;
  }

  if (entry.kind === 'image') {
    const box = el('div', { class: 'bubble-body bubble-img' });
    const button = el('button', { type: 'button', 'aria-label': `Open ${entry.name}` });
    const img = el('img', {
      alt: entry.mine ? `Picture you sent: ${entry.name}` : `Picture from ${state.peerName}: ${entry.name}`,
    });
    if (entry.width && entry.height) { img.width = entry.width; img.height = entry.height; }
    const url = state.urls.get(entry.id);
    if (url) img.src = url;
    button.append(img);
    button.addEventListener('click', () => openLightbox(entry));
    box.append(button);

    const progress = el('div', { class: 'img-progress' });
    progress.append(el('i'));
    if (entry.state === 'sent') progress.hidden = true;
    box.append(progress);

    box.append(el('p', { class: 'img-caption' }, ''));
    const caption = box.querySelector('.img-caption');
    caption.append(el('span', {}, entry.name));
    caption.append(el('span', {}, formatBytes(entry.size)));

    li.append(box);
    li.append(metaLine(entry));
    return li;
  }

  li.append(el('p', { class: 'bubble-body' }, entry.text));
  li.append(metaLine(entry));
  return li;
}

function metaLine(entry) {
  const meta = el('p', { class: 'bubble-meta' });
  meta.append(el('span', {}, entry.mine ? 'You' : (entry.from || state.peerName)));
  meta.append(el('span', {}, '·'));
  meta.append(el('time', { datetime: new Date(entry.ts).toISOString() }, fmtTime.format(new Date(entry.ts))));
  if (entry.mine && entry.state) {
    meta.append(el('span', {}, '·'));
    meta.append(el('span', { class: 'state' }, entry.state === 'sent' ? 'Sent' : entry.state === 'pending' ? 'Sending…' : 'Not delivered'));
  }
  return meta;
}

function updateProgress(id, ratio) {
  const node = entryNode(id);
  if (!node) return;
  const bar = node.querySelector('.img-progress');
  if (!bar) return;
  bar.hidden = false;
  bar.querySelector('i').style.width = `${Math.round(ratio * 100)}%`;
  if (ratio >= 1) setTimeout(() => { bar.hidden = true; }, 400);
}

function markState(entry, value) {
  entry.state = value;
  const node = entryNode(entry.id);
  const label = node?.querySelector('.state');
  if (label) label.textContent = value === 'sent' ? 'Sent' : value === 'pending' ? 'Sending…' : 'Not delivered';
  node?.classList.toggle('pending', value === 'pending');
  persist();
}

function systemLine(text) {
  addEntry({ id: newId(), kind: 'system', ts: Date.now(), text }, { save: false });
}

/* ── Pictures ──────────────────────────────────────────────────────────── */

function pictureURL(id, blob) {
  if (state.urls.has(id)) return state.urls.get(id);
  const url = URL.createObjectURL(blob);
  state.urls.set(id, url);
  return url;
}

async function sendPictures(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  if (!state.link?.open) {
    systemLine('Connect to someone before sending pictures.');
    return;
  }
  for (const file of images) {
    try { await sendPicture(file); }
    catch (err) { systemLine(`${file.name || 'That picture'} could not be sent — ${err.message}`); }
  }
}

async function sendPicture(file) {
  const ready = await prepare(file);
  const buffer = await ready.blob.arrayBuffer();
  const id = newId();
  const chunks = Math.max(1, Math.ceil(buffer.byteLength / CHUNK));
  const ts = Date.now();

  await pictures.put({ id, blob: ready.blob, name: ready.name, width: ready.width, height: ready.height, ts, mine: true });
  pictureURL(id, ready.blob);

  const entry = addEntry({
    id, kind: 'image', mine: true, ts, state: 'pending',
    name: ready.name, size: ready.blob.size, width: ready.width, height: ready.height,
  });
  refreshGalleryCount();

  const meta = {
    t: 'img', id, name: ready.name, size: ready.blob.size, mime: ready.type,
    width: ready.width, height: ready.height, chunks, ts,
  };
  if (!state.link.send(meta)) throw new Error('the connection dropped');

  for (let i = 0; i < chunks; i++) {
    const slice = buffer.slice(i * CHUNK, (i + 1) * CHUNK);
    const ok = await state.link.sendBinary(frame(id, i, slice));
    if (!ok) { markState(entry, 'failed'); throw new Error('the connection dropped'); }
    updateProgress(id, (i + 1) / chunks);
  }
  markState(entry, 'sent');
}

function frame(idHex, index, chunk) {
  const out = new Uint8Array(ID_BYTES + 4 + chunk.byteLength);
  for (let i = 0; i < ID_BYTES; i++) out[i] = parseInt(idHex.slice(i * 2, i * 2 + 2), 16);
  new DataView(out.buffer).setUint32(ID_BYTES, index);
  out.set(new Uint8Array(chunk), ID_BYTES + 4);
  return out.buffer;
}

function unframe(buffer) {
  const bytes = new Uint8Array(buffer);
  let id = '';
  for (let i = 0; i < ID_BYTES; i++) id += bytes[i].toString(16).padStart(2, '0');
  return { id, index: new DataView(buffer).getUint32(ID_BYTES), chunk: bytes.slice(ID_BYTES + 4) };
}

function onPictureMeta(meta) {
  state.incoming.set(meta.id, { meta, parts: new Array(meta.chunks), got: 0 });
  addEntry({
    id: meta.id, kind: 'image', mine: false, ts: meta.ts || Date.now(), state: 'pending',
    name: meta.name, size: meta.size, width: meta.width, height: meta.height, from: state.peerName,
  }, { save: false });
  updateProgress(meta.id, 0);
}

async function onPictureChunk(buffer) {
  const { id, index, chunk } = unframe(buffer);
  const pending = state.incoming.get(id);
  if (!pending || pending.parts[index]) return;
  pending.parts[index] = chunk;
  pending.got += 1;
  updateProgress(id, pending.got / pending.meta.chunks);
  if (pending.got < pending.meta.chunks) return;

  state.incoming.delete(id);
  const blob = new Blob(pending.parts, { type: pending.meta.mime || 'image/jpeg' });
  const record = {
    id, blob, name: pending.meta.name, width: pending.meta.width, height: pending.meta.height,
    ts: pending.meta.ts || Date.now(), mine: false,
  };
  await pictures.put(record);
  const url = pictureURL(id, blob);
  const img = entryNode(id)?.querySelector('img');
  if (img) img.src = url;
  const entry = state.entries.find((e) => e.id === id);
  if (entry) { entry.state = 'sent'; persist(); }
  refreshGalleryCount();
  addGalleryTile(record);
}

/* ── Gallery ───────────────────────────────────────────────────────────── */

function refreshGalleryCount() {
  $('gallery-count').textContent = String(state.urls.size);
}

function addGalleryTile(record) {
  const grid = $('gallery-grid');
  if (grid.querySelector(`[data-pic="${record.id}"]`)) return;
  const button = el('button', { type: 'button', 'data-pic': record.id, 'aria-label': `Open ${record.name}` });
  const img = el('img', { alt: record.name, src: pictureURL(record.id, record.blob), loading: 'lazy' });
  button.append(img);
  button.addEventListener('click', () => openLightbox({
    id: record.id, name: record.name, ts: record.ts, mine: record.mine, size: record.blob.size,
  }));
  grid.prepend(button);
  $('gallery-empty').hidden = true;
}

$('btn-gallery').addEventListener('click', () => {
  const panel = $('gallery');
  const showing = panel.hidden;
  panel.hidden = !showing;
  $('btn-gallery').setAttribute('aria-expanded', String(showing));
  if (showing) panel.scrollIntoView({ block: 'nearest' });
});
$('btn-gallery-close').addEventListener('click', () => {
  $('gallery').hidden = true;
  $('btn-gallery').setAttribute('aria-expanded', 'false');
  $('btn-gallery').focus();
});

/* ── Lightbox ──────────────────────────────────────────────────────────── */

function openLightbox(entry) {
  const url = state.urls.get(entry.id);
  if (!url) return;
  $('lightbox-img').src = url;
  $('lightbox-img').alt = entry.name || 'Shared picture';
  $('lightbox-cap').textContent = `${entry.name} · ${formatBytes(entry.size || 0)} · ${entry.mine ? 'sent by you' : `from ${entry.from || state.peerName}`}`;
  const link = $('lightbox-download');
  link.href = url;
  link.setAttribute('download', entry.name || 'picture');
  $('lightbox').showModal();
}

/* ── Composer ──────────────────────────────────────────────────────────── */

const textarea = $('msg');

textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  sendTyping();
});

textarea.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    $('composer').requestSubmit();
  }
});

textarea.addEventListener('paste', (ev) => {
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { ev.preventDefault(); sendPictures(files); }
});

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = '';
  textarea.style.height = 'auto';

  const entry = addEntry({ id: newId(), kind: 'text', mine: true, ts: Date.now(), text, state: 'pending' });
  if (state.link?.send({ t: 'msg', id: entry.id, text, ts: entry.ts })) {
    markState(entry, 'sent');
  } else {
    markState(entry, 'failed');
    systemLine('Not connected — that message stayed on this device.');
  }
});

function sendTyping() {
  const now = Date.now();
  if (!state.link?.open || now - state.lastTypingSent < 1200) return;
  state.lastTypingSent = now;
  state.link.send({ t: 'typing' });
}

function showTyping() {
  $('typing-name').textContent = `${state.peerName} is typing…`;
  $('typing').hidden = false;
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => { $('typing').hidden = true; }, TYPING_TIMEOUT);
}

$('btn-attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (ev) => {
  sendPictures(ev.target.files);
  ev.target.value = '';
});

$('btn-clear').addEventListener('click', async () => {
  if (!confirm('Delete every message and picture stored in this browser?')) return;
  log.clear();
  await pictures.clear();
  for (const url of state.urls.values()) URL.revokeObjectURL(url);
  state.urls.clear();
  state.entries = [];
  $('log').textContent = '';
  $('log').append($('log-empty'));
  $('log-empty').hidden = false;
  $('gallery-grid').textContent = '';
  $('gallery-empty').hidden = false;
  refreshGalleryCount();
});

/* ── Drag and drop ─────────────────────────────────────────────────────── */

let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (ev) => {
  if (!hasFiles(ev)) return;
  dragDepth += 1;
  $('drop-veil').hidden = false;
});
window.addEventListener('dragover', (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-veil').hidden = true;
});
window.addEventListener('drop', (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  $('drop-veil').hidden = true;
  sendPictures(ev.dataTransfer.files);
});

/* ── Camera, microphone, screen ────────────────────────────────────────── */

async function ensureCamera(want) {
  const has = (kind) => state.camera?.getTracks().some((t) => t.kind === kind && t.readyState === 'live');
  const need = { video: want.video && !has('video'), audio: want.audio && !has('audio') };
  if (!need.video && !need.audio) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser will not give a page access to the camera.');

  const stream = await navigator.mediaDevices.getUserMedia({
    video: need.video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    audio: need.audio ? { echoCancellation: true, noiseSuppression: true } : false,
  });
  if (!state.camera) state.camera = new MediaStream();
  for (const track of stream.getTracks()) state.camera.addTrack(track);
}

function stopTrackKind(kind) {
  for (const track of state.camera?.getTracks() || []) {
    if (track.kind === kind) { track.stop(); state.camera.removeTrack(track); }
  }
}

async function toggleCamera() {
  try {
    if (state.cam) {
      state.cam = false;
      stopTrackKind('video');
      if (!state.share) await state.link?.setTrack('video', null);
    } else {
      await ensureCamera({ video: true, audio: false });
      state.cam = true;
      if (!state.share) await state.link?.setTrack('video', cameraTrack('video'));
    }
  } catch (err) { mediaError(err); }
  syncMedia();
}

async function toggleMic() {
  try {
    if (state.mic) {
      state.mic = false;
      stopTrackKind('audio');
      await state.link?.setTrack('audio', null);
    } else {
      await ensureCamera({ video: false, audio: true });
      state.mic = true;
      await state.link?.setTrack('audio', cameraTrack('audio'));
    }
  } catch (err) { mediaError(err); }
  syncMedia();
}

async function toggleShare() {
  try {
    if (state.share) {
      stopShare();
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share a screen.');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      state.screen = stream;
      state.share = true;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { stopShare(); syncMedia(); });
      await state.link?.setTrack('video', stream.getVideoTracks()[0] || null);
    }
  } catch (err) { if (err.name !== 'NotAllowedError') mediaError(err); }
  syncMedia();
}

function stopShare() {
  for (const track of state.screen?.getTracks() || []) track.stop();
  state.screen = null;
  state.share = false;
  state.link?.setTrack('video', state.cam ? cameraTrack('video') : null);
}

function cameraTrack(kind) {
  return state.camera?.getTracks().find((t) => t.kind === kind && t.readyState === 'live') || null;
}

function mediaError(err) {
  const reason = err.name === 'NotAllowedError' ? 'permission was declined'
    : err.name === 'NotFoundError' ? 'no device was found'
    : err.message || 'the device is unavailable';
  systemLine(`Could not start that — ${reason}.`);
}

/** Reflect local media state in the controls, the self view and the peer. */
function syncMedia() {
  $('btn-cam').setAttribute('aria-pressed', String(state.cam));
  $('btn-mic').setAttribute('aria-pressed', String(state.mic));
  $('btn-share').setAttribute('aria-pressed', String(state.share));

  const showing = state.share ? state.screen : (state.cam ? state.camera : null);
  const selfView = $('self-view');
  selfView.hidden = !showing;
  selfView.classList.toggle('sharing', state.share);
  const local = $('local-video');
  if (showing && local.srcObject !== showing) local.srcObject = showing;
  if (!showing) local.srcObject = null;

  const bits = [];
  if (state.share) bits.push('sharing your screen');
  else if (state.cam) bits.push('camera on');
  if (state.mic) bits.push('microphone on');
  $('ctl-note').textContent = state.link?.open
    ? (bits.length ? `You are ${bits.join(' and ')}.` : 'Your camera and microphone are off.')
    : 'Not connected yet — turn these on now and they will start as soon as the room opens.';

  state.link?.send({ t: 'media', video: state.cam || state.share, audio: state.mic, screen: state.share });
}

$('btn-cam').addEventListener('click', toggleCamera);
$('btn-mic').addEventListener('click', toggleMic);
$('btn-share').addEventListener('click', toggleShare);

function stopAllMedia() {
  for (const track of state.camera?.getTracks() || []) track.stop();
  for (const track of state.screen?.getTracks() || []) track.stop();
  state.camera = null;
  state.screen = null;
  state.cam = state.mic = state.share = false;
  syncMedia();
}

/* ── Remote media ──────────────────────────────────────────────────────── */

function showRemote(stream) {
  const video = $('remote-video');
  if (video.srcObject !== stream) video.srcObject = stream;
  video.play?.().catch(() => { /* autoplay can wait for a gesture */ });
}

function setRemoteMedia({ video, audio, screen }) {
  const stage = document.querySelector('.stage-video');
  const appearing = Boolean(video) && !stage.classList.contains('has-remote');
  stage.classList.toggle('has-remote', Boolean(video));
  if (appearing) $('remote-video').play?.().catch(() => { /* waits for a gesture */ });
  $('stage-placeholder-text').textContent = audio
    ? `${state.peerName} has audio on but no camera.`
    : state.link?.open ? `${state.peerName} has not turned a camera on yet.` : 'No one has turned a camera on yet.';
  const badge = $('peer-badge');
  badge.hidden = !state.link?.open;
  badge.textContent = screen ? `${state.peerName} · screen` : state.peerName;
}

/* ── Wiring a link ─────────────────────────────────────────────────────── */

function wire(link) {
  state.link = link;

  link.addEventListener('state', (ev) => {
    const value = ev.detail;
    if (value === 'connected') setStatus('live', `Connected to ${state.peerName}`);
    else if (value === 'connecting') setStatus('pending', 'Connecting…');
    else if (value === 'failed') {
      setStatus('failed', 'Connection failed');
      systemLine('The direct connection could not be made. Strict networks sometimes block this; trying again on another network usually works.');
    } else if (value === 'disconnected') setStatus('pending', 'Reconnecting…');
  });

  link.addEventListener('open', async () => {
    setStatus('live', `Connected to ${state.peerName}`);
    setRoomSub('You are connected. Messages, video and pictures all travel over this link.');
    $('leave').hidden = false;
    link.send({ t: 'hello', name: state.myName || 'Anon' });
    // Whatever was already switched on locally starts flowing now.
    if (state.share) await link.setTrack('video', state.screen?.getVideoTracks()[0] || null);
    else if (state.cam) await link.setTrack('video', cameraTrack('video'));
    if (state.mic) await link.setTrack('audio', cameraTrack('audio'));
    syncMedia();
    closeSheet();
  });

  link.addEventListener('message', (ev) => onMessage(ev.detail));
  link.addEventListener('binary', (ev) => onPictureChunk(ev.detail));
  link.addEventListener('track', (ev) => showRemote(ev.detail));
  link.addEventListener('remotemedia', (ev) => setRemoteMedia(ev.detail));

  link.addEventListener('close', () => {
    if (state.link !== link) return;
    setStatus('idle', 'Not connected');
    $('peer-badge').hidden = true;
    document.querySelector('.stage-video').classList.remove('has-remote');
  });
}

function onMessage(msg) {
  switch (msg?.t) {
    case 'hello':
      state.peerName = String(msg.name || 'Them').slice(0, 24);
      setStatus('live', `Connected to ${state.peerName}`);
      $('peer-badge').hidden = false;
      $('peer-badge').textContent = state.peerName;
      systemLine(`${state.peerName} joined the room.`);
      break;
    case 'msg':
      addEntry({ id: msg.id || newId(), kind: 'text', mine: false, ts: msg.ts || Date.now(), text: String(msg.text || ''), from: state.peerName });
      $('typing').hidden = true;
      break;
    case 'typing':
      showTyping();
      break;
    case 'img':
      onPictureMeta(msg);
      break;
    case 'media':
      setRemoteMedia(msg);
      break;
    case 'bye':
      systemLine(`${state.peerName} left the room.`);
      break;
    default:
      break;
  }
}

function leave({ quiet = false } = {}) {
  state.link?.send({ t: 'bye' });
  state.link?.close();
  state.bot?.close();
  state.link = null;
  state.bot = null;
  state.role = null;
  state.incoming.clear();
  stopAllMedia();
  $('leave').hidden = true;
  $('typing').hidden = true;
  setStatus('idle', 'Not connected');
  setRoomSub('Start a room to get an invite code, or paste one you were sent.');
  $('remote-video').srcObject = null;
  document.querySelector('.stage-video').classList.remove('has-remote');
  $('peer-badge').hidden = true;
  $('stage-placeholder-text').textContent = 'No one has turned a camera on yet.';
  if (!quiet) systemLine('You left the room.');
}

$('leave').addEventListener('click', () => leave());
window.addEventListener('pagehide', () => { state.link?.send({ t: 'bye' }); });

/* ── The connect sheet ─────────────────────────────────────────────────── */

const sheet = $('connect');

const COPY = {
  create: {
    title: 'Start a room',
    sub: 'Send the invite code to the person you want to talk to, then paste their reply back here.',
    step1: ['Send them this invite code', 'It carries everything their browser needs to reach yours. The link does the same thing, if that is easier to send.'],
    step2: ['Paste their reply', 'Joining gives them a reply code. Drop it in here and the room opens.'],
  },
  join: {
    title: 'Join a room',
    sub: 'Paste the invite code you were sent, then send your reply back to whoever invited you.',
    step1: ['Paste the invite code', 'It is the long block of text — or the link — they sent you.'],
    step2: ['Send them this reply code', 'The room opens the moment they paste it into their window.'],
  },
};

function sheetError(text) {
  const box = $('sheet-error');
  box.textContent = text || '';
  box.hidden = !text;
}

function note(id, text) {
  $(id).textContent = text;
  if (text) setTimeout(() => { if ($(id).textContent === text) $(id).textContent = ''; }, 2600);
}

function layoutSheet(mode) {
  const copy = COPY[mode];
  $('connect-title').textContent = copy.title;
  $('connect-sub').textContent = copy.sub;
  $('step1-h').textContent = copy.step1[0];
  $('step1-sub').textContent = copy.step1[1];
  $('step2-h').textContent = copy.step2[0];
  $('step2-sub').textContent = copy.step2[1];

  const step1 = sheet.querySelector('[data-step="1"]');
  const step2 = sheet.querySelector('[data-step="2"]');
  const out = $('step1-out');

  if (mode === 'create') {
    step1.append(out);
    out.hidden = false;
    $('step1-in').hidden = true;
    $('step2-in').hidden = false;
    $('step2-waiting').hidden = true;
  } else {
    step2.insertBefore(out, $('step2-in'));
    out.hidden = true;                 // shown once the reply exists
    $('step1-in').hidden = false;
    $('step2-in').hidden = true;
    $('step2-waiting').hidden = true;
  }
  $('out-code').value = '';
  $('in-code').value = '';
  $('reply-code').value = '';
  $('step1-working').hidden = true;
  sheetError('');
}

function openSheet(mode) {
  state.role = mode;
  layoutSheet(mode);
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  if (sheet.open) sheet.close();
}

sheet.addEventListener('close', () => {
  // Backing out of a room that never connected should not leave a half-open peer.
  if (state.link && !state.link.open && state.link.pc.connectionState !== 'connected') {
    state.link.close();
    state.link = null;
    setStatus('idle', 'Not connected');
  }
});

$('display-name').addEventListener('input', (ev) => {
  state.myName = ev.target.value.trim();
  prefs.patch({ name: state.myName });
});

for (const button of document.querySelectorAll('[data-action="create"]')) {
  button.addEventListener('click', () => startRoom());
}
for (const button of document.querySelectorAll('[data-action="join"]')) {
  button.addEventListener('click', () => openSheet('join'));
}
for (const button of document.querySelectorAll('[data-action="demo"]')) {
  button.addEventListener('click', () => startDemo());
}

async function startRoom() {
  if (state.link) leave({ quiet: true });
  openSheet('create');
  $('step1-working').hidden = false;
  setStatus('pending', 'Preparing…');
  try {
    const link = new PeerLink();
    wire(link);
    const code = await link.createInvite();
    $('out-code').value = code;
    $('step1-working').hidden = true;
    setStatus('pending', 'Waiting for a reply');
    setRoomSub('Your invite code is ready — send it over, then paste their reply back.');
  } catch (err) {
    $('step1-working').hidden = true;
    sheetError(`Could not prepare a room: ${err.message}`);
    setStatus('failed', 'Could not start');
  }
}

$('accept-code').addEventListener('click', async () => {
  const code = $('in-code').value.trim();
  if (!code) { sheetError('Paste the invite code first.'); return; }
  sheetError('');
  $('step1-working').hidden = false;
  setStatus('pending', 'Joining…');
  try {
    if (state.link) { state.link.close(); state.link = null; }
    const link = new PeerLink();
    wire(link);
    const reply = await link.acceptInvite(code);
    $('out-code').value = reply;
    $('step1-out').hidden = false;
    $('step2-waiting').hidden = false;
    $('step1-working').hidden = true;
    note('accept-note', 'Reply ready');
    setRoomSub('Send your reply code back — the room opens as soon as they paste it.');
  } catch (err) {
    $('step1-working').hidden = true;
    sheetError(err.message);
    setStatus('failed', 'Could not join');
  }
});

$('finish').addEventListener('click', async () => {
  const code = $('reply-code').value.trim();
  if (!code) { sheetError('Paste their reply code first.'); return; }
  sheetError('');
  setStatus('pending', 'Connecting…');
  try {
    await state.link.acceptReply(code);
    note('finish-note', 'Connecting…');
  } catch (err) {
    sheetError(err.message);
    setStatus('failed', 'Could not connect');
  }
});

$('copy-code').addEventListener('click', () => copy($('out-code').value, 'copy-note', 'Code copied'));
$('copy-link').addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}#i=${encodeURIComponent($('out-code').value)}`;
  copy(url, 'copy-note', 'Link copied');
});

async function copy(text, noteId, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    note(noteId, message);
  } catch {
    $('out-code').select();
    note(noteId, 'Press ⌘/Ctrl+C to copy');
  }
}

/* ── Loopback demo ─────────────────────────────────────────────────────── */

async function startDemo() {
  if (state.link) leave({ quiet: true });
  setStatus('pending', 'Starting the demo…');
  try {
    const host = new PeerLink();
    const guest = new PeerLink();
    wire(host);
    state.bot = guest;
    state.role = 'demo';
    state.peerName = 'Echo';
    wireBot(guest);
    const invite = await host.createInvite();
    const reply = await guest.acceptInvite(invite);
    await host.acceptReply(reply);
    systemLine('Loopback demo: a second peer is running in this tab. It answers your messages, confirms the pictures it receives, and sends a video stream of its own. Your own camera and microphone still work — turn them on to see the self view.');
  } catch (err) {
    setStatus('failed', 'Demo could not start');
    systemLine(`The demo could not start — ${err.message}`);
  }
}

/** A drawn-on canvas, captured as a video track: the demo peer's "camera". */
function botCamera() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  const draw = () => {
    if (!state.bot) return;              // the demo ended; stop drawing
    frame += 1;
    const t = frame / 40;
    const grad = ctx.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, '#2b2b6b');
    grad.addColorStop(1, '#1b1b26');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 360);

    ctx.strokeStyle = 'rgba(154, 153, 240, .8)';
    ctx.lineWidth = 3;
    for (let ring = 0; ring < 4; ring++) {
      const r = 40 + ring * 34 + Math.sin(t + ring) * 10;
      ctx.beginPath();
      ctx.arc(320, 180, r, 0, Math.PI * 2);
      ctx.globalAlpha = 0.65 - ring * 0.12;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('Echo · loopback demo', 26, 46);
    ctx.font = '15px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, .75)';
    ctx.fillText(`frame ${frame} · ${new Date().toLocaleTimeString()}`, 26, 330);

    requestAnimationFrame(draw);
  };
  draw();

  return canvas.captureStream(24).getVideoTracks()[0];
}

function wireBot(guest) {
  const pending = new Map();

  guest.addEventListener('open', async () => {
    guest.send({ t: 'hello', name: 'Echo' });
    // The bot paints its own picture and sends it as a camera would, so the
    // stage shows a stream that really was encoded, sent and decoded.
    await guest.setTrack('video', botCamera());
    guest.send({ t: 'media', video: true, audio: false, screen: false });
  });

  guest.addEventListener('message', (ev) => {
    const msg = ev.detail;
    if (msg.t === 'msg') {
      guest.send({ t: 'typing' });
      setTimeout(() => guest.send({
        t: 'msg', id: newId(), ts: Date.now(),
        text: `Echo: “${String(msg.text).slice(0, 120)}” — ${msg.text.trim().split(/\s+/).length} word(s), received over the data channel.`,
      }), 700);
    }
    if (msg.t === 'img') pending.set(msg.id, { meta: msg, got: 0 });
  });

  guest.addEventListener('binary', (ev) => {
    const { id } = unframe(ev.detail);
    const item = pending.get(id);
    if (!item) return;
    item.got += 1;
    if (item.got < item.meta.chunks) return;
    pending.delete(id);
    guest.send({
      t: 'msg', id: newId(), ts: Date.now(),
      text: `Echo: got ${item.meta.name} in one piece — ${item.meta.width}×${item.meta.height}, ${formatBytes(item.meta.size)} across ${item.meta.chunks} chunk(s).`,
    });
  });
}

/* ── Start up ──────────────────────────────────────────────────────────── */

async function hydrate() {
  $('display-name').value = state.myName;

  const rows = await pictures.all();
  rows.sort((a, b) => a.ts - b.ts);
  for (const row of rows) pictureURL(row.id, row.blob);
  for (const row of rows) addGalleryTile(row);
  refreshGalleryCount();

  const saved = log.read();
  if (saved.length) {
    $('log-empty').hidden = true;
    for (const entry of saved) {
      if (entry.kind === 'image' && !state.urls.has(entry.id)) continue;  // never finished
      state.entries.push(entry);
      $('log').append(renderEntry(entry));
    }
    scrollLog();
  }

  syncMedia();
  setRemoteMedia({ video: false, audio: false, screen: false });

  // An invite link drops the code straight into the join sheet.
  const match = /[#&]i=([^&]+)/.exec(location.hash);
  if (match) {
    history.replaceState(null, '', location.pathname + location.search);
    openSheet('join');
    $('in-code').value = decodeURIComponent(match[1]);
    sheetError('');
    $('accept-code').focus();
  }
}

hydrate();
