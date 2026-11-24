import type { FormEvent, ReactNode } from "react";
import { styles } from "../styles";

interface Props {
  title: string;
  submitLabel: string;
  loading: boolean;
  error: string | null;
  onSubmit: () => void;
  footer: ReactNode;
  children: ReactNode;
}

// Cadre commun aux pages Connexion et Inscription.
export function AuthForm({ title, submitLabel, loading, error, onSubmit, footer, children }: Props) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault(); // empêche le rechargement de la page
    onSubmit();
  };

  return (
    <main style={styles.page}>
      <form style={styles.card} onSubmit={handleSubmit} noValidate>
        <img src="/logo-lisolo.svg" alt="Lisolo" style={styles.logo} width={200} height={56} />
        <h1 style={styles.title}>{title}</h1>
        {error && (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )}
        {children}
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "Patientez…" : submitLabel}
        </button>
        <p className="auth-footer" style={styles.footer}>
          {footer}
        </p>
      </form>
    </main>
  );
}

interface FieldProps {
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  errors?: string[];
}

export function Field({ label, type = "text", value, onChange, autoComplete, placeholder, errors }: FieldProps) {
  return (
    <label style={styles.label}>
      {label}
      <input
        style={styles.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={errors ? true : undefined}
      />
      {errors?.map((msg) => (
        <span key={msg} style={styles.fieldError}>
          {msg}
        </span>
      ))}
    </label>
  );
}
