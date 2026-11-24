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
Invoke-RestMethod http://localhost:4000/health
```

Console MinIO : http://localhost:9001 (identifiants `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` du `.env`).

## Base de données (Prisma)

Le schéma est dans `backend/prisma/schema.prisma`. Après l'avoir modifié :

```powershell
cd backend
npm run db:migrate -- --name description_du_changement
npm run db:studio     # explorer les données dans le navigateur
```

## Notes

- **Port 5433** : le conteneur PostgreSQL est exposé sur 5433 pour ne pas entrer en conflit avec un PostgreSQL déjà installé sous Windows (port 5432). Modifiable via `POSTGRES_PORT` dans `.env`.
- **MinIO** : l'image `minio/minio` a été retirée de Docker Hub. On utilise l'image Chainguard, qui tourne en utilisateur non-root (UID 65532). Gardez un **volume nommé** (`miniodata`) : un dossier Windows monté en bind provoquerait des erreurs de permissions.

## Arrêter

```powershell
docker compose down      # arrête les conteneurs, garde les données
docker compose down -v   # arrête ET supprime les volumes (données perdues)
```
