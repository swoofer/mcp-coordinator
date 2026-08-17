# E14 — Entreprise : inference hooks, Compliance API, annuaire de connecteurs

| Champ | Valeur |
|---|---|
| **ID** | `enterprise-audit-directory` |
| **Surface** | claude-api |
| **Statut** | mixte : `beta` (inference hooks) · `GA` (Compliance API, annuaire) |
| **Disponible depuis** | Inference hooks : beta, Claude Enterprise uniquement · Compliance API : GA (Enterprise + Console) · Annuaire : GA, date inconnue |
| **Tier** | T3-à-surveiller |
| **Nature** | threat (avec deux volets `opportunity`) |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas d'org Claude Enterprise ni de Compliance Access Key |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement ; le livrable est #366, une latence de 1,5 s sur announce_work |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur la signature et le corps de l'événement `prompt` est tranché : en-têtes `webhook-id` / `webhook-timestamp` / `webhook-signature` (`v1,<base64>`, HMAC-SHA256 sur `{webhook-id}.{webhook-timestamp}.{octets bruts}`), corps `{type, request_id, tenant_id, actor, source, messages, session_id, model, metadata}`.
- §2 — le schéma de verdict était incomplet : le champ `reference_id` (≤ 50 car.) manquait ; `deny_reason` est borné à 500 caractères.
- §2 — « Timeout de verdict : 5 s par défaut » précisé : plage configurable 1–10 000 ms.
- §2 — « Denials journalisés dans `GET /v1/compliance/activities` » précisé : type d'activité `inference_hooks_request_denied`, porteur du `reference_id` renvoyé.
- §2 — objet `Activity` : la valeur de `actor.type` est `user_actor` (pas `user`), et `organization_uuid` manquait.
- §2 — ajout des contraintes opérationnelles omises : corps jusqu'à 10 Mo, un seul retry (100 ms, uniquement sur échec de connexion), IP source `160.79.106.0/24`, services de tunnel (ngrok) bloqués, circuit breaker.
- §1 — nuance : la signature n'existe qu'une fois le secret de signature généré ; le tout premier test de connexion arrive **non signé**.
- §5 — `src/conflict-detector.ts` : `detect()` a déjà une signature sans `AuthClaims` (`{org_id, agent_id, target_modules, target_files}`) ; c'est son unique appelant (`src/tools/consultation-tools.ts:105`, outil `announce_work`) qui dérive `org_id` de `getSessionClaims`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Vérifications faites sans correction :** statut `beta` (inference hooks) / `GA` (Compliance API, annuaire) confirmé ; indisponibilité sur Amazon Bedrock et Google Cloud confirmée ; permission `organization:manage` confirmée ; shadow mode / pourcentage de rollout / exclusions par rôle confirmés ; rate limit 600 req/min par organisation parente confirmé ; les 11 fichiers cités en §5 existent tous ; les 26 occurrences de `readOnlyHint` (4/11/3/3/3/2) sont exactes ; `cli/channel.ts` lignes 340-348 exposent bien `post_to_thread` sans aucune annotation ; grep `webhook` : zéro occurrence dans `src/` et `cli/` ; critères de l'annuaire (annotations, 64 caractères, séparation lecture/écriture avec le contre-exemple `api_request`/`method`, interdiction d'instructions comportementales, `ui/open-link`, allowed link URIs, `claude plugin validate`, portail de soumission, `mcp-review@anthropic.com`) tous confirmés.

**Testabilité :** ⚠️ partielle
Testable ici : mesurer `ConflictDetector.detect()` sur une base réaliste, écrire l'endpoint jetable `POST /webhooks/anthropic-inference` répondant `{"action":"allow"}` avec un vérificateur Standard Webhooks unitairement testé sur des vecteurs synthétiques, et passer les 26 outils de `src/tools/*` + `post_to_thread` à la checklist de l'annuaire.
Non testable ici : recevoir un vrai POST d'Anthropic (il faut une org Claude Enterprise, la permission `organization:manage`, et un endpoint HTTPS public sur un domaine contrôlé — les tunnels type ngrok sont explicitement bloqués), donc impossible d'inspecter un corps `prompt` réel ; et appeler `GET /v1/compliance/activities`, qui exige une Compliance Access Key ou une Admin API key d'organisation.

---

## 1. Ce que c'est

Trois surfaces « entreprise » d'Anthropic que le projet n'a jamais regardées, et qui touchent toutes le même terrain que mcp-coordinator : la gouvernance d'une flotte d'agents.

**Inference hooks (beta).** Le flux est l'inverse des hooks Claude Code : c'est Anthropic qui fait un `POST` HTTPS vers un serveur hébergé par l'organisation, avant chaque inférence, en joignant le transcript de conversation, et attend un verdict `allow`/`deny` dans un timeout configurable (5 s par défaut). Un seul hook gouverne claude.ai, Cowork et les sessions Claude Code (web, desktop, CLI) de l'organisation. Chaque requête est signée selon la spec Standard Webhooks — mais seulement une fois le secret de signature généré : le tout premier test de connexion, envoyé avant la première sauvegarde, arrive non signé. Le seul événement aujourd'hui est `prompt`. Modes shadow, pourcentage de rollout et exclusions par rôle sont fournis. Techniquement, mcp-coordinator peut se déclarer comme ce serveur : c'est le seul mécanisme identifié qui lui permet d'agir sur des agents qui ne l'ont pas installé.

**Compliance API (GA).** Sous `/v1/compliance/*`, Anthropic expose déjà l'Activity Feed de l'organisation et les transcripts des sessions Claude Code et Cowork, y compris les sessions locales tournant sur les machines des utilisateurs dès lors qu'ils sont connectés avec un compte Enterprise, plus l'annuaire (organisations, users, rôles, groupes) et les settings effectifs. La doc positionne elle-même cette API face à l'OTel (push temps réel) et aux inference hooks (inline).

**Critères de revue de l'annuaire (GA).** Le répertoire de connecteurs sert claude.ai, Desktop, mobile, Claude Code et Cowork depuis un catalogue unique. Les critères de listing sont une checklist de qualité applicable même sans soumission : séparer outils de lecture et d'écriture, annoter chaque outil, borner les descriptions, interdire les instructions comportementales dans les descriptions.

## 2. Surface d'API exacte

**Inference hooks** (endpoint fourni par le client, configuré dans claude.ai, permission `organization:manage`) :

```
POST <votre-endpoint-https>          # événement : type = "prompt"
En-têtes fixes : Content-Type: application/json
                 User-Agent: anthropic-dlp/1
                 Accept-Encoding: identity
Signature (spec Standard Webhooks, en-têtes en minuscules) :
  webhook-id         # = request_id du corps ; clé d'idempotence
  webhook-timestamp  # unix secondes, tolérance ±300 s
  webhook-signature  # "v1,<base64>" espacés ;
                     # HMAC-SHA256 sur {webhook-id}.{webhook-timestamp}.{octets bruts}
                     # secret = base64 STANDARD après le préfixe whsec_
Corps  : { type, request_id, tenant_id, actor{type,id,email_address},
           source{application}, messages[], session_id, model, metadata }
         blocs de contenu : text | tool_use | tool_result | attachment
         (jamais les octets bruts, jamais les system prompts,
          jamais les définitions d'outils, jamais le raisonnement caché)
         corps non tronqué, jusqu'à 10 Mo
Réponse : HTTP 200 obligatoire dans les deux cas
          {"action":"allow"}
        | {"action":"deny","deny_reason":"…","reference_id":"…"}
          deny_reason <= 500 car. (tronqué) ; reference_id <= 50 car. [A-Za-z0-9._:/-]
          tout autre statut = webhook failure, pas un deny
Timeout de verdict : 1 à 10 000 ms, 5 000 ms par défaut
Retry     : exactement 1, après 100 ms, uniquement si la connexion échoue
Failure handling : block | allow (+ circuit breaker sur échecs soutenus)
Denials journalisés dans GET /v1/compliance/activities
  type d'activité : inference_hooks_request_denied (porte le reference_id)
IP source : 160.79.106.0/24 ; services de tunnel (ngrok) bloqués
Indisponible sur Amazon Bedrock et Google Cloud
```

**Compliance API** :

```
GET https://api.anthropic.com/v1/compliance/activities
    scope  : read:compliance_activities
    params : limit, pagination has_more / first_id / last_id
Autres    : /v1/compliance/{chats,files,projects,project attachments,
                            sessions,organizations,users,roles,groups,settings}
            sessions = transcripts Claude Code et Cowork
Auth      : en-tête x-api-key
            Compliance Access Key (claude.ai, tous endpoints)
            vs Admin API key (Console, Activity Feed seulement)
Rate limit: 600 req/min partagé par organisation parente
Objet Activity : id, created_at, organization_id, organization_uuid, type,
                 actor { type: "user_actor", email_address, user_id,
                         ip_address, user_agent }
```

**Annuaire de connecteurs — critères bloquants** :

```
Annotations obligatoires : title + (readOnlyHint: true | destructiveHint: true)
Nom d'outil <= 64 caractères
Un outil ne doit pas mélanger lecture et écriture
  (rejet d'un api_request générique à paramètre `method`)
Descriptions étroites et exactes ; interdiction d'ordonner à Claude
  d'appeler d'autres logiciels, de pointer vers des instructions externes,
  de contenir des instructions cachées ou encodées
Autres surfaces citées : ui/open-link, allowed link URIs,
  `claude plugin validate`
Soumission : https://claude.ai/admin-settings/directory/submissions/new
             (org Team/Enterprise, credentials de test, doc publique ;
              plugins : repo GitHub public) — contact mcp-review@anthropic.com
```

*(Résolu le 2026-08-14 : en-têtes et schéma du corps `prompt` vérifiés sur
`platform.claude.com/docs/en/manage-claude/inference-hooks-endpoint` et reportés ci-dessus.
La doc avertit que « field names, request shapes, and headers may change before general
availability ».)*

## 3. Sources

- https://platform.claude.com/docs/en/manage-claude/inference-hooks
- https://platform.claude.com/docs/en/manage-claude/inference-hooks-endpoint
- https://platform.claude.com/docs/en/manage-claude/inference-hooks-configuration
- https://platform.claude.com/docs/en/manage-claude/compliance-api
- https://platform.claude.com/docs/en/manage-claude/compliance-sessions
- https://platform.claude.com/docs/en/manage-claude/compliance-activity-feed
- https://platform.claude.com/docs/en/api/compliance
- https://claude.com/docs/connectors/building/review-criteria
- https://claude.com/docs/connectors/verification
- https://claude.com/docs/connectors/directory

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

*Inference hooks.* Aujourd'hui `ConflictDetector.detect()` (`src/conflict-detector.ts`) ne s'exécute que quand un agent appelle volontairement un outil MCP : un agent qui n'a pas installé le coordinateur est invisible. Un endpoint inference hook déplace le point de contrôle en amont, côté Anthropic, et couvre toutes les surfaces Claude d'une org sans rien installer sur les postes. Deux usages distincts, du plus prudent au plus intrusif : (a) répondre toujours `allow` et archiver l'événement dans la chaîne d'audit SHA-256 existante (`src/security/audit-chain.ts`) — coût nul en faux positifs ; (b) répondre `deny` avec un `deny_reason` quand le prompt touche un fichier déjà verrouillé par un autre agent, c'est-à-dire une détection de conflit réellement pré-écriture. L'utilisateur qui en profite est la DSI qui a des agents non instrumentés dans le périmètre.

*Compliance API.* L'Activity Feed fournit `actor.email_address`, `actor.user_id`, `actor.ip_address` : de quoi corréler les événements de `src/security/audit.ts` à des identités réelles, ce que le projet ne sait pas faire aujourd'hui (les claims viennent de l'IdP interne, pas de claude.ai).

*Annuaire.* La checklist est directement applicable aux outils de `src/tools/*` : c'est le standard de qualité de facto pour un serveur MCP appelé en boucle.

**Risque si on ne fait rien :**

C'est le volet `threat` de la fiche. Une DSI Enterprise dispose déjà, sans installer quoi que ce soit, d'une piste d'audit horodatée et centralisée des sessions Claude Code — ce qui érode l'argument « tamper-evidence SOC 2 » du projet sur ce segment précis. La réponse défendable existe et doit être écrite quelque part : mcp-coordinator ne journalise pas des transcripts mais des **intentions de coordination** (annonces, conflits, décisions, consultations), donnée que la Compliance API ne produit pas. Si cette distinction n'est pas explicitée dans le positionnement, le projet se fait comparer sur le terrain le moins favorable.

Risque secondaire, immédiat et vérifié : `cli/channel.ts` expose `post_to_thread` sans aucune annotation — donc Claude prompte l'utilisateur à chaque appel, sur un outil dont le rôle est précisément d'être appelé en boucle.

## 5. Points d'intégration dans le repo

Vérifié par lecture et grep sur le repo (2026-08-14).

| Fichier / module | Impact |
|---|---|
| `src/serve-http.ts` | Routeur HTTP par comparaison de `req.url` (`/livez`, `/readyz`, `/healthz`, `/metrics`, `/dashboard`, dispatch Phase 2). Un endpoint `POST /webhooks/anthropic-inference` s'insère là, avant les gates d'auth Phase 1 — c'est une route publique authentifiée par signature, pas par JWT. |
| `src/http/auth-routes.ts` | `dispatchAuthRoutes()` tourne avant les routes Phase 1 : point de référence pour savoir où insérer un dispatcher webhook sans casser l'ordre de routage. |
| `src/conflict-detector.ts` | `ConflictDetector.detect()` (ligne 20) est le verdict à réutiliser pour produire `allow`/`deny`. Sa signature est déjà indépendante de l'auth : `{ org_id, agent_id, target_modules, target_files }`. Le blocage est ailleurs — son unique appelant (`src/tools/consultation-tools.ts:105`, outil `announce_work`) dérive `org_id` de `getSessionClaims`, et le hook ne fournit ni `org_id` interne ni `agent_id`. |
| `src/file-tracker.ts`, `src/working-files-tracker.ts` | Source des verrous fichiers à consulter pour décider un `deny`. Le hook ne fournit qu'un transcript : il faut extraire les chemins, ce qui n'est pas le contrat actuel de ces modules. |
| `src/security/audit-chain.ts` | Chaîne SHA-256 append-only (`computeRowHash`, `GENESIS_HASH`). Cible naturelle pour archiver les verdicts du hook. Note du fichier lui-même : `created_at` n'est pas dans le hash — la Compliance API, elle, horodate côté Anthropic. |
| `src/security/audit-events.ts` | `TIER1_EVENTS` / `TIER2_EVENTS` pilotent la rétention. Des actions `inference_hook.allow` / `inference_hook.deny` doivent y être classées, sinon le sweeper de rétention ne les voit pas. |
| `src/security/audit.ts` | `audit()` avec option `tier` (sync vs `audit-queue.ts`). Un hook à budget 5 s ne peut pas écrire en synchrone : passage obligé par la queue. |
| `src/tools/agents-tools.ts`, `consultation-tools.ts`, `dependencies-tools.ts`, `files-tools.ts`, `mqtt-tools.ts`, `status-tools.ts` | 26 occurrences de `readOnlyHint` au total (4 / 11 / 3 / 3 / 3 / 2), toutes avec `title`. La couverture semble complète ; reste à auditer la règle « ne pas mélanger lecture et écriture » et l'absence d'instructions comportementales dans les `describe()`. |
| `cli/channel.ts` | `ListToolsRequestSchema` retourne `post_to_thread` avec seulement `name` / `description` / `inputSchema` (lignes 340-348) : **aucune annotation**, ni `title`, ni `destructiveHint`. Écart net avec le reste du projet et avec les critères de l'annuaire. |
| `src/auth/` | Aucun code de vérification de signature webhook n'existe (grep `standardwebhooks|webhook` : zéro occurrence hors `node_modules`). Un vérificateur Standard Webhooks serait un module nouveau. |
| `src/metrics.ts`, `src/observability/metrics.ts` | Un hook à budget 5 s impose une métrique de latence dédiée : dépasser le timeout signifie, selon la configuration, bloquer toute l'organisation. |

Ce que le repo ne contient pas et qui serait entièrement à écrire : client `x-api-key` vers `api.anthropic.com`, gestion des Compliance Access Keys, pagination `first_id`/`last_id`, vérification de signature Standard Webhooks.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il devenir un endpoint d'inference hook Anthropic — c'est-à-dire accepter d'être dans le chemin critique de chaque inférence d'une organisation Enterprise, avec un budget de 5 s et un mode `block` en cas de panne — ou bien se limiter à consommer la Compliance API en lecture pour enrichir sa chaîne d'audit, en assumant que la détection de conflit reste opt-in côté agent ?

### 6.2 Hypothèse

**Périmètre confirmé avant de commencer** (leçon d'`E13`, où la question était déjà tranchée ailleurs) : `G05` mentionne la Compliance API et un annuaire, mais son sujet est A2A/AGNTCY et elle est encore ⬜ — aucun recouvrement de décision. E14 est bien propriétaire de la question. Et `#363`, ouverte hier sur `cli/channel.ts`, porte sur le **schéma d'entrée** (`minLength`), **0 mention d'annotations** : l'écart de §4 est distinct.

**Ce que je pense avant de mesurer.** La fiche mélange trois volets d'ampleur très différente, et §6.1 n'en oppose que deux. Mon hypothèse est que le verdict se joue sur un **quatrième** point que §6.1 ne pose pas : le volet annuaire est **le seul** à bénéfice immédiat, il ne dépend d'aucune surface Anthropic, et il corrige une **déviation d'une règle que le projet a lui-même écrite**.

`docs/ARCHITECTURE.md:296` prescrit, étape 3 de la procédure d'ajout d'un outil MCP :

> « Set MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `title`) to match the operation's actual semantics — clients use these as hints. »

Or `cli/channel.ts:343-351` renvoie `post_to_thread` avec `{name, description, inputSchema}` — **sans `annotations`**. Ce n'est donc pas « un critère externe d'Anthropic à adopter » mais **notre propre convention documentée, non respectée dans un fichier**. C'est le cadrage juste, et il rend le volet annuaire trivial plutôt qu'ambitieux.

Sur les inference hooks, mon hypothèse est que le `deny` est **structurellement** infaisable, pas seulement risqué : `ConflictDetector.detect()` exige `{org_id, agent_id, target_modules, target_files}` et le hook ne fournit ni l'`org_id` interne ni l'`agent_id` — il fournit un `tenant_id` Anthropic et un transcript. Le mappage n'existe pas, et rien dans le dépôt ne le construit.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ici, « adopter » se scinde : (A) devenir endpoint d'inference hook, (B) consommer la Compliance API, (C) appliquer la checklist de l'annuaire. Je les adjuge **séparément** — leçon d'`E11`, où un seul seuil décidait de trois changements.

| # | Volet | Critère de mort | Seuil chiffré |
|---|---|---|---|
| **K1** | (A) | **Le budget de 5 s est trop serré.** Si `detect()` plus l'écriture d'audit approche la seconde sur une base réaliste, être dans le chemin critique est intenable. | `detect()` + audit > **500 ms** sur 100 agents / 500 fichiers |
| **K2** | (A) | **Le `deny` est structurellement infaisable.** Si le corps du hook ne fournit pas ce que `detect()` exige, aucun verdict de conflit n'est calculable. | `detect()` exige ≥ **1** champ que le hook ne fournit pas, et rien dans le dépôt ne le dérive |
| **K3** | (A) | **SPOF d'entreprise.** En `failure handling: block`, un redémarrage du coordinateur bloque toutes les inférences de l'org — claude.ai et Cowork inclus. | le mode `block` est documenté et bloque au-delà de Claude Code |
| **K4** | (A) | **Le corps porte le transcript complet.** Archiver ça fait basculer le produit de « journal d'intentions » à « stockage de transcripts », terrain où la Compliance API est déjà meilleure. | le corps contient `messages[]` non tronqué, jusqu'à 10 Mo |
| **K5** | (A)(B) | **Aucune demande, et un segment que le projet ne sert pas.** Enterprise + `organization:manage`, indisponible sur Bedrock et Vertex. | **0** issue ; indisponibilité hors claude.ai confirmée |
| **K6** | (C) | **Le volet annuaire est déjà fait, sauf un écart.** S'il ne reste qu'un outil non conforme, ce n'est pas un chantier mais un correctif. | ≤ **1** outil violant la checklist |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — recevoir un vrai POST Anthropic et appeler la Compliance API sont hors de portée. Les volets (A) et (B) ne peuvent donc **jamais** recevoir `adopter`. Et j'applique les leçons accumulées : vérifier une absence plutôt que la supposer, grepper la doc du dépôt avant de crier à la découverte, et distinguer une **dérive de dépendance** d'un **défaut de vérification** quand une référence de §0 ne tombe plus juste.

### 6.3 Protocole de vérification

<Proposition de la veille, non exécutée.>

> ⚠️ Les points 2, 3 et 4 ne sont pas exécutables sur le poste : recevoir un vrai POST Anthropic exige une org Claude Enterprise, la permission `organization:manage` et un endpoint HTTPS public sur un domaine contrôlé (tunnels ngrok explicitement bloqués) ; `GET /v1/compliance/activities` exige une Compliance Access Key. Les points 1 et 5 sont exécutables en local dès maintenant.

- [ ] Mesurer le temps de bout en bout de `ConflictDetector.detect()` sur une base réaliste (100 agents, 500 fichiers suivis) et le comparer au budget de 5 s, en incluant l'écriture d'audit via `audit-queue.ts`.
- [ ] Écrire un endpoint jetable `POST /webhooks/anthropic-inference` dans `src/serve-http.ts` répondant systématiquement `{"action":"allow"}`, et vérifier qu'un vrai hook Anthropic en mode shadow l'atteint et journalise correctement.
- [ ] Inspecter un corps d'événement `prompt` réel : peut-on en extraire de façon fiable les chemins de fichiers visés, ou le transcript est-il trop peu structuré pour décider un `deny` ?
- [ ] Appeler `GET /v1/compliance/activities` avec une Compliance Access Key et vérifier si un événement de session Claude Code contient assez de contexte pour être corrélé à une ligne d'`audit_log`.
- [ ] Passer les 26 outils de `src/tools/*` à la checklist de l'annuaire (lecture/écriture séparées, descriptions sans instruction comportementale) et corriger `post_to_thread` dans `cli/channel.ts`.

### 6.4 Résultat observé

#### A. Ma mesure de latence était sur la mauvaise branche — et le résultat s'inverse

**Première mesure, à retirer.** Base de 100 agents / 500 fichiers / 30 annonces : `detect()` à **1,42 ms de médiane, 1,91 ms au p95**, soit 0,038 % du budget de 5 s. J'allais en conclure « K1 ne se déclenche pas, la latence n'est pas l'obstacle — contrairement à ce que §6.1 suggère ».

**C'était faux, et sur le mode de faute le plus fréquent de ce corpus : l'instrument n'était pas branché au bon endroit.** Ma base avait un `dependency_map` **vide**. Or `conflict-detector.ts:110` porte un `continue` qui court-circuite tout ce qui suit :

```
src/conflict-detector.ts:65    for (const thread of activeThreads) {
src/conflict-detector.ts:108     for (const targetModule of params.target_modules) {
src/conflict-detector.ts:109       const info = this.depMap.getModuleInfo(...);
src/conflict-detector.ts:110       if (!info) continue;          <- la porte
src/conflict-detector.ts:124       const radius = this.depMap.getBlastRadius(...);
```

Sans carte, `getModuleInfo` renvoie `null` et **`getBlastRadius` n'est jamais appelé**. Remesuré avec une carte peuplée de 200 modules (3 dépendances chacun) :

```
base : 100 agents, 500 fichiers, 30 annonces, carte de 200 modules (3 deps chacun)
  1 module cible   : median  299,5 ms | p95   304,2 ms |  6,08 % du budget de 5 s
  5 modules cibles : median 1498,5 ms | p95  1532,8 ms | 30,66 % du budget de 5 s
```

**K1 se déclenche.** Et §6.1 avait raison de mettre le budget de 5 s en avant — la phrase que j'allais écrire disait exactement l'inverse de la mesure.

**C'est aussi le livrable réel de cette fiche, et il n'a rien à voir avec l'entreprise.** `getBlastRadius` appelle `getMap()` (scan de table complet) à **chaque** appel, sans cache (`dependency-map.ts:176`, `:87-89`), avec un BFS qui re-itère `Object.entries(map)` entier à chaque dequeue — O(V²) (`:189-198`). Le tout dans une boucle **imbriquée** threads × modules. Plus un N+1 sur `checkFileConflict` (`conflict-detector.ts:149-155`) que `file-tracker.ts:83-92` documente et a déjà corrigé pour l'impact scorer via `getFileToAgentsIndex`, sans que `detect()` y soit migré.

Et le coût est **invisible tant que personne n'appelle `set_dependency_map`** — il apparaît d'un coup chez l'utilisateur qui suit la recommandation du `README.md`. → **#366**

#### B. K2 : le `deny` reste infaisable, mais mon motif était faux sur deux points

J'allais écrire « 4 champs sur 4 absents ». La réalité est plus nuancée, et deux de mes affirmations ne tiennent pas :

- **`org_id` est *dérivable*.** La table `users` existe avec `email` et `primary_org_id`, indexée (`src/database.ts:273-285`, colonne renommée `:837`). Aucun code ne fait ce lookup (`grep "WHERE email = ?" src/` → **zéro**), mais « non câblé » n'est pas « structurellement impossible ». **Ce qui tient, c'est que la dérivation serait *infondée* :** l'`UNIQUE` porte sur `(idp_provider, idp_user_id)`, **pas sur `email`** ; et l'email du coordinateur vient de son IdP interne quand `actor.email_address` vient de claude.ai — rien ne garantit la même personne.
- **`target_files` n'est pas « à extraire d'un texte libre ».** §2 liste `tool_use | tool_result` comme blocs **structurés** : un `tool_use` d'`Edit` porte un `input.file_path` exploitable. Mon motif était réfutable. **Le bon argument est l'ordonnancement** : le hook tire *avant* l'inférence N, donc `messages[]` ne peut contenir que des `tool_use` déjà émis **et déjà résolus** aux tours 1..N−1. L'écriture que le modèle est sur le point de demander **n'existe pas encore**. Les chemins extractibles sont donc des fichiers **déjà écrits** — l'inverse d'une détection pré-écriture.
- **`agent_id` : imprenable.** La table `agents` (`src/database.ts:92-99`) n'a ni `email`, ni `user_id`, ni `owner_id` (`grep "owner_id" src/` → zéro), ni lien vers une session.

**K2 se déclenche donc, reformulé : 3 champs sur 4 sans dérivation possible, 1 dérivable mais infondé.**

#### C. K6 ne se déclenche pas — « 26/26 conformes » est faux, et il y a deux écarts, pas un

Ma première mesure opérationnalisait le critère en « la **clé** est-elle présente ? » → 0 échec. Mais §2 l'énonce en « `title` + (`readOnlyHint: true` **|** `destructiveHint: true`) », c'est-à-dire sur la **valeur**. Recompté par appariement d'accolades :

```
outils avec readOnlyHint:true OU destructiveHint:true : 16/26
outils avec NI l'un NI l'autre : 10
  register_agent, heartbeat, announce_work, post_to_thread, propose_resolution,
  approve_resolution, contest_resolution, log_action_summary, wait_for_message, mqtt_publish
```

**Je n'avais pas dit laquelle des deux lectures j'appliquais** — faute de méthode. Sous la lecture stricte, **10 outils sur 26** échouent, et le seuil de K6 (« ≤ 1 outil violant ») ne se déclenche pas.

**Et le second écart concret n'est pas celui que la fiche nomme.** `wait_for_message` (`src/tools/mqtt-tools.ts:68`) porte `{ readOnlyHint: false, idempotentHint: false, title }` — **ni `readOnlyHint: true`, ni `destructiveHint`** — alors qu'il **consomme** ce qu'il retourne (`src/mqtt-bridge.ts:430`, `listener.queue.shift()`). Son voisin `get_queued_messages` est correctement annoté `destructiveHint: true`.

Incohérence relevée au passage : `approve_resolution` et `contest_resolution` sont `destructiveHint: false` alors qu'ils font la même transition `status='resolved'` qui rend `close_thread` `destructiveHint: true`.

Sur « ne pas mélanger lecture et écriture » : `announce_work` écrit bel et bien (`UPDATE threads SET conflicts`, `INSERT INTO layer_firings`, heartbeat, publish MQTT) tout en renvoyant thread + conflicts + context + impact. **Mais le contre-exemple de l'annuaire est un `api_request` polymorphe** à paramètre `method` — un outil dont la *nature* dépend de l'argument. Aucun outil ici n'est dans ce cas, donc le critère strict n'est probablement pas violé. Je le dis explicitement plutôt que d'affirmer une conformité en bloc.

**Chevauchement à vérifier avant tout correctif :** **#236** (ouverte) traite `get_queued_messages` drain-without-ack et propose une consommation à ack avec un `peek` **non destructif**. Si elle atterrit, la sémantique destructive des deux outils MQTT change — donc leurs annotations aussi.

#### D. Une erreur factuelle de §4, et une bonne nouvelle sur §0

**§4 ligne 149 est fausse.** Elle dit que la Compliance API permettrait « de corréler les événements de `src/security/audit.ts` à des identités réelles, **ce que le projet ne sait pas faire aujourd'hui** ». Le projet **sait** le faire : `withAuditContext` existe (`src/auth/audit-context.ts:29-35`) et `audit()` dérive déjà les quatre colonnes d'acteur (`src/security/audit.ts:105-112`). Ce qui manque, c'est l'**invocation** — `src/serve-http.ts:530` n'enveloppe que `withRequestId`. C'est exactement l'issue **#319**. Donc la Compliance API n'est pas un remède mais un détour : l'identité qu'elle renvoie est une identité **claude.ai**, pas un `users.id` du coordinateur. **Argument de plus pour refuser (B), pas contre.**

**Et pour la première fois de la série `E08`–`E14`, §0 et §5 sont exempts de défaut de vérification.** Les trois écarts apparents sont de la **dérive de dépendance**, imputable à deux commits du 2026-08-15, un jour après la vérification :

| §5 dit | HEAD | Cause |
|---|---|---|
| `detect()` « ligne 20 » | **43** | `7e76cfe` (#300/#302) a préfixé un commentaire de 23 lignes. À `7d0224d`, `detect(params` est bien en **20** |
| `cli/channel.ts` « lignes 340-348 » | **343-351** | `4f62056` (#291, migration `@modelcontextprotocol/*@2`) a remplacé `ListToolsRequestSchema` par la chaîne `"tools/list"`. À `7d0224d`, le bloc est bien en **340-348** |
| `consultation-tools.ts:105` | **exact** | — |
| « 26 `readOnlyHint` (4/11/3/3/3/2) » | **exact** | recompté par fichier |

C'est la rupture de la série, et elle mérite d'être écrite : confondre une dérive de dépendance avec un défaut de vérification serait refaire la sur-affirmation d'`E12`.

#### E. Adjudication des six critères

| # | Volet | Seuil | Mesure | Verdict |
|---|---|---|---|---|
| **K1** | (A) | `detect()` + audit > 500 ms | **1 533 ms au p95** à 5 modules cibles sur une carte de 200 modules (et 304 ms à 1 module) | **SE DÉCLENCHE** — ma première mesure (1,9 ms) était sur la branche courte, `dependency_map` vide |
| **K2** | (A) | ≥ 1 champ non fourni | **3 sur 4 sans dérivation** (`agent_id`, `target_modules`, `target_files` en pré-écriture) ; `org_id` dérivable mais **infondé** | **SE DÉCLENCHE**, reformulé |
| **K3** | (A) | mode `block` documenté | confirmé — **mais §2 documente un circuit breaker** : le SPOF réel est la fenêtre avant son déclenchement, pas un blocage indéfini | **SE DÉCLENCHE, atténué** |
| **K4** | (A) | corps = `messages[]` non tronqué, 10 Mo | confirmé — **mais c'est un critère faible** : c'est une propriété de l'entrée d'Anthropic, il se déclenche quel que soit notre design, et rien n'oblige à persister le transcript (un hash + métadonnées suffirait). Il ne discrimine rien | **SE DÉCLENCHE sans rien trancher** |
| **K5** | (A)(B) | 0 issue ; indisponible hors claude.ai | `gh issue list --search "inference hook"` → **vide** ; `"compliance"` → **vide** ; Bedrock et Vertex exclus | **SE DÉCLENCHE** |
| **K6** | (C) | ≤ 1 outil violant | **10 sur 26** sous la lecture stricte du critère (« valeur = true »), et **2** écarts concrets (`cli/channel.ts`, `mqtt-tools.ts:68`) | **NE SE DÉCLENCHE PAS** |

**Cinq critères sur six se déclenchent, dont deux avec une réserve explicite (K3 atténué, K4 non discriminant), et K6 tombe.**

### 6.5 Contre-arguments

- **Dépendance à une beta réservée à Claude Enterprise.** Les inference hooks exigent la permission `organization:manage` dans claude.ai et sont indisponibles sur Bedrock et Vertex. Aucun auto-hébergeur, aucun utilisateur Pro/Max, aucun client Bedrock ne peut s'en servir. Le projet investirait dans un segment qu'il ne sert pas aujourd'hui.
- **Être dans le chemin critique est un engagement de disponibilité que le projet ne peut pas tenir.** Avec `failure handling: block`, un mcp-coordinator qui redémarre bloque toutes les inférences de l'organisation, y compris claude.ai et Cowork — pas seulement Claude Code. Un coordinateur d'agents solo devenu SPOF d'entreprise, c'est un changement de nature du produit, pas une feature.
- **Vie privée.** Le corps du hook contient le transcript complet de conversation. Journaliser cela dans la chaîne d'audit fait basculer mcp-coordinator de « journal d'intentions de coordination » — son argument différenciant — à « stockage de transcripts », c'est-à-dire exactement la case où la Compliance API est déjà meilleure et déjà là.
- **Le `deny` est probablement infaisable de façon fiable.** Décider qu'un prompt va toucher un fichier verrouillé suppose d'extraire des chemins d'un texte libre avant toute exécution d'outil. Un faux positif bloque un utilisateur sans recours ; un faux négatif rend le mécanisme inutile. Le mode `allow` + audit est la seule variante défendable, et il n'apporte alors aucune capacité de coordination nouvelle.
- **YAGNI.** Ni la Compliance API ni les inference hooks ne sont demandés par un utilisateur actuel du projet. Le seul élément à bénéfice immédiat et à coût quasi nul est la checklist de l'annuaire — et sur 26 outils, elle est déjà largement respectée : le seul écart trouvé est `post_to_thread` dans `cli/channel.ts`.
- **Contradiction interne au bundle.** Le chercheur qui a produit la fiche Compliance API la classe `threat` (elle érode l'argument SOC 2), celui qui a produit la fiche inference hooks la classe `opportunity` (elle donne une prise sur les agents non instrumentés). Les deux lectures sont défendables et portent sur la même dépendance à Claude Enterprise ; la fiche ne tranche pas.
- **Portabilité.** Tout ce volet est spécifiquement Anthropic. Le projet est un serveur MCP, protocole ouvert ; se rendre dépendant d'un webhook propriétaire d'un fournisseur pour sa fonction de détection de conflit va à l'encontre de ce positionnement.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | Trois volets, adjugés séparément — leçon d'`E11`, où un seul seuil décidait de plusieurs changements. ⭑ **Refusé — (A) devenir endpoint d'inference hook.** **K1 se déclenche** : `detect()` prend **1 533 ms au p95** à cinq modules cibles sur une carte de 200 modules, soit 31 % du budget de 5 s. **K2 se déclenche** : sur les quatre champs que `detect()` exige, **trois n'ont aucune dérivation** (`agent_id` — la table `agents` n'a ni email ni `user_id` ni `owner_id` ; `target_modules` ; `target_files`, dont les seuls chemins extractibles sont ceux **déjà écrits**, puisque le hook tire *avant* l'inférence), et le quatrième (`org_id`) est dérivable via `users.email` mais **infondé** — l'`UNIQUE` porte sur `(idp_provider, idp_user_id)`, pas sur l'email, et l'identité vient d'un IdP différent de celui de claude.ai. Plus **K5** : Enterprise seulement, indisponible sur Bedrock et Vertex, zéro issue. ⭑ **Refusé — (B) consommer la Compliance API.** Non exécutable ici, zéro demande, et surtout : **§4 ligne 149 est factuellement fausse**. Elle dit que corréler l'audit à des identités réelles est « ce que le projet ne sait pas faire aujourd'hui » ; il **sait** le faire — `withAuditContext` existe et `audit()` dérive déjà les quatre colonnes d'acteur. Ce qui manque est l'**invocation** (`serve-http.ts:530` n'enveloppe que `withRequestId`), c'est-à-dire **#319**. La Compliance API n'est donc pas un remède mais un détour : elle renvoie une identité claude.ai, pas un `users.id` du coordinateur. ⭑ **Adopté — (C) la checklist de l'annuaire**, mais **pas comme la fiche la présente**. Ce n'est pas un critère externe à importer : `docs/ARCHITECTURE.md:296` prescrit déjà « Set MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `title`) to match the operation's actual semantics ». Les écarts sont donc des déviations d'une **règle que le projet a lui-même écrite**. **Corrections de méthode.** **Ma mesure de latence était sur la mauvaise branche** : `dependency_map` vide → `getModuleInfo` renvoie `null` → le `continue` de `conflict-detector.ts:110` saute `getBlastRadius`, et `detect()` mesure 1,9 ms au lieu de 1 533 ms. J'allais publier « la latence n'est pas l'obstacle » — l'inverse exact de la mesure, et la cinquième occurrence dans ce corpus de la faute « l'instrument n'était pas branché au bon endroit ». **K6 ne se déclenche pas** : j'avais opérationnalisé le critère en « la **clé** est-elle présente ? » (0 échec) alors que §2 l'énonce sur la **valeur** — **10 outils sur 26** échouent, et il y a **deux** écarts concrets, pas un : `cli/channel.ts:343-351` et `wait_for_message` (`mqtt-tools.ts:68`), qui n'a ni `readOnlyHint: true` ni `destructiveHint` alors qu'il **consomme** ce qu'il retourne. **Deux de mes motifs sur K2 étaient réfutables** (l'`org_id` est dérivable, et `target_files` vient de blocs `tool_use` **structurés**, pas d'un texte libre) : remplacés par l'argument d'ordonnancement. **K3 est atténué** (§2 documente un circuit breaker) et **K4 ne discrimine rien** (c'est une propriété de l'entrée d'Anthropic, et rien n'oblige à persister le transcript). ⭑ **Et une bonne nouvelle à écrire noir sur blanc** : pour la première fois de la série `E08`–`E14`, **§0 et §5 sont exempts de défaut de vérification**. Les trois écarts de lignes sont de la **dérive de dépendance**, imputable à `7e76cfe` et `4f62056`, tous deux du 2026-08-15 — un jour après la vérification. |
| **Issue / PR** | **#366** — `ConflictDetector.detect()` prend **1,5 s** sur le chemin chaud d'`announce_work` : `getBlastRadius` rescanne toute la table à chaque appel sans cache, avec un BFS O(V²), dans une boucle imbriquée threads × modules ; plus un N+1 sur `checkFileConflict` que `file-tracker.ts:83-92` a déjà corrigé pour l'impact scorer. **Le coût est invisible tant que `set_dependency_map` n'est pas appelé.** Volet (C) : deux écarts d'annotation à corriger — mais **vérifier #236 d'abord**, qui propose un `peek` non destructif et changerait la sémantique des deux outils MQTT. |
| **Jalon visé** | **#366 avant la prochaine mineure** — c'est le chemin le plus chaud du serveur, et le défaut se révèle précisément chez l'utilisateur qui suit la recommandation du `README.md` de renseigner la carte de dépendances. Les annotations sont de l'hygiène, derrière #236. Aucun jalon pour (A) ni (B) : le premier est infaisable, le second est un détour autour de **#319**. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : schéma webhook tranché, verdict et Activity corrigés, §5 confirmé, testabilité partielle. |
| 2026-08-17 | **Challenge — verdict `adopter partiellement` ; le livrable est une mesure de latence sans rapport avec l'entreprise.** **Ma mesure de K1 était sur la mauvaise branche.** Base à `dependency_map` **vide** → `getModuleInfo` renvoie `null` → le `continue` de `conflict-detector.ts:110` saute `getBlastRadius`, et `detect()` mesure **1,42 ms**. J'allais publier « K1 ne se déclenche pas, la latence n'est pas l'obstacle ». Remesuré avec une carte de **200 modules** : **304 ms au p95 à 1 module cible, 1 533 ms à 5** — soit **31 % du budget de 5 s**. **K1 se déclenche**, et §6.1 avait raison de mettre le budget en avant : la phrase que j'allais écrire disait l'inverse exact de la mesure. Cinquième occurrence dans ce corpus de la faute « l'instrument n'était pas branché au bon endroit ». **Et c'est le livrable réel** : `getBlastRadius` rescanne toute la table à chaque appel sans cache (`dependency-map.ts:176`, `:87-89`), avec un BFS O(V²) (`:189-198`), dans une boucle **imbriquée** threads × modules — plus un N+1 sur `checkFileConflict` que `file-tracker.ts:83-92` documente et a déjà corrigé pour l'impact scorer. **Le coût est invisible tant que `set_dependency_map` n'est pas appelé** → **#366**. **Refusé (A)** : K2 se déclenche, reformulé — **3 champs sur 4 sans dérivation** (`agent_id` : la table `agents` n'a ni email ni `user_id` ni `owner_id` ; `target_modules` ; `target_files`, dont les seuls chemins extractibles sont ceux **déjà écrits**, le hook tirant *avant* l'inférence), le 4ᵉ (`org_id`) dérivable via `users.email` mais **infondé** (`UNIQUE` sur `(idp_provider, idp_user_id)`, pas sur l'email ; IdP distinct de claude.ai). **Deux de mes motifs étaient réfutables** et je les remplace : l'`org_id` n'est pas « absent » mais dérivable-sans-fondement, et `target_files` ne vient pas d'un « texte libre » mais de blocs `tool_use` **structurés** — le bon argument est l'ordonnancement. **Refusé (B)** : et **§4 ligne 149 est fausse** — corréler l'audit à des identités réelles n'est pas « ce que le projet ne sait pas faire », il **sait** le faire (`withAuditContext` existe, `audit()` dérive les quatre colonnes) ; ce qui manque est l'**invocation**, c'est-à-dire **#319**. La Compliance API est donc un détour, pas un remède : elle rend une identité claude.ai, pas un `users.id`. **Adopté (C)** mais recadré : ce n'est pas un critère externe, `docs/ARCHITECTURE.md:296` prescrit déjà les annotations — les écarts sont des déviations de **notre** règle. **K6 ne se déclenche pas** : j'avais lu le critère sur la **clé** (0 échec) au lieu de la **valeur** — **10 outils sur 26** échouent, et il y a **deux** écarts concrets, pas un : `cli/channel.ts:343-351` et `wait_for_message` (`mqtt-tools.ts:68`), sans `readOnlyHint: true` ni `destructiveHint` alors qu'il **consomme** ce qu'il rend (`mqtt-bridge.ts:430`). Chevauchement à traiter d'abord : **#236** propose un `peek` non destructif. **K3 atténué** (§2 documente un circuit breaker), **K4 ne discrimine rien** (propriété de l'entrée d'Anthropic ; rien n'oblige à persister le transcript). **Et pour la première fois de la série `E08`–`E14`, §0 et §5 sont exempts de défaut de vérification** : les trois écarts de lignes sont de la **dérive de dépendance** (`7e76cfe` et `4f62056`, tous deux du 2026-08-15, un jour après). |
