import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getMe, logout, type User } from "../api";
import { styles } from "../styles";

// Page d'accueil protégée : affiche mon profil (GET /api/users/me).
export default function Home() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => navigate("/login", { replace: true })); // pas (ou plus) connecté
  }, [navigate]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  if (!user) return <main style={styles.page}>Chargement…</main>;

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <h1 style={styles.title}>Bonjour {user.name} 👋</h1>
        <p style={{ margin: 0 }}>
          <strong>Téléphone :</strong> {user.phone}
        </p>
        <p style={{ margin: 0 }}>
          <strong>À propos :</strong> {user.about}
        </p>
        <button type="button" style={styles.button} onClick={handleLogout}>
          Se déconnecter
        </button>
      </section>
    </main>
  );
}
