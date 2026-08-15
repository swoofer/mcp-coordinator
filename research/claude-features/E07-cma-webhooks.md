# E07 — Webhooks sortants signés : pousser vers CI, Slack et dashboards tiers

| Champ | Valeur |
|---|---|
| **ID** | `cma-webhooks` |
| **Surface** | managed-agents |
| **Statut** | beta |
| **Disponible depuis** | `2026-07-22` (extension aux events `environment.*` et `memory_store.*`) |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC 100 % local, aucun accès Anthropic requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**
- §2 — payload : la forme documentée est plus riche que celle de la fiche. Le corps réel porte `type: "event"`, `id` (préfixe `whe_`), `created_at`, et `data { type, id, organization_id, workspace_id }`. Exemple remplacé par la forme verbatim de la doc.
- §2 — l'identifiant à dédupliquer est le **`id` de premier niveau** (pas `event.id` imbriqué dans `data`), et il vaut exactement la valeur de l'en-tête `webhook-id`. Marqueur `(à vérifier)` tranché.
- §2 — l'algorithme de signature n'est pas documenté verbatim sur la page officielle : la doc renvoie à `unwrap()` du SDK. Marqueur remplacé par `(non vérifiable — algorithme non documenté ; la doc n'expose que unwrap())`.
- §2 — ajout des contraintes d'endpoint documentées (HTTPS port 443, hostname publiquement résolvable) et des `disabled_reason` machine-readable, absents de la fiche.
- §2 — `deployment.*` explicité : `created | updated | paused | unpaused | archived | deleted`.
- §5 — `src/serve-http.ts` : les lignes citées (~369-376) désignaient le seul chemin de reprise. Corrigé en handler SSE ~324-376 (`SSE_RESUME_CAP` ligne 324, `getEventsSince` ligne 369) + route `/api/events` ligne 732.

Vérifié sans correction nécessaire : en-têtes `webhook-id` / `webhook-timestamp` / `webhook-signature`, secret `whsec_` 32 octets montré une seule fois, `ANTHROPIC_WEBHOOK_SIGNING_KEY`, `client.beta.webhooks.unwrap(body, headers)` + fenêtre de fraîcheur 5 min, liste complète des types d'événements, 3 tentatives max / backoff jitté 5-120 s / abandon sans signal, absence de replay, les trois causes d'auto-désactivation, statut `beta` (namespace `client.beta.webhooks`). Côté repo : tous les fichiers de §5 existent ; `MAX_SSE_CLIENTS = 100` avec `addListener` qui retourne `NOOP` silencieux au plafond (`src/sse-emitter.ts:120-123`) ; `emit()` avale bien les exceptions de listener (`src/sse-emitter.ts:65-72`) ; `src/server-setup.ts:132` et `:138` sont exacts ; grep `backoff|retry|jitter` sur `src/security/audit.ts` + `audit-queue.ts` : 0 résultat, confirmé ; les trois `examples/*` existent et dépendent tous de MQTT.

Remarque hors mandat (§6.5 non modifiée) : `src/security/allowlist.ts` n'existe pas ; le fichier réel est `src/auth/allowlist.ts`.

**Marqueurs `(à vérifier)` restants :** aucun. Un marqueur `(non vérifiable)` subsiste en §2 sur l'algorithme de signature. La date « Disponible depuis 2026-07-22 » n'a pas pu être recoupée sur la doc officielle (elle ne porte pas de changelog daté) — laissée telle quelle.

**Testabilité :** ✅ testable
E07 ne consomme pas les webhooks Anthropic, elle transpose leur design : tout le protocole §6.3 est exécutable ici avec Node 22 + le repo + un daemon local, sans credentials Anthropic ni header beta. On peut lancer le daemon, brancher un listener via `sseEmitter.addListener()` qui POST vers un serveur HTTP local, et mesurer perte silencieuse, saturation de `MAX_SSE_CLIENTS` et latence de `emit()`.

## 1. Ce que c'est

