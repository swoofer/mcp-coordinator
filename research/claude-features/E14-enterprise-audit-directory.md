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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille, non exécutée.>

> ⚠️ Les points 2, 3 et 4 ne sont pas exécutables sur le poste : recevoir un vrai POST Anthropic exige une org Claude Enterprise, la permission `organization:manage` et un endpoint HTTPS public sur un domaine contrôlé (tunnels ngrok explicitement bloqués) ; `GET /v1/compliance/activities` exige une Compliance Access Key. Les points 1 et 5 sont exécutables en local dès maintenant.

- [ ] Mesurer le temps de bout en bout de `ConflictDetector.detect()` sur une base réaliste (100 agents, 500 fichiers suivis) et le comparer au budget de 5 s, en incluant l'écriture d'audit via `audit-queue.ts`.
- [ ] Écrire un endpoint jetable `POST /webhooks/anthropic-inference` dans `src/serve-http.ts` répondant systématiquement `{"action":"allow"}`, et vérifier qu'un vrai hook Anthropic en mode shadow l'atteint et journalise correctement.
- [ ] Inspecter un corps d'événement `prompt` réel : peut-on en extraire de façon fiable les chemins de fichiers visés, ou le transcript est-il trop peu structuré pour décider un `deny` ?
- [ ] Appeler `GET /v1/compliance/activities` avec une Compliance Access Key et vérifier si un événement de session Claude Code contient assez de contexte pour être corrélé à une ligne d'`audit_log`.
- [ ] Passer les 26 outils de `src/tools/*` à la checklist de l'annuaire (lecture/écriture séparées, descriptions sans instruction comportementale) et corriger `post_to_thread` dans `cli/channel.ts`.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : schéma webhook tranché, verdict et Activity corrigés, §5 confirmé, testabilité partielle. |
