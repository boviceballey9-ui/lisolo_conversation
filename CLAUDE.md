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
npm run db:generate                  # régénère le client (aussi lancé par postinstall et après db:migrate)
npm run db:studio                    # interface web pour explorer la base

# frontend/ (port 5173)
npm run dev
npm run build    # tsc (vérification de types, noEmit) puis vite build
```

Tests backend (Vitest + Supertest, contre une vraie base PostgreSQL `whatsapp_test`) — conteneur `wa-postgres` démarré requis :

```powershell
cd backend
npm test                                              # toute la suite
npx vitest run src/__tests__/auth.test.ts -t "refresh"   # un fichier / les tests dont le nom contient "refresh"
npm run test:watch
```

Pas de linter configuré.

## Langue
Réponds toujours en français.

## Architecture

- Monorepo sans workspace npm : `backend/` et `frontend/` ont chacun leur `package.json` et `node_modules`.
- **Configuration unique** : un seul `.env` à la racine. Le backend le charge explicitement depuis `backend/src/index.ts` via un chemin relatif au fichier (`../../.env`, valable depuis `src/` avec tsx et depuis `dist/` après build). Docker Compose interpole les mêmes variables dans `docker-compose.yml`.
- **Frontend → backend** : toutes les routes du backend sont préfixées par `/api` (`/api/auth/*`, `/api/users/*`, `/api/health` ; `/health` reste en alias). Le proxy Vite (`frontend/vite.config.ts`) transmet `/api/...` **sans réécriture** vers `http://localhost:4000`.
- **`src/app.ts` vs `src/index.ts`** : `createApp()` construit l'app Express sans `listen` (utilisée telle quelle par Supertest) ; `index.ts` charge l'env puis écoute. Nouveau routeur → le monter dans `createApp()`, avant `errorHandler`.
- Express 4 : les erreurs des handlers `async` ne sont pas capturées automatiquement, chaque handler fait `try/catch` + `next(err)`.

## Authentification

- JWT HS256 signés avec **deux secrets distincts** (`JWT_ACCESS_SECRET` 15 min, `JWT_REFRESH_SECRET` 7 j) + claim `type: "access" | "refresh"` vérifié (`src/auth/tokens.ts`). `sub` = id utilisateur.
- Routes protégées : middleware `requireAuth` (`src/middleware/requireAuth.ts`) → `req.userId`. Validation des corps : `validateBody(schemaZod)` (400 avec `details` par champ).
- Ne jamais renvoyer `passwordHash` : utiliser `publicUserSelect` (`src/routes/users.ts`) dans les `select` Prisma.
- Refresh token **sans état** (non stocké en base) : pas de révocation possible côté serveur pour l'instant.
- `src/config.ts` lève une erreur au démarrage si un secret manque.
- Frontend : `frontend/src/api.ts` (`apiFetch`) ajoute le Bearer et, sur 401, appelle `/api/auth/refresh` une fois puis rejoue la requête. Tokens dans `localStorage`.

## Chat temps réel (Socket.io)

- `src/index.ts` crée le serveur HTTP (`http.createServer(createApp())`) et y attache Socket.io (`attachSocket`, `src/socket.ts`) : même port 4000. Proxy Vite : `/socket.io` avec `ws: true`.
- **Logique métier dans `src/chat/service.ts`**, partagée par les routes HTTP (`src/routes/conversations.ts`) et les handlers socket. Les erreurs métier sont des `HttpError` (`src/errors.ts`) : `errorHandler` les traduit en code HTTP, le socket en ack `{ ok: false, error }`.
- Auth du socket au handshake (`auth.token` = access token, sinon `connect_error` `UNAUTHORIZED`). Chaque socket rejoint la room `user:<id>` ; on émet toujours vers une room utilisateur, jamais vers un socket précis (multi-onglets / appareils).
- Contrat des événements :
  - client → serveur (avec ack) : `message:send { conversationId, content, clientId? }` → `{ ok, message, clientId }` ; `message:delivered { messageIds }` ; `message:read { conversationId }`.
  - serveur → client : `message:new` (destinataires + autres sockets de l'expéditeur, pas le socket émetteur) ; `message:status { conversationId, messageIds, userId, status }` (vers l'expéditeur).
  - À la connexion, les messages `SENT` du destinataire passent à `DELIVERED` (reçus hors ligne).
- Statuts **uniquement vers l'avant** (`SENT → DELIVERED → READ`, `advanceStatuses`). Le `status` d'un message dans les DTO = le moins avancé parmi ses destinataires.
- Conversations privées : unicité par paire via `conversations.direct_key` (ids triés joints par `:`), création par `upsert` + reprise sur `P2002`.
- Historique : pagination par curseur (`before` = id du plus ancien message affiché, ordre `createdAt desc, id desc`), page renvoyée en ordre chronologique + `nextCursor`.
- `conversation.updatedAt` est mis à jour à chaque message (tri de la liste).
- Frontend : état et handlers socket dans `frontend/src/pages/Chat.tsx` (refs pour lire l'état courant dans les handlers), envoi optimiste avec `clientId` remplacé à l'ack, `message:delivered` à la réception, `message:read` si la conversation est ouverte et l'onglet visible. Styles dans `frontend/src/chat.css`.
- Limite connue : le token n'est vérifié qu'à la connexion du socket ; un socket ouvert survit à l'expiration de l'access token.

### Présence et « en train d'écrire »

- **État en mémoire, dans la closure de `attachSocket`** (jamais en base, sauf `users.last_seen_at`) : `connections` (nombre de sockets ouverts par utilisateur) et `typing` (clé `<userId>:<conversationId>` → minuteur, socket, destinataires). Conséquence : valable pour **un seul processus** ; plusieurs instances du backend nécessiteraient Redis (adaptateur Socket.io + état partagé).
- En ligne au passage 0 → 1 connexion ; hors ligne au passage 1 → 0 : écrire `last_seen_at`, puis **re-vérifier que l'utilisateur ne s'est pas reconnecté** avant d'émettre `online: false`.
- La présence n'est diffusée qu'aux **contacts** (`contactIds` : partagent une conversation) ; `presence:get` filtre aussi sur les contacts.
- Événements : client → serveur `typing:start` / `typing:stop { conversationId }`, `presence:get { userIds }` (ack `{ presence: [{ userId, online, lastSeenAt }] }`) ; serveur → client `presence:update { userId, online, lastSeenAt }`, `typing:update { conversationId, userId, isTyping }`.
- Saisie : `isTyping: true` émis seulement au premier `typing:start` ; les suivants relancent le minuteur (`typingTimeoutMs`, 3 s par défaut, option de `attachSocket` — 200 ms dans les tests). Arrêt aussi à `typing:stop`, à `message:send`, et à la déconnexion du socket qui a signalé la saisie.
- Front : `typing:start` limité à 1 toutes les 2 s (doit rester < `typingTimeoutMs`) ; à chaque (re)connexion, l'état présence/saisie est vidé puis la présence redemandée.

## Tests

- `test/globalSetup.ts` crée la base `whatsapp_test` si besoin et y applique `prisma migrate deploy` ; `test/setup.ts` redirige `DATABASE_URL` vers `TEST_DATABASE_URL` (garde-fou : refuse si identique à la base de dev) et fait un `TRUNCATE` de toutes les tables avant **chaque** test. Ajouter une table → l'ajouter à ce `TRUNCATE`.
- `BCRYPT_ROUNDS=4` en test. Fichiers en série (`fileParallelism: false`).
- `test/helpers.ts` : `createUser()` (insert direct + token), `startServer(options?)` (vrai serveur HTTP + Socket.io sur port 0, à fermer dans `afterEach`), `connect(url, token)`, `waitFor(socket, event)`, `expectNoEvent(socket, event)`. Côté client de test, utiliser `socket.emitWithAck(...)`.
- `src/__tests__/` est exclu du build `tsc`.
- Backend en ESM (`"type": "module"`, `module: NodeNext`) : les imports relatifs TypeScript doivent porter l'extension `.js`.
- **Chargement du `.env`** : `backend/src/env.ts` doit rester le **premier import** de `index.ts`. En ESM les imports sont évalués avant le code, donc `db.ts` lirait `DATABASE_URL` trop tôt sinon.

## Prisma (base de données)

- **Prisma 7.10.1, versions épinglées exactement** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`). Le dist-tag npm `latest` de `prisma` pointe vers une `8.0.0-rc` : ne jamais faire `npm install prisma` sans version. Les trois paquets doivent avoir la même version.
- Prisma 7 : l'URL de connexion n'est pas dans `schema.prisma` mais dans `backend/prisma.config.ts`, qui charge le `.env` **racine**. Le client est instancié avec l'adaptateur `PrismaPg` dans `backend/src/db.ts` (singleton `prisma` à réutiliser partout).
- Client généré dans `backend/src/generated/prisma/` (ignoré par Git, importer depuis `./generated/prisma/client.js`).
- **`migrate dev` refuse de tourner en environnement non interactif** quand il veut une confirmation (ex. ajout d'une contrainte unique). Contournement : créer le dossier `prisma/migrations/<horodatage>_<nom>/`, y écrire la sortie de `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` dans `migration.sql`, puis `npx prisma migrate deploy` et `npx prisma generate`.
- **Prisma 7 : `prisma migrate dev` ne régénère plus le client.** Le script `postdb:migrate` le fait après `npm run db:migrate` ; si on lance `npx prisma migrate dev` directement, enchaîner `npx prisma generate` (sinon erreurs « Unknown argument » sur les nouveaux champs).
- Conventions du schéma : modèles PascalCase / champs camelCase côté TS, tables et colonnes snake_case en SQL (`@@map`/`@map`), ids UUID. Les fichiers (photo de profil, photo de groupe, pièces jointes) référencent la table `media` (clé d'objet MinIO), jamais une URL.
- Changer `POSTGRES_PASSWORD` dans `.env` ne modifie pas une base déjà initialisée (l'image Postgres ne l'applique qu'à la création du volume) : faire un `ALTER USER whatsapp WITH PASSWORD ...` dans le conteneur, ou `docker compose down -v` si les données peuvent être perdues.

## Services Docker : pièges connus

- **PostgreSQL** est exposé sur **5433** côté Windows (`POSTGRES_PORT`), car un PostgreSQL 18 natif occupe déjà 5432 sur la machine. Sans ça, `localhost:5432` atteint silencieusement la mauvaise base.
- **MinIO** utilise `cgr.dev/chainguard/minio` (`minio/minio` a été retiré de Docker Hub). Entrypoint déjà `/usr/bin/minio`, donc `command` ne contient que les arguments. Tourne en UID 65532 : garder un **volume nommé**, jamais un bind mount d'un dossier Windows (erreurs de permissions). API 9000, console 9001.
- **coturn** : pas de `network_mode: host` (non supporté par Docker Desktop) ; ports 3478 udp/tcp + relais 49160-49200/udp publiés explicitement. Configuration uniquement par arguments (`command:`). Ne pas ajouter `-n` (l'entrypoint passe chaque argument dans `echo`, qui avale `-n`) ni `--no-cli` (déprécié en 4.19). `TURN_EXTERNAL_IP=127.0.0.1` ne convient qu'en local.
