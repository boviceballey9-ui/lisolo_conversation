# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

**Lisolo** (« conversation » en lingala) : messagerie à but pédagogique, dans l'esprit de WhatsApp (messagerie, médias, appels WebRTC, notifications push). Dépôt GitHub `boviceballey9-ui/lisolo_conversation`. Les identifiants techniques gardent l'ancien nom : base et utilisateur PostgreSQL `whatsapp` / `whatsapp_test`, conteneurs `wa-*`, dossier local. Ne pas les renommer sans migration des données. L'utilisateur apprend : expliquer les choix en français. Environnement : **Windows + PowerShell + Docker Desktop** — donner les commandes en syntaxe PowerShell (`;` et non `&&`, `Copy-Item`, `Invoke-RestMethod`).

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

### Groupes

- **Gestion par HTTP** (`src/routes/groups.ts` → `src/chat/groups.ts`), messages toujours par socket. Les routes diffusent via `req.app.get("io")`, posé par `index.ts` et `startServer` (`app.set("io", io)`). Absent dans les tests HTTP purs avec `createApp()` : rien n'est diffusé.
- **Rooms `group:<id>`** : rejointes à la connexion (`groupIdsOf` chargé dans le middleware `io.use`, avant `connection`). Après un ajout ou un départ, `broadcastGroupEffects` synchronise les rooms de tous les sockets de l'utilisateur (`io.in(userRoom).socketsJoin/socketsLeave`), puis émet `group:removed` aux partants et `message:new` (système) + `group:updated { conversationId, name, members }` à la room. Un message de groupe part en `socket.to(groupRoom)` ; le privé reste sur les rooms `user:<id>`.
- **Permissions vérifiées dans le service** : non-membre ou pas un groupe → 404 (on ne révèle pas l'existence) ; membre non admin → 403 (`forbidden()`). Admin : ajouter, retirer (pas soi-même → 400), nommer admin, renommer. Tout membre : quitter.
- Chaque mutation tourne dans `withGroupLock` (transaction interactive + `SELECT … FOR UPDATE` sur la conversation). Sans ce verrou, deux admins qui partent en même temps laissent un groupe sans admin : le test « verrou » échoue alors à coup sûr.
- Départ du dernier admin : le membre le plus ancien (`joinedAt`, puis `userId`) devient admin. Plus aucun membre → groupe supprimé. Départ ou retrait = **suppression de la ligne `participants`** : le groupe disparaît chez l'ancien membre (pas d'historique en lecture seule). Ses statuts non lus sont supprimés pour ne pas bloquer le ✓✓ bleu.
- **Messages système** : `type: SYSTEM`, `senderId` = auteur de l'action, texte français dans `content`, **aucune ligne `message_status`** (ni coches, ni non-lu). `createdAt` fixé côté Node, strictement croissant : en PostgreSQL, `now()` vaut l'heure de début de transaction, donc deux messages de la même transaction auraient la même date.
- Accusés : `message:status` contient aussi `aggregates: [{ id, status }]` (statut global = le moins avancé parmi les destinataires). Le front affiche `aggregates`, pas le `status` individuel. `message_status.delivered_at` / `read_at` alimentent `GET /api/conversations/:id/messages/:messageId/info` (expéditeur seulement, sinon 404).
- DTO message : `senderName` inclus (nom affiché en groupe, même pour un ancien membre). Résumé de conversation : `members: [{ user, role, joinedAt }]` pour un groupe (moi compris), `otherUser` pour le privé.
- Photo de groupe : `PATCH /api/groups/:id/photo { mediaId | null }` (admin, image uploadée par lui), message système + `group:updated` avec `photoId`.

## Appels audio / vidéo (PeerJS + Socket.io + coturn)

- **Deux canaux** :
  - Socket.io porte la **sonnerie** (`src/calls/socketCalls.ts`) ;
  - PeerJS porte la **signalisation WebRTC** après le décroché (PeerServer `src/calls/peer.ts`, monté sur `/peerjs`, même port).

  Le média va de navigateur à navigateur, ou passe par le relais TURN, jamais par le backend.
