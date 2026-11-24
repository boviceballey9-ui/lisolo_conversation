import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../format";

interface Props {
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
}

const MIN_DURATION_MS = 1000;

// Format d'enregistrement supporté par le navigateur (Chrome/Firefox : webm/opus, Safari : mp4).
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

// Bouton micro « maintenir pour enregistrer », comme WhatsApp :
// appuyer → enregistre ; relâcher → envoie ; glisser hors du bouton → annule.
export function VoiceRecorder({ onRecorded, onError }: Props) {
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const pressed = useRef(false); // le doigt / la souris est-il toujours appuyé ?
  const shouldSend = useRef(false);

  // Chronomètre pendant l'enregistrement.
  useEffect(() => {
    if (recordingSince === null) return;
    const timer = setInterval(() => setElapsed(Date.now() - recordingSince), 200);
    return () => clearInterval(timer);
  }, [recordingSince]);

  // Démontage pendant un enregistrement : on coupe le micro.
  useEffect(() => () => recorder.current?.stop(), []);

  const start = async () => {
    pressed.current = true;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return onError("L'enregistrement audio n'est pas pris en charge par ce navigateur");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return onError("Accès au micro refusé");
    }
    // Relâché pendant la demande d'autorisation : on n'enregistre pas.
    if (!pressed.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); // éteint le voyant du micro
      recorder.current = null;
      setRecordingSince(null);
      setElapsed(0);
      const duration = Date.now() - startedAt;
      if (!shouldSend.current) return;
      if (duration < MIN_DURATION_MS) return onError("Maintenez le bouton pour enregistrer un message vocal");
      const type = rec.mimeType || mimeType || "audio/webm";
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      onRecorded(new File(chunks, `message-vocal.${extension}`, { type }));
    };
    rec.start();
    recorder.current = rec;
    setRecordingSince(startedAt);
  };

  const stop = (send: boolean) => {
    // Sur écran tactile, « pointerleave » arrive juste APRÈS « pointerup » quand le doigt se lève :
    // seul le premier arrêt compte, sinon il annulerait l'envoi.
    if (!pressed.current) return;
    pressed.current = false;
    shouldSend.current = send;
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  const recording = recordingSince !== null;

  return (
    <>
      {recording && (
        <span className="recorder__status" aria-live="polite">
          <span className="recorder__dot" aria-hidden="true" /> {formatDuration(elapsed)} · relâchez pour envoyer, glissez
          hors du bouton pour annuler
        </span>
      )}
      <button
        type="button"
        className={`chat__send chat__mic${recording ? " chat__mic--recording" : ""}`}
        aria-label="Maintenir pour enregistrer un message vocal"
        title="Maintenir pour enregistrer"
        onPointerDown={(e) => {
          e.preventDefault();
          start();
        }}
        onPointerUp={() => stop(true)}
        onPointerLeave={() => stop(false)}
        onPointerCancel={() => stop(false)}
        onContextMenu={(e) => e.preventDefault()} // appui long sur mobile
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
          />
        </svg>
      </button>
    </>
  );
}
