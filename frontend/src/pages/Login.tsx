import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, login } from "../api";
import { AuthForm, Field } from "../components/AuthForm";

export default function Login() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const submit = async () => {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await login(phone, password);
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.details ?? {});
      } else {
        setError("Impossible de joindre le serveur");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthForm
      title="Connexion"
      submitLabel="Se connecter"
      loading={loading}
      error={error}
      onSubmit={submit}
      footer={
        <>
          Pas encore de compte ? <Link to="/register">S'inscrire</Link>
        </>
      }
    >
      <Field
        label="Téléphone"
        type="tel"
        value={phone}
        onChange={setPhone}
        autoComplete="tel"
        placeholder="+33612345678"
        errors={fieldErrors.phone}
      />
      <Field
        label="Mot de passe"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        errors={fieldErrors.password}
      />
    </AuthForm>
  );
}
