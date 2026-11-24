# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

Clone de WhatsApp à but pédagogique (messagerie, médias, appels WebRTC). L'utilisateur apprend : expliquer les choix en français. Environnement : **Windows + PowerShell + Docker Desktop** — donner les commandes en syntaxe PowerShell (`;` et non `&&`, `Copy-Item`, `Invoke-RestMethod`).

## Commandes

```powershell
Copy-Item .env.example .env        # une fois ; .env est lu par Docker Compose ET par le backend
docker compose up -d               # postgres, minio, coturn
docker compose ps
docker compose down                # garde les données ; `down -v` efface les volumes

# backend/ (port 4000)
npm run dev      # tsx watch src/index.ts
npm run build    # tsc -> dist/
npm start        # node dist/index.js
npm run db:migrate -- --name <nom>   # crée + applique une migration après modif de prisma/schema.prisma
npm run db:status                    # état des migrations
npm run db:generate                  # régénère le client (aussi lancé par postinstall)
npm run db:studio                    # interface web pour explorer la base

# frontend/ (port 5173)
npm run dev
npm run build    # tsc (vérification de types, noEmit) puis vite build
```

Pas encore de tests ni de linter configurés.

## Langue
Réponds toujours en français.

## Architecture

- Monorepo sans workspace npm : `backend/` et `frontend/` ont chacun leur `package.json` et `node_modules`.
- **Configuration unique** : un seul `.env` à la racine. Le backend le charge explicitement depuis `backend/src/index.ts` via un chemin relatif au fichier (`../../.env`, valable depuis `src/` avec tsx et depuis `dist/` après build). Docker Compose interpole les mêmes variables dans `docker-compose.yml`.
- **Frontend → backend** : le frontend appelle `/api/...` ; le proxy Vite (`frontend/vite.config.ts`) retire le préfixe `/api` et redirige vers `http://localhost:4000`. Une route backend `/health` est donc appelée `/api/health` côté React.
- Backend en ESM (`"type": "module"`, `module: NodeNext`) : les imports relatifs TypeScript doivent porter l'extension `.js`.
- **Chargement du `.env`** : `backend/src/env.ts` doit rester le **premier import** de `index.ts`. En ESM les imports sont évalués avant le code, donc `db.ts` lirait `DATABASE_URL` trop tôt sinon.

## Prisma (base de données)

- **Prisma 7.10.1, versions épinglées exactement** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). Le dist-tag npm `latest` de `prisma` pointe vers une `8.0.0-rc` : ne jamais faire `npm install prisma` sans version. Les trois paquets doivent avoir la même version.
- Prisma 7 : l'URL de connexion n'est pas dans `schema.prisma` mais dans `backend/prisma.config.ts`, qui charge le `.env` **racine**. Le client est instancié avec l'adaptateur `PrismaPg` dans `backend/src/db.ts` (singleton `prisma` à réutiliser partout).
- Client généré dans `backend/src/generated/prisma/` (ignoré par Git, importer depuis `./generated/prisma/client.js`).
- Conventions du schéma : modèles PascalCase / champs camelCase côté TS, tables et colonnes snake_case en SQL (`@@map`/`@map`), ids UUID. Les fichiers (photo de profil, photo de groupe, pièces jointes) référencent la table `media` (clé d'objet MinIO), jamais une URL.
- Changer `POSTGRES_PASSWORD` dans `.env` ne modifie pas une base déjà initialisée (l'image Postgres ne l'applique qu'à la création du volume) : faire un `ALTER USER whatsapp WITH PASSWORD ...` dans le conteneur, ou `docker compose down -v` si les données peuvent être perdues.

## Services Docker : pièges connus

- **PostgreSQL** est exposé sur **5433** côté Windows (`POSTGRES_PORT`), car un PostgreSQL 18 natif occupe déjà 5432 sur la machine. Sans ça, `localhost:5432` atteint silencieusement la mauvaise base.
- **MinIO** utilise `cgr.dev/chainguard/minio` (`minio/minio` a été retiré de Docker Hub). Entrypoint déjà `/usr/bin/minio`, donc `command` ne contient que les arguments. Tourne en UID 65532 : garder un **volume nommé**, jamais un bind mount d'un dossier Windows (erreurs de permissions). API 9000, console 9001.
- **coturn** : pas de `network_mode: host` (non supporté par Docker Desktop) ; ports 3478 udp/tcp + relais 49160-49200/udp publiés explicitement. Configuration uniquement par arguments (`command:`). Ne pas ajouter `-n` (l'entrypoint passe chaque argument dans `echo`, qui avale `-n`) ni `--no-cli` (déprécié en 4.19). `TURN_EXTERNAL_IP=127.0.0.1` ne convient qu'en local.