- Événements (client → serveur, avec ack) :
  - `call:invite { conversationId, type: AUDIO|VIDEO }` → `{ call, reason?: "OFFLINE" | "BUSY" }` ;
  - `call:accept`, `call:reject`, `call:end { callId }`.
- Événements (serveur → client, vers les rooms des **deux** utilisateurs) :
  - `call:invite { call, caller }` (appelé seulement, tous ses onglets) ;
  - `call:accept { call }` (l'appelant lance `peer.call`, les autres onglets de l'appelé se taisent) ;
  - `call:reject` / `call:end { call }` ;
  - `call:busy { call }` (appelant) ;
  - puis `message:new` (message `CALL`).
- **État en mémoire** dans `createCallManager` (`calls`, `userCall`) : un seul processus. La réservation des deux utilisateurs est **synchrone** avant l'écriture en base, pour que deux invitations simultanées donnent « occupé ».
  - Appelé hors ligne (0 socket) → MISSED immédiat.
  - Appelé déjà en appel → BUSY.
  - Délai `callTimeoutMs` (30 s par défaut, 300 ms en test) → MISSED.
  - Déconnexion du socket qui porte l'appel → fin de l'appel.
  - Au démarrage, `closeStaleCalls()` clôt les appels restés RINGING ou ONGOING.
