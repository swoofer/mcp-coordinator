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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser : §4 se contredit ; livrable #353 |

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

**Ce que je pense avant de mesurer.** La question §6.1 oppose deux branchements — `sseEmitter.addListener()` contre un EventBus/outbox à extraire. À la lecture de `src/sse-emitter.ts` (144 lignes), je pense que **l'opposition est mal posée dans les deux sens**.

D'un côté, le chemin listener est disqualifié d'avance et pas seulement « best-effort » : `emit()` fait un `INSERT` **synchrone** puis fan-out en `setImmediate` avec un `catch {}` **vide** (l. 64-71), et `addListener` rend `NOOP` **silencieusement** au-delà de `MAX_SSE_CLIENTS` (l. 118-122). Une livraison réseau greffée là serait perdue sans trace à la moindre exception, et muette sans trace si le dispatcher s'enregistre après le plafond.

De l'autre, l'outbox n'est pas « à extraire » : il **existe déjà**. La table `events` porte un `id` auto-incrémenté peuplé par `emit()` (l. 46-49), et `getEventsSince(orgId, lastId, limit)` (l. 84-96) est exactement la lecture par curseur qu'il faut. Ce qui manque n'est pas le bus, c'est la **table de tentatives** — et c'est là que se cache le vrai coût.

Hypothèse principale : le verdict ne se jouera ni sur le branchement ni sur la faisabilité, mais sur le **bénéfice annoncé en §4** — « rendre obsolètes les trois exemples `examples/*` ». Si ces trois ponts ne sont pas majoritairement du code qu'un webhook sortant supprimerait, la justification s'effondre et il ne reste qu'un sous-système à écrire et à maintenir pour un besoin que personne n'a formulé.

Hypothèse secondaire : la surface SSRF sortante est le vrai coût caché, et le dépôt vient précisément de trancher deux fois sur ce sujet (`B03`, et le correctif OIDC #304/#310).

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Écrits **avant** d'exécuter quoi que ce soit. Un seul qui se déclenche tue `adopter`.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Personne ne l'a demandé.** Le déploiement typique est un mainteneur solo avec un swarm local, pas une flotte d'intégrations tierces. | **0** issue ou discussion GitHub réclamant un push sortant / webhook |
| **K2** | **Le bénéfice annoncé n'existe pas.** §4 affirme que la feature rendrait les trois `examples/*` obsolètes « en tant que code à maintenir ». Si l'essentiel de leur code n'est **pas** du pont MQTT remplaçable, la justification principale tombe. | **< 50 %** des lignes des trois exemples supprimées par un webhook sortant |
| **K3** | **Le chemin listener perd en silence.** Si une exception dans un listener est avalée sans trace **et** qu'aucune tentative n'est persistée, une livraison réseau greffée là est plus faible que celle d'Anthropic — qui, elle, retente 3 fois. | perte silencieuse **démontrée par exécution**, pas par lecture |
| **K4** | **Le plafond est un piège muet.** Si `addListener` rend `NOOP` sans lever ni journaliser, un dispatcher enregistré après le plafond est silencieusement mort. | `NOOP` silencieux **démontré par exécution** |
| **K5** | **Aucun garde d'origine sortante réutilisable.** Ouvrir un client HTTP vers une URL configurable, c'est ouvrir une SSRF. S'il n'existe aucun contrôle d'origine réutilisable dans le dépôt, il faut l'écrire — travail sensible et facile à rater. | **0** helper d'allowlist/contrôle d'URL sortante réutilisable en l'état |
| **K6** | **L'effort `M` est un mensonge.** Un canal de plus, c'est un sous-système : retry jitté, déduplication, auto-désactivation, rotation de secret, CRUD d'administration, métriques, persistance des tentatives. | ≥ **5** sous-systèmes distincts à écrire de zéro |

**Règle que je m'impose :** §0 classe la fiche ✅ **testable** — PoC 100 % local, aucune excuse pour conclure sur du raisonnement. K3 et K4 doivent être **exécutés**, pas lus.

### 6.3 Protocole de vérification

<Proposition de protocole, à valider en session de challenge.>

- [ ] Lire `src/sse-emitter.ts` + `src/server-setup.ts` et confirmer qu'un listener webhook consomme bien un slot de `MAX_SSE_CLIENTS`, et ce qui se passe quand le cap est atteint (`addListener` retourne `NOOP` silencieusement).
- [ ] Écrire un PoC : un listener qui POST `{type, event_id}` signé HMAC-SHA256 vers un serveur local, et vérifier qu'une exception dans le listener est bien avalée par le `catch` de `emit()` (donc perte silencieuse de l'événement).
- [ ] Tuer le coordinateur pendant un retry en cours et mesurer combien d'événements sont perdus — comparer avec une lecture par curseur sur la table `events`.
- [ ] Mesurer la latence ajoutée à `emit()` sous charge (20 agents, 1 endpoint webhook lent à 2 s) et vérifier que le chemin SSE/MQTT n'est pas dégradé.
- [ ] Remplacer le pont d'`examples/slack-webhook/` par le PoC et compter les lignes de code supprimées.

