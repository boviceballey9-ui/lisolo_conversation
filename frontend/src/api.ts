// Petit client HTTP pour l'API : gère les tokens et le renouvellement automatique.

export interface User {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatarId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

// Erreur renvoyée par l'API, avec le détail par champ en cas d'erreur de validation (400).
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

// --- Stockage des tokens ---
// localStorage : simple pour apprendre, mais lisible par tout script de la page (risque XSS).
// En production, on préférerait garder le refresh token dans un cookie httpOnly.
const ACCESS_KEY = "accessToken";
const REFRESH_KEY = "refreshToken";

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  save(access: string, refresh?: string) {
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({}));
  return new ApiError(res.status, body.error ?? `Erreur HTTP ${res.status}`, body.details);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

// Demande un nouvel access token avec le refresh token. Renvoie false si impossible.
async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = tokens.refresh;
  if (!refreshToken) return false;
  try {
    const { accessToken } = await post<{ accessToken: string }>("/api/auth/refresh", { refreshToken });
    tokens.save(accessToken);
    return true;
  } catch {
    tokens.clear(); // refresh token expiré ou invalide : il faut se reconnecter
    return false;
  }
}

// Requête authentifiée : ajoute l'access token ; s'il a expiré (401),
// le renouvelle UNE fois puis rejoue la requête.
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = () =>
    fetch(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${tokens.access ?? ""}` },
    });

  let res = await send();
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<T>;
}

export async function register(phone: string, name: string, password: string) {
  const data = await post<AuthResponse>("/api/auth/register", { phone, name, password });
  tokens.save(data.accessToken, data.refreshToken);
  return data.user;
}

export async function login(phone: string, password: string) {
  const data = await post<AuthResponse>("/api/auth/login", { phone, password });
  tokens.save(data.accessToken, data.refreshToken);
  return data.user;
}

export function logout() {
  tokens.clear();
}

export async function getMe() {
  const { user } = await apiFetch<{ user: User }>("/api/users/me");
  return user;
}
