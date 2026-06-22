# CCI PLANNING SYNC — Notes techniques pour Claude Code

## Rôle du service

Backend Express.js pour la synchronisation temps réel des plannings Gantt.
Sert deux usages :
1. **API REST** — CRUD plannings, import, historique
2. **WebSocket (Socket.IO)** — collaboration temps réel (curseurs, modifications partagées)

## Stack

- **Node.js** + **Express.js**
- **Socket.IO** — WebSocket + fallback polling
- **PostgreSQL** via `pg` (Pool) — partage la même base Neon que l'app Next.js
- **express-rate-limit** — 200 req/15min (general), 50 req/15min (mutations)
- **helmet** + **compression** + **cors**
- **Déploiement** : Vercel serverless (`module.exports = app` en fin de fichier)

## Variables d'environnement

| Variable | Description |
|---|---|
| `DATABASE_URL` | Connexion PostgreSQL Neon (pooled) |
| `CORS_ORIGINS` | Origines autorisées (séparées par virgule). Si absent : `*` |
| `NODE_ENV` | `production` ou `development` |
| `PORT` | Port local (dev uniquement, défaut `3000`) |
| `INIT_SECRET` | Secret pour l'endpoint `/api/init-db` |

## Routes API

```
GET    /api/plannings                # Liste tous les plannings
GET    /api/planning/:id             # Détail d'un planning
POST   /api/planning                 # Créer un planning
PATCH  /api/planning/:id             # Modifier un planning
GET    /api/planning/:id/changes     # Derniers changements (polling client)
POST   /api/planning/import          # Import d'un planning (JSON)
GET    /api/planning/:id/history     # Historique des modifications
POST   /api/planning/:id/join        # Rejoindre une session collaborative (Socket.IO)
GET    /api/planning/:id/collaborators # Collaborateurs actifs
GET    /health                       # Health check
POST   /api/init-db                  # Init schéma DB (protégé par INIT_SECRET)
```

## WebSocket

Socket.IO écoute sur le même port HTTP. Événements principaux :
- `join-planning` — rejoindre la salle d'un planning
- `planning-change` — diffuser une modification
- `cursor-move` — position curseur temps réel

## Journalisation des erreurs

`logError()` est défini directement dans `app.js` et insère dans la table `app_errors` (partagée avec l'app Next.js) :

```javascript
await logError({
  source: "sync:POST:/api/planning",
  message: err.message,
  details: { stack: err.stack, body: req.body },
  statusCode: 500,
});
```

Un middleware global catch-all en fin de fichier appelle `logError()` automatiquement pour toutes les erreurs Express non gérées.

## Conventions

- **Pas de TypeScript** — JavaScript ES2020 (`'use strict'`).
- **Pas de framework de migration** — SQL direct via `pool.query()`. Les migrations schéma se font depuis l'app Next.js (`drizzle-kit`) ou via `/api/init-db`.
- **Module exports** : `module.exports = app` — requis pour le runtime Vercel serverless.
- **Déploiement** : Vercel. Un `git push` sur `main` déclenche le déploiement.
- Vercel ne supporte pas les serveurs persistants — Socket.IO fonctionne en mode dégradé (polling) sur Vercel ; pour un vrai WebSocket persistant, prévoir un serveur dédié (Railway, Render…).

## Structure

```
app.js          # Point d'entrée unique — config, middleware, routes, Socket.IO, exports
api/            # (vide ou à structurer) — routes peuvent être extraites ici si app.js grandit
public/         # Fichiers statiques servis par Express
  index.html    # Page de test locale
  app.html      # Frontend embarqué CCI Planning 2026
package.json
vercel.json     # Config Vercel serverless
```

## Points d'attention

- `helmet` est configuré avec `contentSecurityPolicy: false` et `crossOriginEmbedderPolicy: false` pour éviter de casser Socket.IO et les assets statiques.
- Le rate limiter sur mutations (`POST/PATCH/PUT/DELETE`) est distinct du rate limiter général — ajuster les seuils si besoin dans `app.js`.
- En production Vercel, `httpServer.listen()` n'est pas appelé — c'est Vercel qui gère le binding réseau.
