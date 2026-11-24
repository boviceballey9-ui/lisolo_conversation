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

### Temps réel (Socket.io, même port que l'API)

Connexion avec `auth: { token: <accessToken> }`.

| Sens | Événement | Données |
|---|---|---|
| client → serveur | `message:send` | `{ conversationId, content, clientId? }` → ack `{ ok, message, clientId }` |
| client → serveur | `message:delivered` | `{ messageIds }` (✓✓) |
| client → serveur | `message:read` | `{ conversationId }` (✓✓ bleu) |
| serveur → client | `message:new` | le message |
| serveur → client | `message:status` | `{ conversationId, messageIds, userId, status }` |
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

## Notes

- **PowerShell 5.1 et les accents** : `Get-Content`/`Set-Content` lisent les fichiers UTF-8 sans BOM comme de l'ANSI et abîment les accents. Modifiez le `.env` avec VS Code plutôt qu'avec ces commandes.

- **Port 5433** : le conteneur PostgreSQL est exposé sur 5433 pour ne pas entrer en conflit avec un PostgreSQL déjà installé sous Windows (port 5432). Modifiable via `POSTGRES_PORT` dans `.env`.
- **MinIO** : l'image `minio/minio` a été retirée de Docker Hub. On utilise l'image Chainguard, qui tourne en utilisateur non-root (UID 65532). Gardez un **volume nommé** (`miniodata`) : un dossier Windows monté en bind provoquerait des erreurs de permissions.

## Arrêter

```powershell
docker compose down      # arrête les conteneurs, garde les données
docker compose down -v   # arrête ET supprime les volumes (données perdues)
```
