/* Parlor — the connection.
   One RTCPeerConnection per room: a reliable data channel for messages and
   picture chunks, plus two pre-made transceivers so camera, microphone and
   screen sharing can be switched on later without renegotiating anything. */

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const CHANNEL = 'parlor';
const GATHER_TIMEOUT = 4000;      // ms to wait for a complete ICE candidate set
const BUFFER_HIGH = 1 << 20;      // pause sending above 1 MB queued
const BUFFER_LOW = 1 << 18;

/* ── Signal codec ──────────────────────────────────────────────────────────
   An invite is just an SDP blob. It is deflated where the browser can do it
   ("P1"), otherwise passed through as plain base64 ("P0"), then base64url'd so
   it survives a URL fragment, a chat app and a double click. */

const b64url = {
  encode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

async function squeeze(bytes, method) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(method));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unsqueeze(bytes, method) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(method));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeSignal(value) {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === 'function') {
    try { return 'P1' + b64url.encode(await squeeze(raw, 'deflate-raw')); } catch { /* fall through */ }
  }
  return 'P0' + b64url.encode(raw);
}

/* Pull the code out of whatever was pasted. People paste the invite link as
   often as the code inside it, so accept both. */
function unwrapCode(input) {
  const text = String(input ?? '').trim();
  const link = /[#&]i=([^&\s]+)/.exec(text);
  let raw = text;
  if (link) {
    try { raw = decodeURIComponent(link[1]); } catch { raw = link[1]; }
  }
  return raw.replace(/\s+/g, '');
}

/* Every step here can fail on a code that was truncated by a chat app, mangled
   by a copy, or compressed by a browser newer than this one. Each failure gets
   a message that says what to do about it, because the alternative is a raw
   DOMException in the dialog. */
export async function decodeSignal(code) {
  const text = unwrapCode(code);
  if (!text) throw new Error('There is no code here to read.');

  const tag = text.slice(0, 2);
  const body = text.slice(2);
  if (tag !== 'P0' && tag !== 'P1') {
    throw new Error('That does not look like a Parlor code. It is one long run of letters and numbers beginning with P0 or P1 — the invite link containing it works here too.');
  }
  if (tag === 'P1' && typeof DecompressionStream !== 'function') {
    throw new Error('That code is compressed and this browser cannot unpack it. Chrome 103, Firefox 113 and Safari 16.4 — or anything newer — can: open Parlor in one of those and join again.');
  }

  let bytes;
  try {
    bytes = b64url.decode(body);
  } catch {
    throw new Error('That code could not be read; some of it is missing or was altered in copying. Copy the whole block and paste it again.');
  }

  if (tag === 'P1') {
    try {
      bytes = await unsqueeze(bytes, 'deflate-raw');
    } catch {
      throw new Error('That code could not be unpacked — it was most likely cut short on the way here. Ask for it again and paste all of it.');
    }
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The connection details in that code are damaged. Copy the code again, from its first character to its last.');
  }

  if (!value || !value.sdp || !value.type) throw new Error('That code is missing its connection details.');
  return value;
}

/* ── PeerLink ──────────────────────────────────────────────────────────── */

export class PeerLink extends EventTarget {
  constructor() {
    super();
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.channel = null;
    this.videoSender = null;
    this.audioSender = null;
    this.remoteStream = new MediaStream();
    this.closed = false;

    this.pc.addEventListener('connectionstatechange', () => {
      this.#emit('state', this.pc.connectionState);
      if (this.pc.connectionState === 'failed') this.#emit('failed');
    });

    this.pc.addEventListener('track', (ev) => {
      const track = ev.track;
      this.remoteStream.addTrack(track);
      const report = () => this.#emit('remotemedia', {
        video: this.#liveKind('video'),
        audio: this.#liveKind('audio'),
      });
      track.addEventListener('mute', report);
      track.addEventListener('unmute', report);
      track.addEventListener('ended', report);
      this.#emit('track', this.remoteStream);
      report();
    });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #liveKind(kind) {
    return this.remoteStream.getTracks().some((t) => t.kind === kind && t.readyState === 'live' && !t.muted);
  }

  #bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.addEventListener('open', () => this.#emit('open'));
    channel.addEventListener('close', () => this.#emit('close'));
    channel.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        let parsed;
        try { parsed = JSON.parse(ev.data); } catch { return; }
        this.#emit('message', parsed);
      } else {
        this.#emit('binary', ev.data);
      }
    });
  }

  /* Both sides end up with one audio and one video transceiver, made before the
     offer, so turning a camera on later is only a replaceTrack call. The
     answering side has to opt back into sending: a transceiver it did not
     create starts out recvonly, which would leave the caller unable to ever
     receive its camera. */
  #bindSenders() {
    for (const t of this.pc.getTransceivers()) {
      const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
      if (kind === 'video' && !this.videoSender) this.videoSender = t.sender;
      if (kind === 'audio' && !this.audioSender) this.audioSender = t.sender;
      if (t.direction !== 'sendrecv') {
        try { t.direction = 'sendrecv'; } catch { /* already negotiated */ }
      }
    }
  }

  #gathered() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, GATHER_TIMEOUT);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** Host side: returns the invite code to hand to the other person. */
  async createInvite() {
    this.#bindChannel(this.pc.createDataChannel(CHANNEL, { ordered: true }));
    this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.#bindSenders();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.#gathered();
    return encodeSignal({ type: 'offer', sdp: this.pc.localDescription.sdp });
  }

  /** Guest side: consumes an invite code, returns the reply code. */
  async acceptInvite(code) {
    const offer = await decodeSignal(code);
    if (offer.type !== 'offer') throw new Error('That is a reply code, not an invite code.');
    this.pc.addEventListener('datachannel', (ev) => this.#bindChannel(ev.channel));
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.#bindSenders();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.#gathered();
    return encodeSignal({ type: 'answer', sdp: this.pc.localDescription.sdp });
  }

  /** Host side: consumes the reply code and completes the connection. */
  async acceptReply(code) {
    const answer = await decodeSignal(code);
    if (answer.type !== 'answer') throw new Error('That is an invite code, not a reply code.');
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('This room is no longer waiting for a reply.');
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  get open() {
    return this.channel?.readyState === 'open';
  }

  send(value) {
    if (!this.open) return false;
    this.channel.send(JSON.stringify(value));
    return true;
  }

  /** Binary send with back-pressure, so a large picture cannot blow the queue. */
  async sendBinary(buffer) {
    if (!this.open) return false;
    if (this.channel.bufferedAmount > BUFFER_HIGH) {
      await new Promise((resolve) => {
        const done = () => { this.channel.removeEventListener('bufferedamountlow', done); resolve(); };
        this.channel.addEventListener('bufferedamountlow', done);
      });
      if (!this.open) return false;
    }
    this.channel.send(buffer);
    return true;
  }

  async setTrack(kind, track) {
    const sender = kind === 'video' ? this.videoSender : this.audioSender;
    if (!sender) return false;
    await sender.replaceTrack(track || null);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.channel?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    for (const track of this.remoteStream.getTracks()) this.remoteStream.removeTrack(track);
    this.#emit('close');
  }
}
