import type { MediaInfo } from "../api";
import { formatSize } from "../format";
import { openMedia, useMediaUrl } from "../media";

interface Props {
  type: string; // IMAGE | VIDEO | AUDIO | DOCUMENT
  media: MediaInfo;
  localUrl?: string; // aperçu local pendant l'envoi (URL.createObjectURL)
  progress?: number; // 0 → 1 pendant l'envoi vers MinIO
  uploading?: boolean;
}

// Contenu d'une bulle de média : aperçu d'image, lecteur vidéo / audio, ou lien de document.
export function MediaContent({ type, media, localUrl, progress, uploading }: Props) {
  // Pendant l'envoi, le média n'existe pas encore côté serveur : on n'interroge pas l'API.
  const remoteUrl = useMediaUrl(uploading ? null : media.id);
  const url = localUrl ?? remoteUrl;

  const bar = uploading && (
    <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
      <div className="upload-progress__bar" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
    </div>
  );

  if (type === "IMAGE") {
    return (
      <div className="media media--image">
        {url ? (
          <button type="button" className="media__open" onClick={() => !uploading && openMedia(media.id)} aria-label="Ouvrir l'image">
            <img src={url} alt="" loading="lazy" />
          </button>
        ) : (
          <div className="media__placeholder">📷</div>
        )}
        {bar}
      </div>
    );
  }

  if (type === "VIDEO") {
    return (
      <div className="media media--video">
        {url ? <video src={url} controls preload="metadata" /> : <div className="media__placeholder">🎥</div>}
        {bar}
      </div>
    );
  }

  if (type === "AUDIO") {
    return (
      <div className="media media--audio">
        {url ? <audio src={url} controls preload="metadata" /> : <div className="media__placeholder">🎤</div>}
        {bar}
      </div>
    );
  }

  // Document : la réponse de MinIO contient « Content-Disposition: attachment » → téléchargement.
  return (
    <div className="media media--document">
      <button type="button" className="doc" onClick={() => !uploading && openMedia(media.id)} disabled={uploading}>
        <span className="doc__icon" aria-hidden="true">
          📄
        </span>
        <span className="doc__body">
          <span className="doc__name">{media.fileName ?? "Document"}</span>
          <span className="doc__size">{formatSize(media.size)}</span>
        </span>
      </button>
      {bar}
    </div>
  );
}