### 6.4 Résultat observé

#### A. Le résultat qui tranche : **§4 se contredit elle-même**, et aucune variante de conception ne le répare

§4 tire deux bénéfices de la feature, dans le même paragraphe (l. 113-117) :

- **(A)** rendre les trois `examples/*` « obsolètes en tant que code à maintenir » ;
- **(B)** le payload minimal `{type, id}` « supprime le risque de fuite de contenu (`plan`, `resolution_summary`) vers un endpoint tiers ».

Mesuré : les trois ponts lisent **9 champs de payload**.

```
agent_id, claimed_at, claimed_by, completed_by, status, subject,
summary, target_modules, thread_id
```

Un `{type, id}` n'en porte **aucun**. Donc **(B) ⇒ ¬(A)** : le payload minimal ne peut pas alimenter les ponts qu'il est censé rendre obsolètes.

Et le corollaire est plus dur encore. Sous (B), le consommateur doit refaire un `GET /api/events?since=` **vers le coordinateur** — or `hooks.slack.com` ne rappellera jamais votre daemon. **La conception d'Anthropic ne peut structurellement servir qu'un consommateur que vous hébergez vous-même.** C'est-à-dire : un pont. C'est-à-dire exactement ce qui existe déjà.

La variante « payload complet + en-têtes et corps configurables » échappe à la contradiction, mais elle déplace les fonctions de formatage d'`examples/` — un échantillon forkable, sans garantie de compatibilité — vers `src/`, où elles héritent du semver, des tests et du support. Le coût de maintenance monte, il ne baisse pas.

#### B. Ce qu'un webhook sortant supprimerait vraiment (K2)

**J'ai d'abord mesuré ça de travers.** Ma première méthode classait ligne à ligne sur une regex (`mqtt|client.connect|subscribe|TOPIC_FILTER|…`) et rendait « 13 % supprimables » ; elle ne captait que la ligne portant le mot-clé et ratait les blocs entiers (`client.on("connect", …)`, la fenêtre de drain, les gardes). Une seconde méthode par délimitation d'accolades a rendu « 84 % ». **Trois méthodes, trois chiffres** : c'est le signal que le comptage de lignes n'est pas un argument robuste, et je ne m'appuie pas dessus.

Voici l'inventaire brut, qui lui est vérifiable :

```
examples/slack-webhook/bridge.mjs  (169 lignes)
     9 l.  function parsePayload(buf)
     5 l.  function threadIdFromTopic(topic)
    61 l.  function formatEvent(topic, data)          <- survit
    15 l.  async function postToSlack(message)        <- survit

examples/discord-webhook/bridge.mjs  (171 lignes)
     9 l.  function parse(payload)
    14 l.  async function postToDiscord(embed)        <- survit
    64 l.  function toEmbed(topic, data)              <- survit

examples/github-actions-mqtt-bridge/bridge.mjs  (210 lignes)
     9 l.  function parsePayload(buf)
     4 l.  function threadIdFromTopic(topic)
    29 l.  function summarize(topic, data)            <- survit
     8 l.  function webhookBody(topic, data, text)    <- survit
    17 l.  async function forward(topic, data, text)  <- survit
    10 l.  async function shutdown(code)
```