Claude Managed Agents pousse les changements d'état majeurs (session, agent, deployment, vault, environment, memory store) vers un endpoint HTTPS enregistré dans la Console, en complément du flux SSE. Le design est volontairement minimaliste : le payload ne transporte que `data.type` et `data.id`, jamais l'état de la ressource — le consommateur doit refaire un `GET` sur la ressource, ce qui garantit qu'un retry tardif ne livre pas de données périmées. L'authenticité repose sur un secret `whsec_` de 32 octets affiché une seule fois à la création, et sur trois en-têtes (`webhook-id`, `webhook-timestamp`, `webhook-signature`) vérifiés côté client par une fonction SDK qui rejette une signature invalide ou un payload de plus de 5 minutes.

Les garanties de livraison sont faibles et explicitement documentées : pas d'ordre garanti, doublons possibles (déduplication sur `event.id` à la charge du consommateur), 3 tentatives maximum avec backoff jitté entre 5 et 120 s, après quoi l'événement est **abandonné sans signal**. Il n'y a pas de replay rétroactif si on s'abonne après coup, et l'endpoint est auto-désactivé sur réponse 3xx, IP non publique, ou échecs prolongés. La documentation dit explicitement que les webhooks ne sont pas un log durable — le log durable reste l'API de listing.

C'est cette combinaison — payload minimal + signature standard + garanties honnêtement dégradées + auto-désactivation — qui constitue le motif réutilisable, davantage que la feature elle-même.

## 2. Surface d'API exacte

```
# En-têtes de la requête sortante
webhook-id
webhook-timestamp
webhook-signature

# Secret et vérification
whsec_<32 octets>                       # affiché une seule fois à la création
ANTHROPIC_WEBHOOK_SIGNING_KEY           # variable d'environnement côté consommateur
client.beta.webhooks.unwrap(body, headers)   # SDK — rejette signature invalide ou payload > 5 min

# Types d'événements
session.status_run_started
session.status_idled
session.budget_reached
session.status_rescheduled
session.status_terminated
session.thread_created
session.thread_idled
session.thread_terminated
session.outcome_evaluation_ended
session.updated
session.deleted
agent.created | agent.updated | agent.archived | agent.deleted
vault.*
vault_credential.refresh_failed
deployment.created | deployment.updated | deployment.paused | deployment.unpaused | deployment.archived | deployment.deleted
deployment_run.started | deployment_run.succeeded | deployment_run.failed
environment.created | environment.updated | environment.archived | environment.deleted
memory_store.created | memory_store.archived | memory_store.deleted

# Contraintes d'endpoint (enregistrement en Console : Manage > Webhooks)
URL HTTPS sur le port 443, hostname publiquement résolvable
disabled_reason  # machine-readable, ex. "auto-disabled: endpoint URL returned a redirect (3xx)"
```

Payload (forme documentée, verbatim) :

```json
{
  "type": "event",
  "id": "whe_9d5c1f7e...",
  "created_at": "2026-03-18T14:05:22Z",
  "data": {
    "type": "session.status_idled",
    "id": "sesn_01XYZ...",
    "organization_id": "8a3d2f1e-...",
    "workspace_id": "c7b0e4d9-..."
  }
}
```

L'identifiant à dédupliquer est le champ `id` **de premier niveau** (préfixe `whe_`), unique par événement et non par livraison ; il vaut exactement la valeur de l'en-tête `webhook-id`, et chaque nouvelle tentative le rejoue à l'identique. `webhook-timestamp` est en revanche re-stampé à chaque tentative (donc un retry ne se fait pas rejeter par le contrôle de fraîcheur) ; l'horodatage de l'événement lui-même est `created_at` dans le corps. L'algorithme de signature exact n'est pas exposé sur la page officielle, qui ne documente que `unwrap()` *(non vérifiable — algorithme non documenté ; convention Standard Webhooks vraisemblable mais non affirmée par Anthropic)*.

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/webhooks
- https://releasebot.io/updates/anthropic/claude-developer-platform

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Aujourd'hui le coordinateur ne pousse que vers des clients **connectés** : SSE (`src/sse-emitter.ts`, endpoint dans `src/serve-http.ts`) et MQTT (`src/mqtt-bridge.ts`, `src/mqtt-broker.ts`). Tout consommateur non permanent — un job CI, un canal Slack, un dashboard tiers — doit héberger un pont MQTT qui tourne en continu. C'est exactement ce que font aujourd'hui `examples/slack-webhook/`, `examples/discord-webhook/` et `examples/github-actions-mqtt-bridge/` : trois exemples maintenus dans le repo dont la seule raison d'être est de compenser l'absence de push sortant natif. Une sortie webhook signée les rendrait tous les trois obsolètes en tant que code à maintenir (ils redeviendraient de simples recettes de configuration d'URL).

