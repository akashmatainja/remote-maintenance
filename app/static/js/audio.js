// Remote voices. Phone browsers refuse to play sound until the user has tapped the page,
// which is the usual reason "I can't hear the expert". When playback is blocked we call
// onBlocked so the page can show a "Tap to hear" button, then unlockAudio() on that tap.

let blockedHandler = () => {};
export function onAudioBlocked(fn) { blockedHandler = fn; }

function tryPlay(el) {
  const p = el.play?.();
  if (p?.catch) p.catch((err) => { if (err?.name === "NotAllowedError") blockedHandler(); });
}

export function attachAudio(track) {
  const el = document.createElement("audio");
  el.autoplay = true;
  el.playsInline = true;
  el.dataset.pid = track.getParticipantId();
  document.body.appendChild(el);
  track.attach(el);
  tryPlay(el);
}

export function detachAudio(track) {
  document.querySelectorAll(`audio[data-pid="${track.getParticipantId()}"]`).forEach((e) => e.remove());
}

/** Call from a tap/click handler. Resolves true when every voice is playing. */
export async function unlockAudio() {
  const results = await Promise.allSettled([...document.querySelectorAll("audio")].map((e) => e.play()));
  return results.every((r) => r.status === "fulfilled");
}