- Statuts finaux : COMPLETED / MISSED (sans réponse, annulé par l'appelant, hors ligne) / REJECTED / BUSY. `finishCall` met à jour `calls` et crée un message `type: CALL` (`call_id`, `createdAt = startedAt`, sans statuts de livraison) dans la même transaction.
- **PeerServer** :
  - l'id PeerJS est l'id utilisateur ; le client envoie l'access token dans l'option `token`, et l'upgrade est refusé (401) sauf si le JWT est valide **et** `sub === id` ;
  - `allow_discovery: false` ;
  - **Piège** : un `ws.WebSocketServer({ server, path })` répond 400 et ferme **toutes** les autres connexions WebSocket du serveur HTTP (dont `/socket.io`). D'où `createWebSocketServer` en `noServer: true`, avec notre propre écouteur `upgrade` qui ne prend que `/peerjs/peerjs`. Vérifié : sans ça, les 12 tests socket échouent.
- Une connexion PeerServer par id : le `Peer` est créé à l'appel et détruit à la fin (`frontend/src/calls/useCall.ts`), pour ne pas bloquer les autres onglets.
- **ICE** : `GET /api/calls/ice-config` renvoie STUN + TURN avec des identifiants temporaires (12 h) :
  - `username = "<expiration>:<userId>"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))` (`src/calls/ice.ts`) ;
  - coturn est en `--use-auth-secret --static-auth-secret=${TURN_SECRET}` ;
  - sans `TURN_SECRET` : repli sur `TURN_USER`/`TURN_PASSWORD` (coturn doit alors être lancé avec `--user`) ;
  - `TURN_HOST` est l'hôte que le navigateur joint ;
  - vérification manuelle : `turnutils_uclient -u <username> -w <credential> -y 127.0.0.1` dans `wa-coturn`.
- Front : `useCall` (machine à états outgoing / incoming / connecting / active / ended), `CallScreens.tsx`, sonnerie WebAudio (`ringtone.ts`). Si la caméra est refusée : repli en audio seul ; si le micro est refusé : erreur (et `call:reject` envoyé si l'on décrochait).
- **Limites** :
  - pas d'appels de groupe ;
  - `localhost` / `TURN_EXTERNAL_IP=127.0.0.1` : local seulement ;
  - access token dans l'URL WebSocket PeerJS (vérifié à la connexion uniquement) ;
  - pas de renégociation si la caméra est ajoutée en cours d'appel.

## Charte graphique Lisolo

- **Couleurs uniquement via les variables de `:root`** dans `frontend/src/chat.css` : bordeaux `#7B1E2B`, bordeaux foncé `#5A1520`, beige clair `#F3E6D3`, beige `#E8D5BC`, plus des rôles dérivés :
  - `--ink` / `--ink-muted` (texte), `--surface`, `--panel`, `--border` (décoratif) ;
  - `--field-border` (champs, ≥ 3:1) ;
  - `--read` (✓✓ sur bordeaux) et `--read-on-light` (✓✓ sur fond clair) ;
  - `--tick-on-accent`, `--danger-on-accent`.

  Les pages Connexion / Inscription (`src/styles.ts`, styles en ligne) utilisent ces mêmes variables via `var(--…)`. Plus aucun vert.
- Bulles envoyées : bordeaux et texte beige clair (règles `.bubble--mine …` en fin de `chat.css`). Bulles reçues : beige et texte `--ink`. Fond du chat : beige clair.
- **`npm run check:contrast`** (`frontend/scripts/check-contrast.mjs`) lit `:root` et vérifie 25 paires réellement utilisées : 4,5:1 pour le texte, 3:1 pour les icônes et contours (WCAG AA). Toute nouvelle association de couleurs doit y être ajoutée.
- Logos dans `frontend/public/`, en SVG faits main (mot « Lisolo » en traits, sans police) :
  - `logo-lisolo.svg` : pages Connexion / Inscription ;
  - `logo.svg` : en-tête de la barre latérale, écran vide ;
  - `icon.svg` : favicon.

  Les PNG (`icon-192/512.png`, `favicon.png`, `badge-72.png`) sont générés à partir des SVG (rendu Edge headless).

## Notifications push (Web Push)

- **Uniquement les nouveaux messages** (`message:send`), jamais les messages SYSTEM ni CALL. Push envoyé seulement aux destinataires **sans aucun socket** (`connections`, dans `socket.ts`), en tâche de fond (l'ack n'attend pas). Onglet ouvert mais caché : le **frontend** affiche une notification locale (`showLocalNotification` dans `Chat.tsx`). Pas de doublon.
- Backend `src/push/service.ts` :
  - `buildPayload` : `{ title, body, tag: "conversation-<id>", url: "/?c=<id>", conversationId }`. En privé, titre = expéditeur ; en groupe, titre = nom du groupe et corps = « auteur : texte ». Libellés 📷 / 🎥 / 🎤 / 📄, corps tronqué à 180 caractères.
  - `sendPush` : un envoi par abonnement ; 404 ou 410 → abonnement supprimé.
  - `pushRequestOptions` : VAPID, TTL 24 h, urgence haute.
- `PushSender` est injectable : `attachSocket(server, { pushSender })`. Les tests utilisent un faux émetteur. Le vrai chiffrement est vérifié avec `webpush.generateRequestDetails` + `http_ece.decrypt` (dépendance de dev), sans réseau.
- Table `push_subscriptions` (`endpoint` unique). L'**upsert par endpoint** fait suivre l'abonnement au compte connecté (navigateur partagé). Routes `/api/push` : `vapid-public-key`, `POST`/`DELETE subscriptions`. L'endpoint doit être en https.
- Clés VAPID : `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (`npx web-push generate-vapid-keys`). `config.push` est un getter. Sans clés : push désactivé (503 sur la clé publique). En test, `loadTestEnv` génère des clés jetables si absentes (CI sans secret).
- `web-push` épinglé en **3.6.7** (avec `@types/web-push` 3.6.4). La 4.0.0 est récente et sans types.
- Frontend :
  - `public/sw.js` : service worker classique, non bundlé par Vite. Événements `push` et `notificationclick` (focus + `postMessage` `open-conversation`, sinon `openWindow("/?c=<id>")`).
  - `src/push.ts` : `enablePush`, `disablePush`, `syncPushSubscription`.
  - À l'ouverture de l'application, un abonnement existant est renvoyé au serveur (rattaché à l'utilisateur courant) ; à la déconnexion, désabonnement.
  - Manifeste et icônes dans `public/`.
- Nginx : `/sw.js` et `/manifest.webmanifest` en `no-cache`. Le service worker exige un contexte sécurisé : HTTPS, ou `localhost` en développement.
- Vérifié en réel : Edge s'abonne au service push de Microsoft (WNS), et la notification est affichée par le service worker onglet fermé.

## Médias (MinIO, URL présignées)

- **Le fichier ne passe jamais par le backend.** Parcours :
  1. `POST /api/media/upload-url { mimeType, size, fileName? }` : le backend vérifie le type (liste blanche, `src/media/rules.ts`) et la taille (images et vocaux 16 Mo, vidéos 64 Mo, documents 100 Mo), puis signe un PUT valable 5 min.
  2. Le navigateur fait un PUT direct vers MinIO (XHR pour la progression).
  3. `POST /api/media { objectKey }` : `HeadObject`, revérification du type et de la taille réels, puis création de la ligne `media`.
  4. Envoi du message : `message:send { conversationId, mediaId }`. Le `type` du message est déduit du MIME par le serveur.
- `Content-Type` **et** `Content-Length` sont signés (`signableHeaders` dans `src/storage.ts`) : MinIO refuse lui-même (403) un autre type ou une autre taille. Les tests le vérifient.
- Clés `users/<uploaderId>/<uuid>` + colonne `media.uploader_id`. On n'enregistre que ses propres clés, et on n'attache (message, avatar, photo de groupe) que **ses propres** médias (`ownMedia`, sinon 404).
- Lecture : `GET /api/media/:id/url` renvoie une URL GET présignée de 5 min si `canRead` l'autorise (sinon 404) :
  - l'uploader ;
  - un membre d'une conversation où le média est attaché à un message, ou dont il est la photo ;
  - tout le monde pour une photo de profil.

  Un membre retiré perd l'accès. Pour les documents, la réponse inclut `Content-Disposition: attachment`.
- Front : `src/media.ts` (`uploadFile`, `useMediaUrl` avec cache). Une balise `<img>` ne peut pas envoyer l'en-tête Bearer, d'où les URL présignées.
- **Pièges** :
  - S3Client avec `forcePathStyle: true` ;
  - `requestChecksumCalculation` / `responseChecksumValidation: "WHEN_REQUIRED"` : sinon le SDK ajoute un CRC32 aux URL présignées et l'envoi depuis le navigateur échoue ;
  - CORS côté MinIO via `MINIO_API_CORS_ALLOW_ORIGIN` (= `FRONTEND_ORIGIN`) dans `docker-compose.yml` ; il faut recréer le conteneur après un changement.
- `index.ts` appelle `ensureBucket()` au démarrage. Si MinIO est injoignable, une erreur est journalisée mais le serveur démarre quand même.
- Tests : vrai MinIO, bucket `MINIO_TEST_BUCKET` (`loadTestEnv` remplace `MINIO_BUCKET`, avec un garde-fou ; `globalSetup` le crée et le vide). `config.storage.bucket` est un getter pour cette raison.
- **Limites connues** :
  - le backend utilise les identifiants **root** de MinIO ;
  - les fichiers orphelins (uploadés mais jamais enregistrés, ou jamais attachés) ne sont pas nettoyés ;
  - `MINIO_ENDPOINT` doit être joignable par le **navigateur** (`localhost` : même machine seulement) ;
  - l'URL d'une vidéo ou d'un audio peut expirer pendant une lecture longue ;
  - pas de légende sur les médias.

## HTTPS derrière Nginx (production locale)

- Service `nginx` (`nginx/Dockerfile` multi-étapes : build Vite dans `node:24-alpine`, puis `nginx:1.28-alpine` avec `nginx/nginx.conf`). **Seul point d'entrée réseau** : 443 (et 80 → 301 vers 443). Postgres et MinIO sont publiés sur `127.0.0.1` seulement ; coturn reste public (UDP des appels).
- Routes : `/` → statiques (`try_files … /index.html`, `/assets/` cache 1 an), `/api/` → backend, `/socket.io/` et `/peerjs/` → backend avec `proxy_http_version 1.1` + `Upgrade`/`Connection` + délais de 1 h, `/media/` → `minio:9000` (`client_max_body_size 101m`, `proxy_request_buffering off`).
- Le backend tourne sur **Windows** (pas dans Docker). Nginx le joint via `host.docker.internal:4000`.
- Après un changement du frontend ou de `nginx.conf` : `docker compose up -d --build nginx`.
- Certificats : `scripts/gen-certs.ps1 [-Ip x.x.x.x]` (mkcert, pour localhost, 127.0.0.1, ::1 et l'IP Wi-Fi) → `nginx/certs/` monté en lecture seule, **ignoré par Git** (`nginx/certs/`, `*.pem`, `*.key`). Le script `.ps1` doit garder son BOM UTF-8 (sinon PowerShell 5.1 abîme les accents).
- **Adresse publique** (`src/publicOrigin.ts`) : `publicOriginOf(req)` lit `X-Forwarded-Proto/Host` (posés par Nginx) et ne l'accepte que si `https://<hôte>` est dans `CORS_ORIGINS`. Sinon `null` : repli sur `MINIO_ENDPOINT` / `TURN_HOST`. Cette adresse sert à :
  - **signer les URL présignées** (`signerFor` dans `storage.ts` : un S3Client de signature par origine, qui ne fait aucun accès réseau). La signature porte sur l'hôte : Nginx transmet `Host: $http_host` **tel quel** à MinIO et **vide** `X-Forwarded-Host` pour `/media/`. `location /media/` suppose `MINIO_BUCKET=media` ;
  - annoncer coturn à la même adresse dans `ice-config`.
- `CORS_ORIGINS` (liste séparée par des virgules) : CORS Express et Socket.io (sans en-tête `Origin` : accepté), `MINIO_API_CORS_ALLOW_ORIGIN`, et liste blanche des adresses publiques. `TURN_EXTERNAL_IP` et `TURN_HOST` = IP Wi-Fi du PC. Changer l'IP impose de : relancer `gen-certs.ps1`, mettre à jour `.env`, puis `docker compose up -d` (coturn, minio, nginx).
- Téléphone : installer `rootCA.pem` de `mkcert -CAROOT` (**jamais** `rootCA-key.pem`) comme certificat d'autorité ; le pare-feu Windows doit laisser entrer 443 et l'UDP de coturn.

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
- **MinIO CORS** : `MINIO_API_CORS_ALLOW_ORIGIN` doit contenir l'origine du frontend (PUT direct depuis le navigateur). Pour vérifier : `curl.exe -i -X OPTIONS http://localhost:9000/media/x -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: PUT"`.
- **MinIO** utilise `cgr.dev/chainguard/minio` (`minio/minio` a été retiré de Docker Hub). Entrypoint déjà `/usr/bin/minio`, donc `command` ne contient que les arguments. Tourne en UID 65532 : garder un **volume nommé**, jamais un bind mount d'un dossier Windows (erreurs de permissions). API 9000, console 9001.
- **coturn** : pas de `network_mode: host` (non supporté par Docker Desktop) ; ports 3478 udp/tcp + relais 49160-49200/udp publiés explicitement. Configuration uniquement par arguments (`command:`). Ne pas ajouter `-n` (l'entrypoint passe chaque argument dans `echo`, qui avale `-n`) ni `--no-cli` (déprécié en 4.19). `TURN_EXTERNAL_IP=127.0.0.1` ne convient qu'en local. Authentification par `--use-auth-secret` (secret `TURN_SECRET`) : changer le secret impose de recréer le conteneur (`docker compose up -d coturn`).
