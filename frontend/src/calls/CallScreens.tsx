import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { formatDuration } from "../format";
import type { CallState } from "./useCall";

// Affiche un MediaStream dans une balise <video> (srcObject ne passe pas par un attribut JSX).
function StreamVideo({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

const kindLabel = (type: string) => (type === "VIDEO" ? "Appel vidéo" : "Appel vocal");

// ---------- Appel entrant ----------

export function IncomingCall({ call, onAccept, onReject }: { call: CallState; onAccept: () => void; onReject: () => void }) {
  return (
    <div className="call-incoming" role="alertdialog" aria-label={`${kindLabel(call.type)} entrant de ${call.other.name}`}>
      <Avatar name={call.other.name} mediaId={call.other.avatarId} size={64} />
      <div className="call-incoming__text">
        <strong>{call.other.name}</strong>
        <span>{kindLabel(call.type)} entrant…</span>
      </div>
      <div className="call-incoming__actions">
        <button type="button" className="call-btn call-btn--hangup" onClick={onReject} aria-label="Refuser">
          ✕
        </button>
        <button type="button" className="call-btn call-btn--accept" onClick={onAccept} aria-label="Accepter">
          {call.type === "VIDEO" ? "🎥" : "📞"}
        </button>
      </div>
    </div>
  );
}

// ---------- Appel en cours (ou en préparation / terminé) ----------

interface ScreenProps {
  call: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onHangUp: () => void;
  onToggleMic: () => void;
  onToggleCamera: () => void;
}

export function CallScreen({ call, localStream, remoteStream, onHangUp, onToggleMic, onToggleCamera }: ScreenProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.phase !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.phase]);

  const status =
    call.phase === "ended"
      ? call.notice
      : call.phase === "active"
        ? formatDuration(now - (call.answeredAt ?? now))
        : call.phase === "connecting"
          ? "Connexion…"
          : "Appel…";

  const hasRemoteVideo = call.type === "VIDEO" && !!remoteStream?.getVideoTracks().length;
  const hasLocalVideo = !!localStream?.getVideoTracks().length;

  return (
    <div className="call-screen" role="dialog" aria-label={`${kindLabel(call.type)} avec ${call.other.name}`}>
      {/* Vidéo de l'autre en plein écran. Pour un appel audio, la balise joue simplement le son. */}
      <StreamVideo stream={remoteStream} className={hasRemoteVideo ? "call-screen__remote" : "call-screen__audio-only"} />

      {!hasRemoteVideo && (
        <div className="call-screen__identity">
          <Avatar name={call.other.name} mediaId={call.other.avatarId} size={120} />
        </div>
      )}

      <div className="call-screen__header">
        <strong>{call.other.name}</strong>
        <span aria-live="polite">{status}</span>
        {call.notice && call.phase !== "ended" && <span className="call-screen__warning">{call.notice}</span>}
      </div>

      {/* Ma vidéo en vignette (muette : on ne veut pas s'entendre soi-même). */}
      {hasLocalVideo && (
        <StreamVideo stream={localStream} muted className={`call-screen__local${call.camOn ? "" : " call-screen__local--off"}`} />
      )}

      {call.phase !== "ended" && (
        <div className="call-screen__controls">
          <button
            type="button"
            className={`call-btn${call.micOn ? "" : " call-btn--off"}`}
            onClick={onToggleMic}
            aria-pressed={!call.micOn}
            aria-label={call.micOn ? "Couper le micro" : "Réactiver le micro"}
          >
            {call.micOn ? "🎙️" : "🔇"}
          </button>
          {hasLocalVideo && (
            <button
              type="button"
              className={`call-btn${call.camOn ? "" : " call-btn--off"}`}
              onClick={onToggleCamera}
              aria-pressed={!call.camOn}
              aria-label={call.camOn ? "Couper la caméra" : "Réactiver la caméra"}
            >
              {call.camOn ? "📹" : "🚫"}
            </button>
          )}
          <button type="button" className="call-btn call-btn--hangup" onClick={onHangUp} aria-label="Raccrocher">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
