import { initials } from "../format";
import { useMediaUrl } from "../media";

// Avatar rond : la photo si elle existe (lue via une URL présignée), sinon les initiales.
export function Avatar({ name, mediaId, size = 44 }: { name: string; mediaId?: string | null; size?: number }) {
  const url = useMediaUrl(mediaId);
  if (url) {
    return <img className="avatar avatar--photo" src={url} alt="" style={{ width: size, height: size }} />;
  }
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials(name) || "?"}
    </div>
  );
}
