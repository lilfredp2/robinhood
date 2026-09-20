# Parlor — messages, video and pictures, peer to peer

A private room for two people to write to each other, see each other and send
photos. Plain HTML, CSS and three ES modules: no build step, no framework, no
accounts, and no server holding the conversation.

Open the page, start a room, send the invite code to one other person, and the
two browsers talk directly.

## What's here

```
index.html            the page
assets/styles.css     design tokens, layout, light + dark themes
assets/rtc.js         the connection: signalling codec, data channel, media senders
assets/store.js       localStorage for the message log, IndexedDB for pictures
assets/app.js         the room: chat, call controls, picture transfer, gallery
ledger/               a separate static portfolio dashboard (see ledger/README.md)
```

## Run it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server will do. Browsers only hand out the camera and
microphone on `localhost` or over HTTPS, so opening `index.html` from the
filesystem will not get you a call.

## Connecting two people

There is no signalling server, so the two browsers are introduced by hand:

1. One person clicks **Start a room**. Parlor prepares the connection and shows
   an **invite code** — and a link carrying the same code.
2. They send it to the other person however they like.
3. The other person clicks **Join with a code**, pastes it, and gets a **reply
   code** back. Opening the link fills this in for them, and pasting the whole
   link into the code box works just as well as pasting the code.
4. The reply goes back to the first window, into *Paste their reply*.

The room opens the moment that reply lands. From then on messages, camera,
microphone, screen sharing and pictures all ride the one connection.

**Try it alone.** *Run the loopback demo* on the front page starts a second peer
inside the same tab, connected over a real `RTCPeerConnection`. It answers
messages, confirms the pictures it receives chunk by chunk, and sends back a
video stream it draws itself — so the whole path is exercised without a second
device or camera permission.

## How it fits together

**Signalling.** An offer or answer is a blob of SDP. `rtc.js` waits for ICE
gathering to finish (or four seconds, whichever comes first), so every candidate
travels inside that one blob and there is no trickle channel to run. The JSON is
deflated with `CompressionStream` where the browser has it, base64url'd, and
tagged `P1` (deflated) or `P0` (plain) — roughly 1.7 KB of text to paste. A code
that arrives truncated, mangled, or compressed by a browser newer than the one
reading it is reported as that specific problem, with what to do about it,
rather than as whichever exception happened to be thrown.

**Media.** Both peers create one audio and one video transceiver *before* the
offer, so turning a camera on later is a `replaceTrack` call rather than a
renegotiation — which there would be no channel to carry. The answering side
opts its transceivers back into `sendrecv`; a transceiver it did not create
starts out `recvonly`, which would quietly leave the caller unable to ever see
its camera.

**Messages** are JSON strings on a reliable, ordered data channel: `hello`,
`msg`, `typing`, `img`, `media`, `bye`.

**Pictures** are scaled to fit 1600px and re-encoded (GIFs and anything already
under 120 KB pass through untouched), then sent as binary frames of 16 KB, each
prefixed with the picture's 16-byte id and a chunk index. The sender waits on
`bufferedamountlow` when the queue passes 1 MB, so a large photo cannot drown
the channel that the messages share. The receiver reassembles the chunks, stores
the blob and swaps it into the bubble that was already showing a progress bar.

## What is stored, and where

| What | Where | Cleared by |
|---|---|---|
| Message log (last 300) | `localStorage` | **Clear** in the message header |
| Pictures sent and received | IndexedDB (`parlor` / `pictures`) | **Clear** |
| Display name, theme | `localStorage` | browser site data |

Nothing is uploaded — there is no service behind the page to upload it to. Both
stores are written through guards, so a browser with storage blocked keeps
working and simply forgets.

## Limits worth knowing

- **Two people per room.** One peer connection, one other person.
- **No relay.** Parlor uses public STUN servers and ships no TURN server, so on
  networks that block direct connections (some corporate and mobile networks)
  the connection will not complete. The status pill says *Connection failed*
  rather than hanging silently.
- **An invite code is a door key.** Anyone holding an unused one can take the
  other seat, so send it over a channel you trust. Codes stop working when the
  tab closes.
- **The tab is the room.** Closing it ends the call; the log and pictures are
  still there when you come back, but the connection has to be made again.
- **Screen sharing** needs `getDisplayMedia`, which desktop browsers have and
  most mobile ones do not. The button reports it rather than failing quietly.

## Deploy

It is a static site, so anything that serves files will do. For GitHub Pages:
**Settings → Pages → Build and deployment → Deploy from a branch**, pick this
branch and the `/ (root)` folder. `.nojekyll` is already in place, so Pages
serves the directory as-is and `ledger/` stays reachable at `/ledger/`.

Pages serves over HTTPS, which is what the camera and microphone require.
