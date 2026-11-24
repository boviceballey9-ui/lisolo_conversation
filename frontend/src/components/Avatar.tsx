import { initials } from "../format";

// Avatar rond avec les initiales (les photos viendront avec MinIO).
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials(name) || "?"}
    </div>
  );
}
