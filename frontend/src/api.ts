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
// Exporté : le socket s'en sert aussi quand sa connexion est refusée (token expiré).
export async function refreshAccessToken(): Promise<boolean> {
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

// ---------- Chat ----------

export type DeliveryStatus = "SENT" | "DELIVERED" | "READ";

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  // SYSTEM : événement de groupe (« Alice a ajouté Bob »), affiché au centre, sans coches.
  type: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT" | "SYSTEM" | "CALL";
  content: string | null;
  media: MediaInfo | null; // pièce jointe (le fichier se lit via getMediaUrl)
  call?: CallInfo | null; // message de type CALL : trace d'un appel
  createdAt: string;
  status: DeliveryStatus;
}

export interface MediaInfo {
  id: string;
  mimeType: string;
  size: number;
  fileName: string | null;
}

export type CallType = "AUDIO" | "VIDEO";
export type CallStatus = "RINGING" | "ONGOING" | "COMPLETED" | "MISSED" | "REJECTED" | "BUSY";

export interface CallInfo {
  id: string;
  type: CallType;
  status: CallStatus;
  callerId: string;
  calleeId?: string;
  conversationId?: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
}

export type GroupRole = "ADMIN" | "MEMBER";

export interface Member {
  user: User;
  role: GroupRole;
  joinedAt: string;
}

export interface Conversation {
  id: string;
  type: "PRIVATE" | "GROUP";
  name: string | null;
  photoId: string | null; // photo du groupe
  updatedAt: string;
  otherUser: User | null; // conversation privée : l'autre personne
  members: Member[] | null; // groupe : tous les membres, moi compris
  lastMessage: Message | null;
  unreadCount: number;
}

export async function listConversations() {
  const { conversations } = await apiFetch<{ conversations: Conversation[] }>("/api/conversations");
  return conversations;
}

export async function startConversation(phone: string) {
  const { conversation } = await apiFetch<{ conversation: Conversation }>("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  return conversation;
}

export interface MessageInfo {
  message: Message;
  recipients: { user: User; status: DeliveryStatus; deliveredAt: string | null; readAt: string | null }[];
}

export function getMessageInfo(conversationId: string, messageId: string) {
  return apiFetch<MessageInfo>(`/api/conversations/${conversationId}/messages/${messageId}/info`);
}

// ---------- Groupes ----------
// Les boutons d'administration ne s'affichent que pour les admins, mais c'est le SERVEUR
// qui vérifie les droits (403 sinon) : l'interface n'est qu'un confort.

export interface GroupState {
  name: string | null;
  photoId?: string | null;
  members: Member[];
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export async function createGroup(name: string, phones: string[]) {
  const { conversation } = await apiFetch<{ conversation: Conversation }>("/api/groups", jsonInit("POST", { name, phones }));
  return conversation;
}

export const renameGroup = (groupId: string, name: string) =>
  apiFetch<GroupState>(`/api/groups/${groupId}`, jsonInit("PATCH", { name }));

export const addGroupMembers = (groupId: string, phones: string[]) =>
  apiFetch<GroupState>(`/api/groups/${groupId}/members`, jsonInit("POST", { phones }));

export const removeGroupMember = (groupId: string, userId: string) =>
  apiFetch<GroupState>(`/api/groups/${groupId}/members/${userId}`, jsonInit("DELETE"));

export const promoteGroupAdmin = (groupId: string, userId: string) =>
  apiFetch<GroupState>(`/api/groups/${groupId}/admins`, jsonInit("POST", { userId }));

export const setGroupPhoto = (groupId: string, mediaId: string | null) =>
  apiFetch<GroupState>(`/api/groups/${groupId}/photo`, jsonInit("PATCH", { mediaId }));

// ---------- Médias (le fichier lui-même va directement à MinIO, voir media.ts) ----------

export interface UploadTicket {
  uploadUrl: string; // URL présignée PUT vers MinIO (5 min)
  objectKey: string;
  expiresIn: number;
  headers: Record<string, string>; // à envoyer tels quels : ils font partie de la signature
}

export const requestUploadUrl = (mimeType: string, size: number, fileName?: string) =>
  apiFetch<UploadTicket>("/api/media/upload-url", jsonInit("POST", { mimeType, size, fileName }));

export async function registerMedia(objectKey: string, fileName?: string) {
  const { media } = await apiFetch<{ media: MediaInfo }>("/api/media", jsonInit("POST", { objectKey, fileName }));
  return media;
}

export const getMediaUrl = (mediaId: string) => apiFetch<{ url: string; expiresAt: string }>(`/api/media/${mediaId}/url`);

export async function setMyAvatar(mediaId: string | null) {
  const { user } = await apiFetch<{ user: User }>("/api/users/me/avatar", jsonInit("PATCH", { mediaId }));
  return user;
}

// ---------- Appels ----------

// Serveurs STUN/TURN (identifiants TURN temporaires fournis par le backend).
export const getIceConfig = () => apiFetch<{ iceServers: RTCIceServer[]; ttl: number | null }>("/api/calls/ice-config");

export const leaveGroup = (groupId: string) => apiFetch<{ left: true }>(`/api/groups/${groupId}/leave`, jsonInit("POST"));

export async function listMessages(conversationId: string, before?: string) {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return apiFetch<{ messages: Message[]; nextCursor: string | null }>(
    `/api/conversations/${conversationId}/messages${query}`,
  );
}
