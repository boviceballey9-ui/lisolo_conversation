# Référence de l'API

[← Retour au README](../README.md)

Toutes les routes sont préfixées par `/api`. Les routes protégées attendent l'en-tête `Authorization: Bearer <accessToken>`.

## Routes HTTP

### Authentification et profil

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/auth/register` | Inscription `{ phone, name, password }` → `{ user, accessToken, refreshToken }` |
| POST | `/api/auth/login` | Connexion `{ phone, password }` → `{ user, accessToken, refreshToken }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` → `{ accessToken }` |
| GET | `/api/users/me` | Mon profil |
| PATCH | `/api/users/me/avatar` | `{ mediaId \| null }` → ma photo de profil |

### Conversations et messages

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/conversations` | Mes conversations, avec le dernier message et le nombre de non-lus |
| POST | `/api/conversations` | `{ phone }` → démarre (ou retrouve) une discussion privée |
| GET | `/api/conversations/:id/messages?limit=30&before=<id>` | Historique paginé par curseur → `{ messages, nextCursor }` |
| GET | `/api/conversations/:id/messages/:messageId/info` | « Infos du message » : qui l'a reçu / lu, et quand (expéditeur seulement) |

### Groupes

| Méthode | Route | Qui | Rôle |
|---|---|---|---|
| POST | `/api/groups` | tout utilisateur | `{ name, phones }` → crée un groupe (le créateur est admin) |
| PATCH | `/api/groups/:id` | admin | `{ name }` → renomme |
| PATCH | `/api/groups/:id/photo` | admin | `{ mediaId \| null }` → photo du groupe |
| POST | `/api/groups/:id/members` | admin | `{ phones }` → ajoute des membres |
| DELETE | `/api/groups/:id/members/:userId` | admin | retire un membre |
| POST | `/api/groups/:id/admins` | admin | `{ userId }` → nomme un admin |
| POST | `/api/groups/:id/leave` | membre | quitte le groupe (le membre le plus ancien devient admin si besoin) |

Un membre non admin reçoit **403** ; un non-membre reçoit **404** (l'existence du groupe n'est pas révélée).

### Médias

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/media/upload-url` | `{ mimeType, size, fileName? }` → URL présignée **PUT** vers MinIO (5 min) |
| POST | `/api/media` | `{ objectKey, fileName? }` → vérifie l'objet envoyé et l'enregistre → `{ media }` |
| GET | `/api/media/:id/url` | URL présignée **GET** (5 min), si vous avez le droit de lire ce média |

Le fichier va **directement du navigateur à MinIO**, jamais à travers le backend :

```
navigateur ──1. upload-url──▶ backend (vérifie type et taille, signe)
navigateur ──2. PUT fichier─▶ MinIO   (vérifie la signature)
navigateur ──3. POST media──▶ backend (vérifie l'objet réel, crée la ligne media)
navigateur ──4. message:send { mediaId } ──▶ Socket.io
```

Limites : images et messages vocaux 16 Mo, vidéos 64 Mo, documents 100 Mo.

### Notifications push

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/push/vapid-public-key` | Clé publique VAPID, à donner au service push du navigateur lors de l'abonnement |
| POST | `/api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth } }` (= `PushSubscription.toJSON()`) → enregistre l'abonnement de ce navigateur |
| DELETE | `/api/push/subscriptions` | `{ endpoint }` → désabonnement (bouton, ou déconnexion) |

Une notification n'est envoyée qu'aux destinataires **sans aucun onglet ouvert**. Elle est chiffrée pour le navigateur (RFC 8291) et signée avec la clé VAPID (RFC 8292). Contenu : `{ title, body, tag, url, conversationId }`.

### Appels

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/calls/ice-config` | Serveurs STUN/TURN, avec des identifiants TURN temporaires (12 h) |

### Santé

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health` | État du serveur et de PostgreSQL |

## Événements temps réel (Socket.io)

Connexion avec `auth: { token: <accessToken> }` (sinon `connect_error: UNAUTHORIZED`). Les événements client → serveur répondent par un accusé (ack) `{ ok, error? , ... }`.

### Messages

| Sens | Événement | Données |
|---|---|---|
| client → serveur | `message:send` | `{ conversationId, content?, mediaId?, clientId? }` → ack `{ ok, message, clientId }` |
| client → serveur | `message:delivered` | `{ messageIds }` (✓✓) |
| client → serveur | `message:read` | `{ conversationId }` (✓✓ bleu) |
| serveur → client | `message:new` | le message |
| serveur → client | `message:status` | `{ conversationId, messageIds, userId, status, aggregates }`. `aggregates` donne le statut global : bleu quand **tous** les destinataires ont lu |

### Présence et saisie

| Sens | Événement | Données |
|---|---|---|
| client → serveur | `typing:start` / `typing:stop` | `{ conversationId }` (arrêt automatique après 3 s sans `typing:start`) |
| client → serveur | `presence:get` | `{ userIds }` → ack `{ ok, presence: [{ userId, online, lastSeenAt }] }` |
| serveur → client | `typing:update` | `{ conversationId, userId, isTyping }` |
| serveur → client | `presence:update` | `{ userId, online, lastSeenAt }` (envoyé à vos contacts seulement) |

### Groupes

| Sens | Événement | Données |
|---|---|---|
| serveur → client | `group:updated` | `{ conversationId, name, photoId, members }` |
| serveur → client | `group:removed` | `{ conversationId }` (vous avez quitté le groupe ou en avez été retiré) |

### Appels

| Sens | Événement | Données |
|---|---|---|
| client → serveur | `call:invite` | `{ conversationId, type: "AUDIO" \| "VIDEO" }` → ack `{ ok, call, reason? }` (`OFFLINE`, `BUSY`) |
| client → serveur | `call:accept` / `call:reject` / `call:end` | `{ callId }` |
| serveur → client | `call:invite` | `{ call, caller }` : ça sonne (sur tous vos onglets) |
| serveur → client | `call:accept` / `call:reject` / `call:end` / `call:busy` | `{ call }` |

Sans réponse au bout de 30 s, l'appel est enregistré comme manqué. Chaque appel laisse une trace (message `CALL`) dans la conversation. Une fois l'appel décroché, la connexion audio/vidéo passe par WebRTC : PeerJS, avec le PeerServer sur `/peerjs`, et STUN/TURN fournis par coturn.