**208 lignes sur 550 (38 %) sont du formatage et du POST vers le tiers : elles survivent intactes.** Le transport MQTT proprement dit fait environ 206 lignes (≈ 38 %) et disparaît ; le reste est de l'analyse d'environnement et des gardes qu'un récepteur webhook redemande — auxquelles il faut **ajouter** un serveur HTTP, la vérification de signature et la déduplication.

**K2 se déclenche** : au mieux ~38 % de lignes supprimées, sous le seuil de 50 %, et une partie du solde est remplacée plutôt que supprimée. Trois précisions honnêtes :

- `threadIdFromTopic` **disparaît vraiment** — il n'existe que parce que MQTT encode le `thread_id` dans le chemin du topic, alors que le payload le porte déjà.
- `parsePayload` est **remplacé**, pas supprimé (`req.json()`).
- Le **filtrage** est **déplacé**, pas supprimé : il y a **21 sites `sseEmitter.emit()` pour 16 `EventType`** contre 7 `mqttBridge.publish*`. Un dispatcher branché sur `addListener` verrait tout (`impact_scored`, `file_edited`, `token_usage`…) ; le filtre redevient nécessaire, côté coordinateur cette fois.

#### C. K3 et K4 — exécutés, pas déduits

```
--- K3 : perte silencieuse ---
  emit() a-t-il leve ?                   : false
  le listener en echec a-t-il ete appele : true
  le listener voisin a-t-il recu         : true
  un signal quelconque de l'echec ?      : aucun (catch {} vide, sse-emitter.ts:67-71)
  l'evenement est-il en base malgre tout : true (id=1)
  => K3 SE DECLENCHE : l'echec de livraison est indiscernable du succes

--- K4 : plafond muet ---
  MAX_SSE_CLIENTS                        : 100
  listenerCount apres saturation         : 100
  addListener a-t-il leve ?              : non (il rend une fonction)
  la valeur rendue est-elle distinguable : function — indiscernable d'un vrai unsubscribe
  le dispatcher tardif a-t-il recu       : false
  refus comptabilises                    : 1 (compteur prive, aucune metrique)
  => K4 SE DECLENCHE : dispatcher muet, sans erreur ni exception
```

Greffer une livraison réseau sur ce chemin donnerait une livraison **plus faible que celle d'Anthropic** — qui, elle, retente 3 fois et désactive l'endpoint en le disant.

**Latence — le risque n'est pas celui qu'annonçait §6.3.** 50 `emit()` avec un listener bloqué 2 s : **7,4 ms au total, 0,15 ms par emit**. Le fan-out est en `setImmediate`, donc `emit()` ne bloque pas. Le vrai risque est l'accumulation **non bornée** de closures en attente, sans file ni contre-pression.

**Et l'outbox existe déjà.** `events` porte un `id` auto-incrémenté peuplé par `emit()` (`sse-emitter.ts:46-49`) et `getEventsSince(orgId, lastId, limit)` (`:84-96`) est la lecture par curseur. Vérifié : 20 `emit()` → 20 lignes lues, zéro perte. **La question §6.1 est donc mal posée** : le bus n'est pas « à extraire », il est là. Ce qui manque est la **table de tentatives**.

#### D. Ce que je dois concéder : pour GitHub Actions, mon argument s'inverse

J'allais écrire qu'un webhook sortant est « strictement pire » pour l'auto-hébergeur, parce qu'un client MQTT marche derrière un NAT alors qu'un endpoint HTTPS doit être publiquement joignable. C'est vrai pour deux des trois — et **faux pour le troisième** :

| Exemple | URL broker | « marche derrière un NAT » |
|---|---|---|
| `slack-webhook/bridge.mjs:18` | `mqtt://127.0.0.1:1883` | ✅ |
| `discord-webhook/bridge.mjs:16` | `mqtt://127.0.0.1:1883` | ✅ |
| `github-actions-mqtt-bridge/bridge.mjs:50-58` | `wss://` **imposé par une garde** | ❌ **inversé** |

