import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, register } from "../api";
import { AuthForm, Field } from "../components/AuthForm";

export default function Register() {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const submit = async () => {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await register(phone, name, password);
      navigate("/"); // inscrit et connecté
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
      title="Inscription"
      submitLabel="Créer mon compte"
      loading={loading}
      error={error}
      onSubmit={submit}
      footer={
        <>
          Déjà un compte ? <Link to="/login">Se connecter</Link>
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
      <Field label="Nom" value={name} onChange={setName} autoComplete="name" errors={fieldErrors.name} />
      <Field
        label="Mot de passe (8 caractères minimum)"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        errors={fieldErrors.password}
      />
    </AuthForm>
  );
}