Ce qui apparaît côté capacité : un mainteneur peut abonner un endpoint Slack ou un `repository_dispatch` GitHub à `thread_created` / `thread_resolved` / `conflict_detected` sans faire tourner de process. Ce qui disparaît côté code : la logique de reconnexion MQTT dupliquée dans les trois exemples.

Le motif Anthropic est directement transposable et évite deux erreurs classiques. D'abord le payload minimal : le coordinateur a déjà la table `events` avec un `id` auto-incrémenté (`src/sse-emitter.ts`, `getEventsSince` / `getRecentEvents`) — envoyer `{type, id}` et laisser le consommateur faire un `GET /api/events?since=` réutilise l'existant et supprime le risque de fuite de contenu (`plan`, `resolution_summary`) vers un endpoint tiers. Ensuite la déduplication et l'auto-désactivation : sans elles, un endpoint mort transformerait chaque `sseEmitter.emit()` en retry indéfini au sein du process du coordinateur.

Le secret `whsec_` affiché une seule fois a déjà son équivalent maison : `src/auth/service-tokens.ts` (« shown once; never retrievable »), avec un chemin d'administration existant dans `src/admin/handle-service-tokens.ts`.

**Risque si on ne fait rien :**
Faible et non urgent. Le coût est un coût d'intégration continu : chaque nouvel intégrateur écrit son propre pont MQTT, et les trois exemples du repo restent du code à faire vivre. Aucun risque de rupture de compatibilité.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/sse-emitter.ts` | Point de fan-out unique. `emit()` insère déjà en base et notifie les listeners via `setImmediate`. Un émetteur webhook s'enregistrerait via `addListener(orgId, …)` — mais attention, `MAX_SSE_CLIENTS` (100) plafonne la même liste : un listener webhook consommerait un slot SSE. |
| `src/server-setup.ts` | Lignes ~132 : le motif est déjà en place (`sseEmitter.addListener("default", …)` pour le cache de quota) et ligne ~138 `consultation.onResolve(...)` fanout SSE + MQTT + métriques. C'est là que se brancherait le dispatcher webhook. |
| `src/mqtt-bridge.ts` | Référence de conception : le pont existant vers l'extérieur. Un dispatcher webhook est le troisième canal après SSE et MQTT — cf. la remarque « EventBus » de `docs/superpowers/working/audit/code/13-refactoring.md`. |
| `src/serve-http.ts` | Handler SSE lignes ~324-376 (`SSE_RESUME_CAP = 1000` ligne 324, reprise `getEventsSince` ligne 369), route `/api/events` ligne 732 : le `GET` de re-lecture que ferait le consommateur webhook doit passer par le même chemin authentifié. |
| `src/admin/handle-service-tokens.ts` | Modèle d'API d'administration pour un CRUD d'endpoints webhook (création, secret montré une fois, révocation). |
| `src/auth/service-tokens.ts` | Modèle de secret à usage unique non re-récupérable. |
| `src/security/audit.ts`, `src/security/audit-queue.ts` | La file d'audit existe ; aucun backoff ni retry n'y a été trouvé (grep `backoff|retry|jitter` : 0 résultat) — la logique de réessai jitté serait entièrement à écrire. |
| `src/observability/metrics.ts`, `src/metrics.ts` | Compteurs à ajouter : livraisons, échecs, endpoints auto-désactivés. |
| `examples/slack-webhook/`, `examples/discord-webhook/`, `examples/github-actions-mqtt-bridge/` | Trois ponts MQTT→webhook maintenus à la main que la feature rendrait redondants. |
| `src/tools/*.ts` (`consultation-tools.ts`, `agents-tools.ts`) | Aucun changement attendu : ils appellent `sseEmitter.emit()`, le fan-out est en aval. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le dispatcher webhook doit-il se brancher sur `sseEmitter.addListener()` — donc consommer un slot du plafond `MAX_SSE_CLIENTS` et hériter du fan-out best-effort en `setImmediate` sans persistance de la tentative — ou faut-il d'abord extraire un EventBus/outbox lisant la table `events` par curseur, seul moyen d'avoir un retry jitté et une auto-désactivation qui survivent à un redémarrage du coordinateur ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de protocole, à valider en session de challenge.>