Le pont GHA refuse explicitement `mqtt://` : *« The coordinator's TCP broker is bound to 127.0.0.1, so it is NOT reachable from a GitHub-hosted runner »*. Il **impose donc aujourd'hui d'exposer le coordinateur publiquement** derrière un reverse proxy TLS. Un webhook sortant le laisserait derrière son NAT. Et son README nomme la contrainte de fond : *« Actions is not a daemon »* — avec `RUN_SECONDS=55` toutes les 15 min, soit **~6 % de couverture**, et un renvoi vers `examples/fly-io` (une machine `always-on`, carte bancaire requise) pour ne rien rater.

**C'est le meilleur argument contre mon verdict, et il ne vaut que pour un tiers du corpus.** Il ne le sauve pas pour autant : `repository_dispatch` — le cas d'usage que §4 met en avant — **n'existe nulle part dans le dépôt** (aucune occurrence hors de cette fiche), et il exigerait que le coordinateur stocke un PAT GitHub `repo`, c'est-à-dire une nouvelle classe de secret tiers, dans un projet qui vient de durcir son egress (#304/#310).

#### E. Adjudication des six critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | 0 issue réclamant un push sortant | 0. Les 3 issues qui matchent (**#89, #90, #94**, CLOSED) sont les issues de **création des exemples eux-mêmes** ; #130 porte sur les channels. | **SE DÉCLENCHE** |
| **K2** | < 50 % des lignes supprimées | ~38 % au mieux ; 208/550 lignes de formatage survivent intactes ; le filtrage migre vers `src/` au lieu de disparaître. | **SE DÉCLENCHE** |
| **K3** | perte silencieuse démontrée | exécuté : `catch {}` vide, aucun signal, `emit()` ne lève pas. | **SE DÉCLENCHE** |
| **K4** | `NOOP` silencieux démontré | exécuté : dispatcher tardif muet, valeur rendue indiscernable, `rejectedCount` sans métrique. | **SE DÉCLENCHE** |
| **K5** | 0 garde d'origine réutilisable | **faux** : `isLoopbackHostname` est **exporté** (`boot.ts:137`) et déjà réutilisé (`:436`), et `oidc.ts:120-156` porte une allowlist d'origine (correctif #310). *Réserve honnête :* elle n'est pas branchable telle quelle — elle dérive sa confiance d'un `issuerUrl`, et un endpoint webhook n'a aucun émetteur qui le cautionne ; il faudrait une nouvelle racine de confiance (~60 lignes). | **NE SE DÉCLENCHE PAS** |
| **K6** | ≥ 5 sous-systèmes de zéro | **1 brique réutilisable** (`getEventsSince`). **5 patrons à recopier**, dont `handle-service-tokens.ts` — que `admin-common.ts:6-8` documente explicitement comme *« does NOT use these helpers — it hand-rolls its own … intentionally NOT wired »*, soit le handler le **moins factorisé** du dépôt. **8 à 10 à écrire** : table de tentatives + migration, retry jitté (`grep -riE "backoff\|jitter"` = **2 occurrences, toutes deux des commentaires**), déduplication, auto-désactivation + `disabled_reason`, rotation de secret, CRUD admin, métriques, allowlist d'origine sortante, diagnostic `doctor` du 3ᵉ canal, abonnement par type. Et `audit-queue.ts` **n'est pas un outbox** : buffer mémoire `CAPACITY = 10_000` qui **jette** au débordement (`:89`). | **SE DÉCLENCHE** |

**Cinq sur six.** Le seul qui ne se déclenche pas le fait en ma défaveur — le garde d'origine existe, donc l'argument SSRF de §6.5 est plus faible que la fiche ne le dit.

#### F. Le précédent que le projet a déjà écrit

`docs/maintainer-notes.md:93-106`, sur une question structurellement identique (l'`EventStore` du transport MCP) :

> *« This is intentional (**YAGNI**), not an oversight: server-pushed events already have a dedicated, reliable channel — the embedded MQTT broker / SSE emitter … **Policy**: implement the SDK's `EventStore` interface … only if a concrete client need emerges that MQTT/SSE can't already satisfy. **Don't build it speculatively.** »*

Et `README.md:559-563` : la roadmap v1.0 est multi-instance + Postgres + SDK. **Aucune entrée « push sortant ».** Le seul « webhook » des docs livrées est **entrant** (invalidation de cache de membership GitHub App).

#### G. Le livrable réel, sans rapport avec les webhooks

`src/sse-emitter.ts:35-36` déclare l'intention : *« track refusals **so operators can see** when the cap is being hit »*. Elle n'est pas réalisée :

- `getRejectedCount()` (`:141`) a **zéro appelant en production** — seulement `tests/unit/p3-sse-resilience.test.ts:48` et `:61`.
- `src/metrics.ts:141` n'expose que la **jauge** `mcp_coordinator_sse_clients_active`. Au plafond elle est figée à 100 : **rien ne distingue « 100 clients sains » de « 100 clients + N refus »**.
- Asymétrie sur le `catch {}` : `src/mqtt-bridge.ts:84` journalise (`"MQTT message dropped"` avec `reason` et `topic`) ; `src/sse-emitter.ts:67-71` n'a **aucune** ligne de log.
- Le correctif a déjà sa forme dans le dépôt : `mcp_coordinator_mqtt_messages_dropped_total{reason}` (`src/metrics.ts:97`), livré en #263.

C'est un « garde-fou fantôme » de la même famille que #317, #319 et #324 — une intention écrite en commentaire, jamais câblée.

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-17 |
| **Justification** | ⭑ **§4 se contredit elle-même, et aucune variante de conception ne le répare.** Elle tire deux bénéfices du même paragraphe : (A) rendre les trois `examples/*` obsolètes, et (B) un payload minimal `{type, id}` qui empêche toute fuite de contenu. Or les trois ponts lisent **9 champs de payload** (`subject`, `summary`, `status`, `claimed_by`…) dont `{type, id}` ne porte aucun : **(B) ⇒ ¬(A)**. Pire, sous (B) le consommateur doit refaire un `GET` **vers le coordinateur** — et `hooks.slack.com` ne rappellera jamais votre daemon. **La conception d'Anthropic ne peut structurellement servir qu'un consommateur que vous hébergez vous-même : un pont. C'est-à-dire ce qui existe déjà.** La variante « corps configurable » y échappe, mais elle déplace le formatage d'`examples/` (forkable, sans garantie) vers `src/` (semver, tests, support) : le coût de maintenance monte. ⭑ **Cinq critères sur six se déclenchent.** K1 : aucune demande — les 3 issues qui matchent sont celles de **création des exemples eux-mêmes**. K2 : ~38 % de lignes supprimées au mieux, 208/550 de formatage survivent, et le filtrage **migre** vers `src/` (21 sites `emit()` / 16 `EventType` contre 4 événements voulus). K3 et K4 **exécutés** : le `catch {}` de `emit()` est vide et `addListener` rend `NOOP` — une livraison réseau greffée là serait **plus faible que celle d'Anthropic**, qui retente 3 fois et le dit. K6 : **1 brique réutilisable**, 5 patrons à recopier (dont le handler que `admin-common.ts:6-8` documente comme le moins factorisé du dépôt), **8 à 10 sous-systèmes à écrire** — `backoff\|jitter` ne rend que **2 commentaires** dans tout `src/`. ⭑ **Et le projet a déjà écrit ce refus.** `docs/maintainer-notes.md:93-106`, sur une question structurellement identique : *« server-pushed events already have a dedicated, reliable channel … implement it only if a concrete client need emerges that MQTT/SSE can't already satisfy. **Don't build it speculatively.** »* La roadmap v1.0 (`README.md:559-563`) ne porte aucune entrée « push sortant ». ⭑ **Ce que je concède.** Pour **GitHub Actions**, mon argument NAT s'inverse : `bridge.mjs:50-58` **refuse** `mqtt://` et impose d'exposer le coordinateur en `wss://` public, et son README nomme la contrainte de fond — *« Actions is not a daemon »*, ~6 % de couverture. C'est le meilleur argument contre ce verdict, et il ne vaut que pour un tiers du corpus ; le cas d'usage `repository_dispatch` que §4 met en avant **n'existe nulle part dans le dépôt** et exigerait de stocker un PAT GitHub. ⭑ **Corrections de la fiche.** K5 **ne se déclenche pas** : `isLoopbackHostname` est exporté et déjà réutilisé, et `oidc.ts:120-156` porte une allowlist d'origine (#310) — l'argument SSRF de §6.5 est donc plus faible que la fiche ne le dit. Et **§6.1 est mal posée** : l'outbox n'est pas « à extraire », il **existe** (`events.id` + `getEventsSince`) ; ce qui manque est la table de tentatives. **Correction de méthode :** ma première mesure de K2 rendait « 13 % », une seconde « 84 % » — trois méthodes, trois chiffres. J'ai retiré l'argument par comptage de lignes comme porteur et publié l'inventaire brut des fonctions à la place. |
| **Issue / PR** | **#353** — les refus de listener SSE sont invisibles : `getRejectedCount()` sans appelant en production, jauge `sse_clients_active` qui sature à 100, et deux `catch {}` sans journalisation là où le chemin MQTT journalise et compte (#263) |
| **Jalon visé** | Aucun pour la feature. #353 est de l'hygiène d'observabilité, sans urgence. Reconsidérer **uniquement** si un besoin concret émerge que MQTT/SSE ne satisfont pas — et le seul candidat identifié est GitHub Actions, qu'il faudrait d'abord voir demandé par quelqu'un. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : payload et champ de déduplication corrigés, lignes serve-http.ts recalées, testable localement. |
| 2026-08-17 | **Challenge — verdict `refuser`.** Le résultat décisif n'est pas une mesure mais une contradiction : **§4 tire deux bénéfices incompatibles** du même paragraphe — (A) rendre les trois `examples/*` obsolètes, (B) un payload minimal `{type, id}` qui empêche les fuites. Les trois ponts lisent **9 champs de payload** dont `{type,id}` ne porte aucun, donc **(B) ⇒ ¬(A)** ; et sous (B) le consommateur doit rappeler le **coordinateur**, ce que `hooks.slack.com` ne fera jamais. La conception d'Anthropic ne peut donc servir qu'un consommateur auto-hébergé — un pont, c'est-à-dire l'existant. **Cinq critères sur six se déclenchent.** K1 : les 3 issues qui matchent sont celles de **création des exemples** (#89, #90, #94). K2 : ~38 % de lignes supprimées au mieux, 208/550 de formatage survivent, le filtrage **migre** vers `src/`. K3 et K4 **exécutés** : `catch {}` vide et `addListener → NOOP`, donc une livraison réseau greffée là serait plus faible que celle d'Anthropic. K6 : 1 brique réutilisable, 8 à 10 sous-systèmes de zéro (`backoff|jitter` = **2 commentaires** dans tout `src/` ; `audit-queue.ts` n'est pas un outbox, il **jette** au débordement). **Et le projet avait déjà écrit ce refus** : `docs/maintainer-notes.md:93-106` — *« Don't build it speculatively »* — sur une question structurellement identique. **Concession** : pour GitHub Actions mon argument NAT **s'inverse** (`bridge.mjs:50-58` refuse `mqtt://` et impose un `wss://` public ; *« Actions is not a daemon »*, ~6 % de couverture) — meilleur argument adverse, valable pour un tiers du corpus. **Corrections de la fiche** : K5 **ne se déclenche pas** (`isLoopbackHostname` exporté et réutilisé, allowlist d'origine en `oidc.ts:120-156` depuis #310) — l'argument SSRF de §6.5 est plus faible qu'annoncé ; et **§6.1 est mal posée**, l'outbox existe déjà (`events.id` + `getEventsSince`, vérifié : 20 émissions, 20 lignes, zéro perte), ce qui manque est la table de tentatives. **Correction de méthode** : ma première mesure de K2 rendait 13 %, une seconde 84 % — j'ai retiré le comptage de lignes comme argument porteur et publié l'inventaire brut. Livrable sans rapport avec les webhooks : **#353**, les refus de listener SSE sont invisibles (`getRejectedCount()` sans appelant en production, jauge figée à 100, deux `catch {}` muets là où MQTT journalise et compte depuis #263). |
