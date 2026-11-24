// Sonnerie synthétisée avec la Web Audio API (aucun fichier audio à télécharger).
// "incoming" : deux bips rapides (appel entrant) ; "outgoing" : tonalité de retour d'appel.

let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function beep(ctx: AudioContext, frequency: number, start: number, duration: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

export function startRingtone(kind: "incoming" | "outgoing") {
  stopRingtone();
  try {
    context = new AudioContext();
  } catch {
    return; // pas de Web Audio : appel silencieux
  }
  const ring = () => {
    if (!context) return;
    const t = context.currentTime;
    if (kind === "incoming") {
      beep(context, 880, t, 0.25);
      beep(context, 880, t + 0.35, 0.25);
    } else {
      beep(context, 425, t, 1);
    }
  };
  ring();
  timer = setInterval(ring, kind === "incoming" ? 2000 : 4000);
}

export function stopRingtone() {
  if (timer) clearInterval(timer);
  timer = null;
  context?.close().catch(() => {});
  context = null;
}