- [ ] Lire `src/sse-emitter.ts` + `src/server-setup.ts` et confirmer qu'un listener webhook consomme bien un slot de `MAX_SSE_CLIENTS`, et ce qui se passe quand le cap est atteint (`addListener` retourne `NOOP` silencieusement).
- [ ] Écrire un PoC : un listener qui POST `{type, event_id}` signé HMAC-SHA256 vers un serveur local, et vérifier qu'une exception dans le listener est bien avalée par le `catch` de `emit()` (donc perte silencieuse de l'événement).
- [ ] Tuer le coordinateur pendant un retry en cours et mesurer combien d'événements sont perdus — comparer avec une lecture par curseur sur la table `events`.
- [ ] Mesurer la latence ajoutée à `emit()` sous charge (20 agents, 1 endpoint webhook lent à 2 s) et vérifier que le chemin SSE/MQTT n'est pas dégradé.
- [ ] Remplacer le pont d'`examples/slack-webhook/` par le PoC et compter les lignes de code supprimées.

### 6.4 Résultat observé

<À remplir pendant le challenge.>

### 6.5 Contre-arguments

- **La feature elle-même est en beta et hors périmètre.** E07 n'est pas une intégration : on ne consomme pas les webhooks Anthropic, on copie leur design. Le bénéfice ne dépend donc pas de la stabilité de la beta — mais il ne bénéficie d'aucune compatibilité non plus. On écrit du code maison de bout en bout.
- **YAGNI.** Le besoin est déjà couvert par trois exemples qui fonctionnent. Personne n'a demandé un push sortant natif ; le déploiement typique est un mainteneur solo avec un swarm local, pas une flotte d'intégrations tierces.
- **Surface de sécurité sortante nouvelle.** Un endpoint webhook configurable transforme le coordinateur en client HTTP arbitraire : SSRF vers l'intérieur du réseau, exfiltration si un compte compromis enregistre une URL. Anthropic répond par « refus des IP non publiques » — il faudrait implémenter une allowlist/blocklist d'IP maison, un travail sensible et facile à rater. `src/security/allowlist.ts` existe mais couvre un autre besoin.
- **Coût de maintenance disproportionné pour un canal de plus.** Retry jitté, déduplication, auto-désactivation, rotation de secret, UI d'administration, métriques : c'est un sous-système, pas un branchement. L'effort M est probablement optimiste si on veut la persistance des tentatives.
- **Complexité pour l'auto-hébergeur.** Un troisième canal à comprendre et diagnostiquer (« pourquoi mon endpoint est-il désactivé ? ») après SSE et MQTT, alors que `cli/doctor.ts` doit déjà expliquer deux transports.
- **Le fan-out actuel n'est pas conçu pour ça.** `emit()` avale silencieusement toute exception de listener et ne persiste aucune tentative de livraison. Greffer une livraison réseau sur ce chemin donne une livraison « best-effort » plus faible encore que celle d'Anthropic, sans la remplacer par un vrai outbox.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : payload et champ de déduplication corrigés, lignes serve-http.ts recalées, testable localement. |
