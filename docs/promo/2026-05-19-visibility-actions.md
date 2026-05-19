# Plan de visibilité v0.10.6 — actions à exécuter

Document de travail. Tout ce qui est ici est **draft pour ta revue** —
rien n'est publié tant que tu n'as pas validé.

## Statut

| # | Action | Statut |
|---|--------|--------|
| 1 | Fix `SECURITY.md` (version table + email placeholder) | ✅ Fait |
| 2 | `CODE_OF_CONDUCT.md` | ✅ Existait déjà |
| 3 | GitHub repo : homepage URL + Discussions activé | ✅ Fait |
| 4 | Curer 5-10 "good first issue" | ✅ 7 ouvertes (#67-#73) |
| 5 | Démo asciinema pour le README | ⏳ Requiert ton enregistrement |
| 6 | PR vers `modelcontextprotocol/servers` (liste officielle) | ⏳ Texte ci-dessous |
| 7 | Soumission mcp.so / smithery.ai / awesome-mcp-servers | ⏳ Liste ci-dessous |

### Issues ouvertes (étape 4)

| # | Titre | URL |
|---|-------|-----|
| 67 | Add `--json` output mode to `server status` | https://github.com/swoofer/mcp-coordinator/issues/67 |
| 68 | Improve error messages in backup/restore/logs CLI commands | https://github.com/swoofer/mcp-coordinator/issues/68 |
| 69 | Add `--url` override flag to `dashboard` command | https://github.com/swoofer/mcp-coordinator/issues/69 |
| 70 | Add `--print-only` dry-run flag to `init` | https://github.com/swoofer/mcp-coordinator/issues/70 |
| 71 | Add `--log-json` flag for production NDJSON logging | https://github.com/swoofer/mcp-coordinator/issues/71 |
| 72 | Add Python MQTT subscriber example | https://github.com/swoofer/mcp-coordinator/issues/72 |
| 73 | Add per-client quickstart docs (Cursor, Cline, Aider) | https://github.com/swoofer/mcp-coordinator/issues/73 |

---

## 4) "Good first issue" — candidats à curer

Pour attirer des contributeurs, il faut **5 à 10 tickets bien scopés**, où
quelqu'un de l'extérieur peut livrer en 1-3h sans devoir comprendre toute
l'architecture. Voici des idées génériques — il faudrait passer un agent
Explore sur le code pour confirmer la faisabilité de chacun.

### Idées candidates

1. **Mode `--json` pour `mcp-coordinator server status`**
   Actuellement la commande affiche du texte. Ajouter `--json` qui sort
   un objet structuré pour les scripts.
   *Effort estimé : 1-2h. Fichier probable : `cli/server.ts`.*

2. **`mcp-coordinator doctor` — health check command**
   Vérifie : port 3100/1883 libres, DB lisible, config valide, version
   Node ≥ requise. Pratique pour le triage. Pattern emprunté à
   homebrew/yarn.
   *Effort : 2-3h. Nouveau fichier `cli/doctor.ts`.*

3. **`--port` flag pour `mcp-coordinator dashboard`**
   Permet d'ouvrir le dashboard sur un port custom si 3100 est pris.
   *Effort : 30 min. Fichier : `cli/dashboard.ts`.*

4. **Exemple Python client dans `examples/`**
   Petit script qui appelle `announce_work` via le SDK MCP Python.
   Aide les non-TS à comprendre.
   *Effort : 1-2h. Nouveau dossier `examples/python/`.*

5. **Exemple Docker Compose avec Caddy reverse proxy**
   Le `SECURITY.md` recommande TLS via reverse proxy mais il n'y a pas
   d'exemple complet. Une stack `docker-compose.yml` clé en main avec
   Caddy serait précieuse.
   *Effort : 2-3h. Nouveau dossier `examples/docker-caddy/`.*

6. **i18n stub pour le dashboard (préparation FR)**
   Extraire les strings UI du dashboard dans un fichier `locales/en.json`,
   préparer la structure pour ajouter `fr.json` plus tard.
   *Effort : 2-4h. Fichier : `dashboard/public/`.*

7. **Bouton "Copy MQTT topic" dans le dashboard**
   Petit ajout UX : à côté de chaque topic affiché, un bouton qui copie
   dans le presse-papier.
   *Effort : 1h. Fichier : `dashboard/public/`.*

8. **Logs structurés en JSON via `pino` (option `--log-json`)**
   Si déjà fait, fermer comme "wontfix". Sinon, exposer le format JSON
   de pino derrière un flag CLI.
   *Effort : 1-2h.*

9. **Doc : "Premiers pas avec Cursor" / "avec Cline" / "avec Aider"**
   Un fichier MD par client, captures + snippet `.mcp.json` adapté.
   *Effort : 1h chacun. Dossier `docs/clients/`.*

10. **`mcp-coordinator init --print-only`**
    Affiche ce que `init` ferait sans rien écrire. Utile en CI.
    *Effort : 1h. Fichier : `cli/init.ts`.*

### Prochaine étape suggérée

Lancer un agent Explore sur `cli/`, `dashboard/`, `examples/` pour :
- Confirmer que ces 10 idées n'existent pas déjà
- Identifier 5 autres opportunités vues dans le code (TODO, FIXME, petits
  bugs déjà signalés)

Puis ouvrir les 5-7 meilleurs avec label `good first issue` + description
détaillée (fichier à modifier, comportement attendu, tests à ajouter).

---

## 5) Démo asciinema pour le README

Un GIF/asciinema de 30-60 secondes en haut du README est **le facteur
unique le plus prédictif de stars** sur un projet GitHub.

### Pourquoi asciinema plutôt qu'un GIF
- Texte sélectionnable (pas une image)
- Léger (~10 KB vs 5 MB pour un GIF de qualité)
- Pause/replay disponible
- Embed via image SVG dans GitHub README (rendu OK)

### Setup
```bash
# Installer asciinema
sudo apt install asciinema   # ou: brew install asciinema
# Compte gratuit sur asciinema.org pour upload (anonyme aussi possible)
```

### Script de démo (à enregistrer)

Scène 1 — solo (15s) :
```bash
# Terminal 1
mcp-coordinator init
mcp-coordinator server start --daemon
mcp-coordinator server status
mcp-coordinator dashboard
# (le dashboard s'ouvre dans le navigateur)
```

Scène 2 — conflit détecté (30s) :
```bash
# Terminal 2 — Agent A
# Simuler un announce_work qui touche src/auth.ts
curl -X POST http://localhost:3100/mcp/tool/announce_work \
  -d '{"agent_id":"alice","target_files":["src/auth.ts"]}'

# Terminal 3 — Agent B (peu après)
curl -X POST http://localhost:3100/mcp/tool/announce_work \
  -d '{"agent_id":"bob","target_files":["src/auth.ts"]}'

# → le dashboard affiche un thread "conflict detected"
# → Terminal 2 reçoit la notification MQTT
```

Scène 3 — résolution (15s) : Alice poste un message dans le thread,
Bob acquitte, thread se ferme.

### Commande d'enregistrement
```bash
asciinema rec demo.cast --title "mcp-coordinator: detect conflicts before they happen"
# Lancer les 3 scènes
# Ctrl-D pour finir
asciinema upload demo.cast
```

### Intégration README
Remplacer le diagramme ASCII actuel "How It Works" par :
```markdown
[![asciicast](https://asciinema.org/a/XXXXX.svg)](https://asciinema.org/a/XXXXX)
```

---

## 6) PR vers `modelcontextprotocol/servers`

C'est la **liste officielle Anthropic** des serveurs MCP. Être listé là =
trafic qualifié constant + crédibilité immédiate.

### Avant de PR — vérifier
- Format actuel de la liste : https://github.com/modelcontextprotocol/servers
  (le README peut avoir changé — adapter le format au moment du PR)
- Section "Community Servers" ou "Third-Party Servers" (selon nomenclature
  actuelle)

### Entrée à proposer

```markdown
- **[mcp-coordinator](https://github.com/swoofer/mcp-coordinator)** —
  Embedded MQTT broker + MCP server for multi-agent coordination.
  Detects conflicts between parallel AI coding agents before they happen,
  pushes coordination events over MQTT, ships with a live dashboard.
  Works with Claude Code, Cursor, Cline, Aider. OAuth 2.1 + RFC 8628
  device flow. MIT.
```

### Titre / description du PR

Titre : `Add mcp-coordinator to community servers list`

Description :
```markdown
## What

Adds [mcp-coordinator](https://github.com/swoofer/mcp-coordinator) to the
community servers list.

## Why

mcp-coordinator solves a problem unique to teams running multiple AI
agents in parallel on the same repository: regressions, duplicated work,
architectural drift between agents that don't know about each other.

It does this by giving agents a shared MQTT-backed nervous system —
agents announce intent before coding, conflicts are scored against a
detection layer (file overlap, module impact, dependency graph), and a
consultation thread opens when score ≥ 90.

## Notes

- 26 MCP tools (register_agent, announce_work, post_to_thread, etc.)
- Embedded Aedes MQTT broker — zero infra to install
- Client-agnostic over HTTP/SSE or stdio
- Optional OAuth 2.1 + device flow (single-user runs zero-config)
- MIT, npm-published, CI on tests + e2e
```

---

## 7) Listings additionnels

| Cible | URL | Action |
|-------|-----|--------|
| **mcp.so** | https://mcp.so | Soumettre via leur formulaire web (généralement un `submit` link) |
| **smithery.ai** | https://smithery.ai | Soumettre via leur registry (GitHub auto-discovery dans certains cas) |
| **awesome-mcp-servers** | https://github.com/punkpeye/awesome-mcp-servers | PR avec une ligne similaire à celle pour `modelcontextprotocol/servers` |
| **awesome-claude-code** | (chercher repo le plus actif au moment de la soumission) | Idem |
| **awesome-ai-agents** | https://github.com/e2b-dev/awesome-ai-agents | PR section "Tools & Frameworks" |

---

## Ordre d'exécution recommandé

1. Toi : relire ce doc, biffer les idées qui ne te conviennent pas
2. Moi : explore le code pour confirmer les "good first issue" candidats
3. Moi : draft final des 5-7 tickets retenus → tu valides → j'ouvre via `gh`
4. Toi : enregistrer l'asciinema (3-5 min) → upload → me donner l'URL →
   j'intègre dans le README
5. Moi : draft final PR `modelcontextprotocol/servers` → tu valides → fork
   leur repo + PR
6. Moi : drafts pour les 4 autres listings → tu valides chacun → soumission
