# WhatsApp Clone (projet d'apprentissage)

Clone de WhatsApp pour apprendre : messagerie, médias et appels audio/vidéo.

## Architecture

| Dossier / service | Rôle |
|---|---|
| `backend/` | API Node.js + Express + TypeScript (port 4000) |
| `frontend/` | Interface React + Vite + TypeScript (port 5173) |
| `postgres` | Base de données : utilisateurs, conversations, messages (port **5433** sur Windows) |
| `minio` | Stockage objet compatible S3 pour les médias, image `cgr.dev/chainguard/minio` (API 9000, console 9001) |
| `coturn` | Serveur STUN/TURN pour les appels WebRTC (port 3478) |

## Prérequis

- [Node.js](https://nodejs.org/) 20 ou plus
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (démarré)

## Lancer le projet (PowerShell)

```powershell
# 1. Créer votre fichier de configuration local, puis modifier les mots de passe
Copy-Item .env.example .env

# 2. Démarrer PostgreSQL, MinIO et coturn
docker compose up -d
docker compose ps

# 3. Backend (dans un premier terminal)
cd backend
npm install           # génère aussi le client Prisma
npx prisma migrate deploy   # crée les tables dans PostgreSQL
npm run dev
# -> http://localhost:4000/health

# 4. Frontend (dans un second terminal)
cd frontend
npm install
npm run dev
# -> http://localhost:5173
```

Tester la route de santé :

```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

## API

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/auth/register` | Inscription `{ phone, name, password }` → `{ user, accessToken, refreshToken }` |
| POST | `/api/auth/login` | Connexion `{ phone, password }` → `{ user, accessToken, refreshToken }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` → `{ accessToken }` |
| GET | `/api/users/me` | Mon profil (en-tête `Authorization: Bearer <accessToken>`) |
| GET | `/api/conversations` | Mes conversations, avec le dernier message et le nombre de non-lus |
| POST | `/api/conversations` | `{ phone }` → démarre (ou retrouve) une discussion avec ce numéro |
| GET | `/api/conversations/:id/messages?limit=30&before=<id>` | Historique paginé → `{ messages, nextCursor }` |
| GET | `/api/conversations/:id/messages/:messageId/info` | Infos d'un de mes messages : qui l'a reçu / lu, et quand |
| POST | `/api/groups` | `{ name, phones }` → crée un groupe (j'en suis admin) |
| PATCH | `/api/groups/:id` | `{ name }` → renomme (admin) |
| POST | `/api/groups/:id/members` | `{ phones }` → ajoute des membres (admin) |
| DELETE | `/api/groups/:id/members/:userId` | Retire un membre (admin) |
| POST | `/api/groups/:id/admins` | `{ userId }` → nomme un admin (admin) |
| POST | `/api/groups/:id/leave` | Quitter le groupe |

| PATCH | `/api/groups/:id/photo` | `{ mediaId \| null }` → photo du groupe (admin) |
| PATCH | `/api/users/me/avatar` | `{ mediaId \| null }` → ma photo de profil |
| POST | `/api/media/upload-url` | `{ mimeType, size, fileName? }` → URL présignée PUT vers MinIO (5 min) |
| POST | `/api/media` | `{ objectKey, fileName? }` → enregistre le fichier envoyé → `{ media }` |
| GET | `/api/media/:id/url` | URL présignée GET (5 min), si vous avez le droit de lire ce média |
| GET | `/api/calls/ice-config` | Serveurs STUN/TURN pour les appels (identifiants TURN temporaires) |

Un membre non admin reçoit **403** sur les actions d'admin ; un non-membre reçoit **404**.

### Envoi d'un fichier

Le fichier va **directement du navigateur à MinIO**, jamais à travers le backend :

```
navigateur ──1. upload-url──▶ backend (vérifie type/taille, signe)
navigateur ──2. PUT fichier─▶ MinIO   (vérifie la signature)
navigateur ──3. POST media──▶ backend (vérifie l'objet, crée la ligne media)
navigateur ──4. message:send { mediaId } ──▶ Socket.io
```

Limites : images et messages vocaux 16 Mo, vidéos 64 Mo, documents 100 Mo.

### Temps réel (Socket.io, même port que l'API)

Connexion avec `auth: { token: <accessToken> }`.

| Sens | Événement | Données |
|---|---|---|
| client → serveur | `message:send` | `{ conversationId, content?, mediaId?, clientId? }` (texte et/ou média) → ack `{ ok, message, clientId }` |
| client → serveur | `message:delivered` | `{ messageIds }` (✓✓) |
| client → serveur | `message:read` | `{ conversationId }` (✓✓ bleu) |
| serveur → client | `message:new` | le message |
| serveur → client | `message:status` | `{ conversationId, messageIds, userId, status, aggregates }` (`aggregates` : statut global, bleu quand tous ont lu) |
| serveur → client | `group:updated` | `{ conversationId, name, members }` |
| serveur → client | `group:removed` | `{ conversationId }` (vous avez quitté le groupe ou en avez été retiré) |
| client → serveur | `call:invite` | `{ conversationId, type: "AUDIO" \| "VIDEO" }` → ack `{ ok, call, reason? }` (`OFFLINE`, `BUSY`) |
| client → serveur | `call:accept` / `call:reject` / `call:end` | `{ callId }` |
| serveur → client | `call:invite` | `{ call, caller }` : ça sonne (tous vos onglets) |
| serveur → client | `call:accept` / `call:reject` / `call:end` / `call:busy` | `{ call }` |

### Appels audio / vidéo

La sonnerie passe par Socket.io ; la connexion audio/vidéo elle-même passe par **WebRTC** (bibliothèque PeerJS, PeerServer sur `/peerjs`), avec STUN/TURN fournis par coturn. Pour essayer : deux comptes dans deux navigateurs, ouvrez la discussion, puis 📞 ou 🎥 dans l'en-tête (autorisez micro et caméra). Délai de sonnerie : 30 s, puis « appel manqué ». Chaque appel laisse une trace dans la conversation.
| client → serveur | `typing:start` / `typing:stop` | `{ conversationId }` (arrêt automatique après 3 s sans `typing:start`) |
| client → serveur | `presence:get` | `{ userIds }` → ack `{ ok, presence: [{ userId, online, lastSeenAt }] }` |
| serveur → client | `typing:update` | `{ conversationId, userId, isTyping }` |
| serveur → client | `presence:update` | `{ userId, online, lastSeenAt }` (envoyé à vos contacts) |

Console MinIO : http://localhost:9001 (identifiants `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` du `.env`).

## Base de données (Prisma)

Le schéma est dans `backend/prisma/schema.prisma`. Après l'avoir modifié :

```powershell
cd backend
npm run db:migrate -- --name description_du_changement
npm run db:studio     # explorer les données dans le navigateur
```

## Tests

```powershell
cd backend
npm test
```

Les tests utilisent une base séparée (`TEST_DATABASE_URL`, créée et migrée automatiquement) : vos données de développement ne sont jamais touchées.

## Pages

- http://localhost:5173/register : inscription
- http://localhost:5173/login : connexion
- http://localhost:5173/ : discussions (protégé)

Pour essayer le chat : créez deux comptes (une fenêtre normale + une fenêtre de navigation privée), puis « Nouvelle discussion » avec le numéro de l'autre compte.

Pour essayer les groupes : un troisième compte (autre navigateur ou autre profil), puis « Nouveau groupe ». Cliquez sur l'en-tête du groupe pour ouvrir « Infos du groupe », et sur « Infos » dans une de vos bulles pour voir qui a lu.

## HTTPS avec Nginx (build de production, accès depuis un téléphone)

Nginx devient le **seul point d'entrée** : `https://localhost`, ou `https://<IP-du-PC>` depuis le Wi-Fi.

```powershell
# 1. Certificat local (mkcert) pour localhost, 127.0.0.1 et l'IP Wi-Fi du PC
#    (une fois : winget install FiloSottile.mkcert ; mkcert -install)
powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1        # ou : -Ip 192.168.1.42

# 2. Dans .env : mettre cette IP dans TURN_EXTERNAL_IP, TURN_HOST et CORS_ORIGINS

# 3. Backend sur Windows (Nginx le joint via host.docker.internal:4000)
cd backend; npm run build; npm start          # ou npm run dev

# 4. Infrastructure + Nginx (construit aussi le frontend de production)
cd ..; docker compose up -d --build
# -> https://localhost   (http://localhost redirige vers https)
```

| Chemin | Destination |
|---|---|
| `/` | frontend (fichiers statiques du build Vite) |
| `/api/` | backend |
| `/socket.io/`, `/peerjs/` | backend, en WebSocket |
| `/media/` | MinIO (URL présignées, fichiers jusqu'à 100 Mo) |

Les certificats (`nginx/certs/`) ne sont **jamais** commités.

### Tester sur un téléphone Android

1. Le téléphone doit être sur **le même Wi-Fi** que le PC.
2. Copiez sur le téléphone le certificat **racine** : `rootCA.pem`, dans le dossier affiché par `mkcert -CAROOT`. Par câble USB, Google Drive ou e-mail ; renommez-le en `rootCA.crt` si Android ne le reconnaît pas. **Ne copiez jamais `rootCA-key.pem`** : avec ce fichier, n'importe qui pourrait fabriquer un certificat que votre téléphone accepterait pour *n'importe quel* site.
3. Sur le téléphone : *Paramètres → Sécurité et confidentialité → Plus de paramètres de sécurité → Chiffrement et identifiants → Installer un certificat → Certificat CA*. Confirmez l'avertissement, puis choisissez le fichier. Le chemin varie selon la marque : cherchez « certificat CA » dans les paramètres.
4. Ouvrez `https://<IP-du-PC>` dans **Chrome** : cadenas, pas d'alerte. Firefox pour Android n'utilise pas les certificats installés par l'utilisateur, sauf si on l'active dans ses paramètres secrets.
5. Si la page ne charge pas, c'est le pare-feu Windows. Le réseau Wi-Fi doit être en profil **Privé**, et Docker Desktop doit être autorisé à recevoir des connexions (port 443, et UDP 3478 et 49160-49200 pour les appels).
6. Après l'essai, vous pouvez supprimer le certificat (*Chiffrement et identifiants → Identifiants de confiance → Utilisateur*).

Le micro, la caméra et l'enregistrement vocal ne fonctionnent qu'en HTTPS (ou sur `localhost`) : c'est ce qui rend Nginx + HTTPS nécessaire pour tester les appels sur téléphone.

## Notes

- **PowerShell 5.1 et les accents** : `Get-Content`/`Set-Content` lisent les fichiers UTF-8 sans BOM comme de l'ANSI et abîment les accents. Modifiez le `.env` avec VS Code plutôt qu'avec ces commandes.

- **Port 5433** : le conteneur PostgreSQL est exposé sur 5433 pour ne pas entrer en conflit avec un PostgreSQL déjà installé sous Windows (port 5432). Modifiable via `POSTGRES_PORT` dans `.env`.
- **MinIO** : l'image `minio/minio` a été retirée de Docker Hub. On utilise l'image Chainguard, qui tourne en utilisateur non-root (UID 65532). Gardez un **volume nommé** (`miniodata`) : un dossier Windows monté en bind provoquerait des erreurs de permissions.

## Arrêter

```powershell
docker compose down      # arrête les conteneurs, garde les données
docker compose down -v   # arrête ET supprime les volumes (données perdues)
```
