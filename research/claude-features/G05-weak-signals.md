# G05 — Signaux faibles : A2A/AGNTCY et Claude Cowork

> **Fiche de veille.** Sections 1 à 5 remplies par la veille. Sections 6 à 8 remplies
> **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `weak-signals` |
| **Surface** | ecosystem (A2A/AGNTCY) · other (Claude Cowork) |
| **Statut** | GA — A2A spec v1.0.0 (première version stable, mars 2026) ; Cowork **beta** (plans payants Pro/Max/Team/Enterprise, disponibilité variable par surface ; sessions cloud « in beta ») |
| **Disponible depuis** | A2A : annonce Google 09/04/2025, donation Linux Foundation 23/06/2025, v1.0.0 mars 2026 · AGNTCY : donation Cisco/Outshift 29/07/2025 · Cowork : plugins 30/01/2026, extension 24/02/2026 |
| **Tier** | T3-à-surveiller |
| **Nature** | opportunity |
| **Effort estimé** | XL (A2A) · L (Cowork) |
| **Confiance veille** | low (A2A) · medium (Cowork) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — Cowork exige compte payant + connecteur org |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser la migration d'identité, reporter la carte du daemon et Cowork |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2 — noms de méthodes A2A faux.** La fiche listait un binding JSON-RPC en slash-form
  (`message/send`, `message/sendStreaming`, `tasks/subscribe`, `taskPushNotificationConfigs/create|get|list|delete`,
  `agentCard/getExtended`). En v1.0.0 les opérations ont été **renommées** : les noms de méthode JSON-RPC
  sont les noms PascalCase (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
  `SubscribeToTask`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`,
  `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`, `GetExtendedAgentCard`).
  Deux des noms cités n'ont d'ailleurs jamais existé sous cette forme : `message/sendStreaming`
  (v0.x : `message/stream`) et `tasks/subscribe` (v0.x : `tasks/resubscribe`). Liste réécrite.
- **§2 — SDK officiels.** Ajout de **Rust** (Python, Go, Java, JavaScript, .NET, Rust).
- **En-tête — statut Cowork.** « Cowork GA » → **beta**. La doc support dit « Cowork runs your tasks in
  the cloud (in beta) » et « available on paid plans (Pro, Max, Team, Enterprise), availability varies
  by surface ». A2A v1.0.0 reste bien la première version stable.
- **§2 — marqueur `(à vérifier)` tranché** (voir ci-dessous) : la question centrale « un plugin Cowork
  peut-il déclarer un serveur MCP distant ? » est **résolue par la doc**.
- **§2 — endpoints Analytics.** `cowork_metrics` est un champ de `/v1/organizations/analytics/users`,
  pas de `/summaries` ; `/summaries` porte `cowork_daily|weekly|monthly_active_user_count`. Annotation corrigée.
- **§4 / §5 — noms A2A alignés** sur la nomenclature v1.0.0 (mêmes renommages qu'en §2).

**Points confirmés sans changement :**

- `GET /.well-known/agent-card.json` est bien le chemin de découverte v1.0.0.
- `Message.role` = `ROLE_USER` / `ROLE_AGENT` ; `Part` = `text` | `data` | `url` | `raw` ;
  Agent Card signées via JWS ; 3 bindings (JSON-RPC 2.0 + SSE, gRPC, HTTP+JSON).
- **§5 intégralement vérifié par lecture directe** : les 21 fichiers cités existent tous.
  `src/serve-http.ts:695` route bien `/.well-known/oauth-authorization-server` sous `ctx.phase2Bootstrap`
  et appelle `handleDiscovery()` (l. 700) ; `/metrics/auth` est bien l. 719.
  `src/discovery.ts` expose bien `buildDiscoveryDoc()` (l. 12) + `handleDiscovery()` (l. 40) pour RFC 8414.
  `src/types.ts:5-13` : `Agent` = `id`, `org_id`, `name`, `modules` (string JSON), `status`,
  `registered_at`, `last_seen_at`. `src/agent-registry.ts` : `register/get/listOnline/listAll/setOnline/
  setOffline/heartbeat` (l. 33/72/91/104/111/118/125) ; commentaire issue #231 l. 47 ;
  `CREATE UNIQUE INDEX idx_agents_id ON agents(id)` dans `src/database.ts:593`.
  `src/tools/agents-tools.ts` : bien 4 outils (`register_agent`, `list_agents`, `heartbeat`,
  `agent_activity`). `src/register-workflow.ts:25` : `runRegisterFlow`, partagé avec REST `/api/register`
  (`src/http/handle-rest.ts:64`). `sdk/src/discovery.ts:6` : `DISCOVERY_PATH =
  "/.well-known/oauth-authorization-server"` + `DiscoveryCache` (l. 44). Tailles citées exactes
  (`consultation.ts` 26,6 Ko ; `openapi.yaml` 43,8 Ko).

**Marqueurs `(à vérifier)` restants :** aucun. Le marqueur unique de §2 est tranché :

- Manifeste de plugin : `plugin.json` + `version.json` + `.mcp.json` + `agents/` + `commands/` + `skills/`.
- Le `.mcp.json` d'un plugin **déclare bien les serveurs MCP embarqués**, au format du schéma
  `managedMcpServers`, dont chaque entrée exige un nom unique et une **URL HTTPS**. Les connecteurs
  personnalisés via remote MCP sont explicitement supportés « on Claude, Cowork, and Claude Desktop ».
  → **Oui, un plugin Cowork peut pointer sur un daemon mcp-coordinator distant**, sous deux contraintes
  documentées : serveur joignable depuis l'internet public et **allowlist des plages d'IP Anthropic**,
  et ajout du connecteur par un Owner/Primary Owner en Team/Enterprise.
- La forme exacte des chemins `/v1/compliance/*` propres à Cowork : ce sont les **endpoints de sessions**
  génériques (Cowork *et* Claude Code, locales et distantes), pas des chemins `cowork`-spécifiques ;
  ils exigent une **Compliance Access Key** (l'Admin API key ne donne accès qu'à `/v1/compliance/activities`).

**Testabilité :** ⚠️ partielle
Le volet A2A est entièrement testable en local : servir un `/.well-known/agent-card.json` statique dans
`src/serve-http.ts` sur le modèle de `handleDiscovery()`, puis l'interroger avec le SDK A2A JS officiel
(`pnpm add` + script Node 22), et faire à la main le mapping `consultation.ts` → `Task`/`Message`/`Part`
et la comparaison d'événements avec `sse-emitter.ts`/`mqtt-bridge.ts`.
Le volet Cowork ne l'est pas : installer un plugin déclarant le daemon comme MCP distant exige un compte
Cowork payant, un ajout de connecteur par un Owner d'org Team/Enterprise, et un daemon exposé en HTTPS
public avec les IP Anthropic en allowlist. Les champs `cowork_*` de l'Analytics API et les sessions de la
Compliance API exigent en plus une Compliance Access Key Enterprise.

---

## 1. Ce que c'est

Deux signaux distincts, regroupés parce qu'aucun n'est actionnable seul aujourd'hui, mais que les deux
attaquent la même hypothèse implicite du projet : « coordonner des agents = coordonner des processus qui
éditent le même dépôt git ».

**A2A (Agent2Agent)** est un standard ouvert de communication agent-à-agent, lancé par Google en avril
2025, transféré à la Linux Foundation en juin 2025, stabilisé en v1.0.0 en mars 2026. Il est explicitement
positionné comme complémentaire de MCP : MCP relie un agent à des outils, A2A relie des agents entre eux.
Un agent A2A publie une *Agent Card* JSON sur une URL bien connue, décrivant ses `AgentSkill`, et accepte
des `Task` envoyées par d'autres agents via trois bindings (JSON-RPC 2.0 + SSE, gRPC, HTTP+JSON). La v1.0
ajoute les Agent Cards signées (JWS). **AGNTCY**, donné à la Linux Foundation par Cisco en juillet 2025,
empile sur A2A un annuaire (Directory, qui référence aussi des serveurs MCP), une identité vérifiable
(Identity), un bus (SLIM Messaging) et de l'observabilité.

**Claude Cowork** est le second angle mort : c'est un hôte MCP à part entière, non-développeur, où
plusieurs agents travaillent en parallèle pour un même utilisateur ou une même équipe. Ses plugins
empaquettent skills, slash commands, connecteurs MCP et sous-agents en un artefact installable ; ses
sessions (locales et distantes) sont récupérables via la Compliance API ; ses métriques apparaissent dans
l'API Enterprise Analytics ; il est gouverné par les mêmes Inference hooks que Claude Code. C'est le même
problème de coordination que celui du projet, mais où l'unité de conflit n'est plus un fichier source.

## 2. Surface d'API exacte

### A2A v1.0.0

```
GET /.well-known/agent-card.json      # découverte (l'ancien /.well-known/agent.json des v0.x est obsolète)
```

Objets cœur (définis en Protocol Buffers, publiés en JSON Schema 2020-12) :
`AgentCard`, `AgentSkill`, `Task`, `Message`, `Part` (`text` | `data` | `url` | `raw`), `Artifact`,
`Extension`. `Message.role` = `ROLE_USER` / `ROLE_AGENT` en ProtoJSON v1.0.
Agent Cards signées : JWS (RFC 7515).

11 méthodes cœur. **En v1.0.0 les opérations ont été renommées** : le binding JSON-RPC 2.0 utilise
directement les noms d'opération, et non plus la slash-form des v0.x.

```
SendMessage                          # v0.x : message/send
SendStreamingMessage                 # v0.x : message/stream
GetTask                              # v0.x : tasks/get
ListTasks                            # v0.x : tasks/list
CancelTask                           # v0.x : tasks/cancel
SubscribeToTask                      # v0.x : tasks/resubscribe
CreateTaskPushNotificationConfig
GetTaskPushNotificationConfig
ListTaskPushNotificationConfigs
DeleteTaskPushNotificationConfig
GetExtendedAgentCard                 # v0.x : agent/getAuthenticatedExtendedCard
```

Les webhooks push utilisent HTTP + les payloads JSON du binding HTTP, quel que soit le binding
principal. SDK officiels : Python, Go, Java, JavaScript, .NET, **Rust**.

AGNTCY : composants `Directory` (annuaire d'agents A2A **et** de serveurs MCP), `Identity`,
`SLIM Messaging` (Secure Low-latency Interactive Messaging), `Observability`.

### Claude Cowork

```
GET /v1/compliance/*                       # endpoints « sessions » : transcripts Cowork ET Claude Code,
                                           #   locales (poste utilisateur) et distantes (cloud Anthropic).
                                           #   Pas de chemin cowork-spécifique. Compliance Access Key requise
                                           #   (l'Admin API key ne couvre que /v1/compliance/activities).
GET /v1/organizations/analytics/users      # champ cowork_metrics (objet : connectors_used_count,
                                           #   distinct_connectors_used_count, distinct_session_count, …)
GET /v1/organizations/analytics/summaries  # champs cowork_daily|weekly|monthly_active_user_count
```

Plugin Cowork — structure du bundle : `plugin.json` (métadonnées) + `version.json` + `.mcp.json`
(serveurs MCP embarqués, au format du schéma `managedMcpServers` : nom unique + **URL HTTPS**) +
`agents/` + `commands/` + `skills/`.
**Question tranchée le 2026-08-14 :** oui, un plugin Cowork peut déclarer un serveur MCP **distant** ;
les connecteurs personnalisés via remote MCP sont supportés sur Claude, Cowork et Claude Desktop.
Contraintes documentées : le serveur doit être joignable depuis l'internet public avec les **plages
d'IP Anthropic en allowlist** (rien derrière VPN ou pare-feu d'entreprise), et en Team/Enterprise
l'ajout du connecteur passe par un Owner / Primary Owner dans Organization settings > Connectors.

Plus : journalisation OpenTelemetry Cowork, gouvernance par Inference hooks (beta).

### Divergences entre sources (non arbitrées)

- Le communiqué Linux Foundation du 09/04/2026 annonce « plus de 150 organisations » et 22 000+ étoiles
  GitHub ; le billet Google Open Source du 16/04/2026 parle de « plus de 100 entreprises ». Les deux
  coexistent ; la fiche retient le chiffre LF sans trancher.
- Le projet A2A ne dit pas « GA » mais « first stable, production-ready version ». Équivalence retenue
  par commodité.

## 3. Sources

- https://a2a-protocol.org/v1.0.0/
- https://a2a-protocol.org/v1.0.0/specification/
- https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html
- https://platform.claude.com/docs/en/manage-claude/compliance-api
- https://platform.claude.com/docs/en/api/admin/analytics
- https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry
- https://platform.claude.com/docs/en/manage-claude/inference-hooks

Ajoutées lors de la vérification du 2026-08-14 :

- https://a2a-protocol.org/latest/whats-new-v1/ (renommage des opérations en v1.0)
- https://code.claude.com/docs/en/plugins-reference (structure du bundle, `.mcp.json` / `managedMcpServers`)
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview (statut beta)
- https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

*A2A.* Le projet revendique déjà le cross-vendeur (Claude Code, Cursor, Cline, Aider) : c'est littéralement
la thèse d'A2A appliquée au codage sur un dépôt. Aujourd'hui un agent enregistré est une ligne SQLite
(`src/types.ts`, interface `Agent` : `id`, `org_id`, `name`, `modules`, `status`, timestamps) — un
identifiant opaque, sans URL, sans capacités déclarées, sans identité vérifiable. Exposer chaque agent (ou
le daemon lui-même) comme un pair A2A avec une Agent Card signée transformerait `modules: string[]` en
`AgentSkill[]` adressables, donnerait un vocabulaire standard aux consultations (`Task` + `Message` +
`Artifact` là où `src/consultation.ts` a son propre modèle de threads), et le
`*TaskPushNotificationConfig` d'A2A recouvre exactement ce que `src/sse-emitter.ts` et `src/mqtt-bridge.ts` font déjà en propriétaire.
Bénéficiaire : le déploiement d'entreprise où A2A est déjà en place et où « encore un serveur MCP maison »
ne passe pas la revue d'architecture. Aucun code ne *disparaîtrait* à court terme — ce serait une surface
supplémentaire, pas un remplacement.

*Cowork.* Marché adjacent entier où la coordination multi-agents existe sans dépôt git : plusieurs sessions
Cowork touchant les mêmes documents, connecteurs ou projets. Le modèle conceptuel du projet — annoncer,
voir les autres, détecter le conflit avant l'écriture — s'y transpose, mais `src/file-tracker.ts`,
`src/conflict-detector.ts` et `src/dependency-map.ts` supposent tous un chemin repo-relatif comme unité de
conflit. La transposition n'est pas gratuite. À qualifier avant d'investir un euro d'effort.

**Risque si on ne fait rien :** faible à court terme. A2A cible l'entreprise et le cross-vendeur, pas les
agents de codage sur un dépôt local ; rien n'indique que Claude Code parle A2A. Le risque réel est de
positionnement à 18 mois : si l'annuaire AGNTCY Directory devient le point d'entrée par lequel on découvre
agents et serveurs MCP, un daemon qui n'y publie rien devient invisible.

## 5. Points d'intégration dans le repo

Chemins vérifiés par lecture directe.

| Fichier / module | Impact |
|---|---|
| `src/types.ts` | Interface `Agent` (`id`, `org_id`, `name`, `modules` JSON, `status`, `registered_at`, `last_seen_at`). C'est le modèle d'identité à confronter à `AgentCard` : ni URL, ni endpoint, ni clé, ni capacités typées. Point de décision central. |
| `src/agent-registry.ts` | `AgentRegistry.register/get/listOnline/listAll/setOnline/setOffline/heartbeat`. `agents.id` est **globalement unique** (index `idx_agents_id`, voir le commentaire issue #231) — un identifiant A2A serait une URL, ce qui change la nature de la contrainte d'unicité. |
| `src/tools/agents-tools.ts` | 4 outils MCP (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`). `modules: z.array(z.string())` serait la source d'un futur `AgentSkill[]`. |
| `src/register-workflow.ts` | `runRegisterFlow` — chemin partagé MCP + REST `/api/register`. Seul endroit à toucher pour publier/signer une Agent Card à l'enregistrement. |
| `src/discovery.ts` | Déjà un document de découverte bien connu : `buildDiscoveryDoc()` + `handleDiscovery()` pour RFC 8414. Modèle exact à réutiliser pour servir `/.well-known/agent-card.json`. |
| `src/serve-http.ts` | Ligne ~695 : routage de `/.well-known/oauth-authorization-server` (conditionné par `ctx.phase2Bootstrap`). C'est là qu'une route `/.well-known/agent-card.json` s'ajouterait. |
| `src/consultation.ts` | Modèle de threads/messages propriétaire (26 Ko). À confronter à `Task` / `Message` / `Part` / `Artifact` d'A2A : soit mapping, soit divergence assumée. |
| `src/sse-emitter.ts`, `src/mqtt-bridge.ts`, `src/mqtt-broker.ts` | Push propriétaire. Recouvrement direct avec `SubscribeToTask` (SSE) et `*TaskPushNotificationConfig` (webhooks) d'A2A. |
| `src/file-tracker.ts`, `src/conflict-detector.ts`, `src/dependency-map.ts` | Unité de conflit = chemin repo-relatif. C'est ce qui bloque la transposition vers Cowork (documents, connecteurs, projets), pas le protocole. |
| `src/http/rest-handlers.ts`, `docs/openapi.yaml` | Surface REST existante. Un binding HTTP+JSON A2A serait un troisième contrat à maintenir en parallèle du REST maison et de MCP. |
| `src/observability/metrics.ts` | Registry Prometheus Phase 2 servi sur `/metrics/auth` (Phase 1 sur `/metrics`). Aucune sortie OpenTelemetry : la corrélation avec la journalisation OTel de Cowork n'existe pas aujourd'hui. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels. Le seul équivalent Cowork serait un plugin Cowork — d'où la question « un plugin Cowork peut-il déclarer un serveur MCP distant ? ». |
| `sdk/src/discovery.ts`, `sdk/src/client.ts` | `DISCOVERY_PATH = "/.well-known/oauth-authorization-server"` + `DiscoveryCache`. Le SDK sait déjà résoudre un document de découverte ; un client A2A réutiliserait ce mécanisme. |
| `cli/init.ts`, `cli/doctor.ts` | Toute nouvelle surface publique (Agent Card, endpoint A2A) doit apparaître dans le diagnostic, sinon elle devient un garde-fou fantôme. |
| `docs/ARCHITECTURE.md` | Section transports à réécrire si un quatrième contrat entre. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> L'identité d'agent de mcp-coordinator (`agents.id`, chaîne opaque globalement unique, sans URL ni clé,
> `src/types.ts` + `src/agent-registry.ts`) doit-elle migrer vers une Agent Card A2A adressable et signée
> servie depuis `src/discovery.ts` — sachant que c'est ce même choix d'identité qui conditionne la capacité
> à coordonner des sessions Claude Cowork, où il n'y a ni processus local ni chemin repo-relatif ?

### 6.2 Hypothèse

**Un conflit de cadrage à trancher d'abord.** Le protocole de challenge attribue le cadrage « menace » d'après le préfixe, et `G05` est dans le bloc `G`. Mais la fiche déclare elle-même `Nature: opportunity`, et sa §6.1 pose une question d'**adoption** (« l'identité d'agent doit-elle migrer vers une Agent Card A2A ? »), pas une question de réponse à une menace. Je retiens le cadrage de la fiche et le vocabulaire standard — `adopter` / `adopter partiellement` / `reporter` / `refuser` —, en le disant plutôt qu'en le subissant. La règle du préfixe est une heuristique de bloc ; ici elle se trompe, et `G05` est de toute façon un fourre-tout de fin de corpus.

**Terrain vérifié avant de commencer.** Aucune branche `G05`. Et la §6.1 de cette fiche pose, sans le savoir, **la question que tout le corpus tourne autour depuis dix passes** :

- `C01` §7.3 (tranchée, `main`) : *« D'où vient l'`agent_id` ? […] Elle doit être tranchée avant d'écrire une ligne de gate. »*
- `F02` (branche non fusionnée) a mesuré `AuthClaims` : neuf champs, **aucun `agent_id`**.
- `F03` (branche non fusionnée) : le contexte d'un handler MCP ne porte que `sessionId`.
- `G03` (branche non fusionnée) : le SEP Interceptors ne standardise **aucune** identité d'agent pair — `principal.type` vaut `user | service | anonymous`.

Quatre fiches ont buté sur l'absence d'identité d'agent. A2A, lui, **est** un standard d'identité d'agent : une carte adressable, signée, avec des capacités typées. C'est la première fois du corpus qu'une réponse au préalable arrive de l'extérieur.

**Ce que je pense avant de mesurer.** Que la fiche a raison sur le fond et se trompe d'échelle. Servir une Agent Card ne coûte pas cher — `src/discovery.ts` fait déjà exactement ça pour la RFC 8414. Mais une Agent Card décrit **le daemon**, pas les agents qu'il coordonne, et c'est le second cas qui intéresse le projet. Je m'attends à ce que la mesure fasse apparaître que les champs obligatoires d'`AgentCard` sont précisément ceux que `src/types.ts` ne porte pas — donc que le blocage n'est pas A2A mais, encore une fois, notre modèle d'identité.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **On ne peut pas remplir une Agent Card avec ce qu'on a.** | ≥ 1 champ **obligatoire** d'`AgentCard` non dérivable de `src/types.ts` + `src/tools/*.ts` |
| **K2** | **Aucun consommateur.** | Claude Code, Cursor, Cline, Aider parlent MCP ; **0** parle A2A |
| **K3** | **YAGNI.** | **0** issue mentionnant A2A, AGNTCY ou Cowork |
| **K4** | **Le recouvrement push est un doublon, pas un remplacement.** | si A2A n'a pas d'équivalent aux 16 `EventType`, ce n'est pas un remplacement |
| **K5** | **Cowork est hors de portée empirique.** | compte payant + Owner d'org + HTTPS public avec allowlist IP ⇒ **inmesurable**, aucun verdict ne s'y appuie |
| **K6** | **L'unité de conflit ne se transpose pas.** | `file-tracker`, `conflict-detector`, `dependency-map` supposent tous un chemin repo-relatif |
| **K7** | **Ce qui reste en propre est-il non vide ?** | ni A2A ni Cowork ne détectent un conflit d'intention sur fichiers |

**Ce que je m'interdis**, et c'est la liste complète de dix passes : vérifier la **nature** d'un objet avant d'en conclure une absence (`G03`) ; **grepper les docs et l'audit** avant de crier à la découverte — trois récidives, la dernière en `G04` où j'allais annuler une décision instruite ; ne pas publier un chiffre que je n'ai pas produit (`G01`) ; ne pas comparer deux objets de natures différentes (`D02`, `G01`, `G04`) ; ne pas déclarer « inmesurable » ce qui est seulement « non exécutable » (`G02`) ; et préciser si une fiche citée vit sur `main` ou sur une branche non fusionnée.

### 6.3 Protocole de vérification

<Proposition de la veille, non exécutée.>

> ⚠️ Les 4 premiers points sont exécutables en local (Node 22 + SDK A2A JS). Le 5e est déjà tranché par la
> doc (oui), mais la **vérification empirique** — installer un plugin Cowork pointant sur le daemon — n'est
> pas exécutable ici : elle exige un compte Cowork payant, un ajout de connecteur par un Owner d'org
> Team/Enterprise, et un daemon en HTTPS public avec les IP Anthropic en allowlist.

- [ ] Lire la spec A2A v1.0.0 et écrire à la main l'Agent Card JSON que le daemon servirait aujourd'hui, à partir de `src/types.ts` et de `src/tools/*.ts` : recenser les champs `AgentCard`/`AgentSkill` obligatoires qu'on ne sait pas remplir.
- [ ] Servir un `/.well-known/agent-card.json` statique dans `src/serve-http.ts` sur le modèle exact de `handleDiscovery()`, puis l'interroger avec un SDK A2A officiel (JS) : mesurer si la découverte passe sans toucher au reste.
- [ ] Mapper une consultation réelle (`src/consultation.ts`) sur `Task` + `Message` + `Part` + `Artifact` sur papier ; noter ce qui ne rentre pas (statuts, quorum, `plan-quality`).
- [ ] Comparer `taskPushNotificationConfigs/*` + `tasks/subscribe` à ce que `src/sse-emitter.ts` et `src/mqtt-bridge.ts` émettent déjà : événement par événement, dire si c'est un remplacement ou un doublon.
- [ ] Question fermée Cowork : vérifier dans la doc plugins Cowork si un plugin peut déclarer un serveur MCP **distant** (URL + auth). Si non, la piste Cowork s'arrête ici et la fiche se réduit à A2A.

### 6.4 Résultat observé

**Frontière.** Exécuté : la lecture de la spec A2A **à sa source canonique**, la confrontation champ par champ à `src/types.ts`, et l'adjudication de tout ce qui est local. **Non exécuté et déclaré tel** : le volet Cowork empirique — compte payant, ajout de connecteur par un Owner d'org, daemon en HTTPS public avec allowlist d'IP Anthropic. Aucun verdict ne s'y appuie.

**Où est la source, et pourquoi ça compte.** La page de spec HTML se tronque avant la définition d'`AgentCard`. Le dépôt publie bien un `specification/json/a2a.json` — mais son propre README dit :

> *« `a2a.json` is a **non-normative build artifact** derived from the canonical proto definition at `specification/a2a.proto`. It is generated during builds and intentionally **not** committed to source control. »*

La source normative est donc le `.proto` (35 942 octets, 812 lignes), et c'est lui que je lis. *(Leçon de `G03` appliquée dans le bon sens cette fois : quand un document est absent, chercher où le projet dit qu'il se trouve, plutôt que conclure de l'absence.)*

Le dépôt est par ailleurs très vivant : **25 379 étoiles**, dernier push **le jour du challenge**. Le §6.5 doutait de l'installation du standard sur des chiffres de communiqués contradictoires ; l'activité, elle, ne fait pas de doute.

#### K1 — on ne peut pas remplir une Agent Card avec ce qu'on a (se déclenche, et pas pour la raison attendue)

Champs **REQUIRED** d'`AgentCard`, verbatim du proto canonique :

```proto
string name                                = 1  [REQUIRED]
string description                         = 2  [REQUIRED]
repeated AgentInterface supported_interfaces = 3 [REQUIRED]
string version                             = 5  [REQUIRED]
AgentCapabilities capabilities             = 7  [REQUIRED]
repeated string default_input_modes        = 10 [REQUIRED]
repeated string default_output_modes       = 11 [REQUIRED]
repeated AgentSkill skills                 = 12 [REQUIRED]
```

Et les deux objets imbriqués :

```proto
message AgentInterface {   string url [REQUIRED]; string protocol_binding [REQUIRED];
                           string protocol_version [REQUIRED]; }
message AgentSkill     {   string id [REQUIRED]; string name [REQUIRED];
                           string description [REQUIRED]; repeated string tags [REQUIRED]; }
```

Contre notre modèle (`src/types.ts:5-13`) :

```ts
export interface Agent {
  id: string; org_id: string; name: string;
  modules: string;                 // JSON array
  status: AgentConnectionStatus; registered_at: string; last_seen_at: string;
}
```

**8 champs obligatoires, 1 dérivable.** Seul `name` se remplit. `description`, `version`, `capabilities`, `default_input_modes`, `default_output_modes` n'existent nulle part. `modules` est un tableau de chemins de modules : il donne au mieux un `name` d'`AgentSkill`, alors que celui-ci exige aussi `id`, `description` et `tags`.

**J'avais écrit ici un « argument décisif » qui est faux, et c'est la correction la plus importante de cette fiche.** J'affirmais que `AgentInterface.url` étant REQUIRED, un agent A2A est forcément un serveur, alors que nos agents sont des clients — « pas une colonne à ajouter, une direction inversée ». Le proto dit l'inverse, au champ 3 de la structure que je citais :

```proto
  // Optional. An opaque string used for routing requests to a specific agent
  // or tenant when multiple agents are served behind a single A2A endpoint.
  // When set, clients MUST include this value in the `tenant` field of all
  // request messages sent to this interface.
  string tenant = 3;
```

Et les gabarits de chemin du binding HTTP sont **tous** tenant-scopés — **34 occurrences** de `{tenant}` dans le proto :

```
post: "/{tenant}/message:send"     post: "/{tenant}/message:stream"
post: "/{tenant}/tasks/{id=*}:cancel"   …
```

**Plusieurs agents derrière un seul endpoint est un motif de premier ordre du protocole, câblé dans chaque route.** `url` REQUIRED ne dit pas « chaque agent s'auto-héberge », il dit « la carte nomme une adresse joignable ». J'ai confondu *adressable* et *auto-hébergé*. Et le substrat de routage existe déjà chez nous : `mqtt-tools.ts` appelle `mqttBridge.waitForMessage(claims.org, agent_id, …)` — le daemon tient déjà une file **par couple (org, agent_id)**, c'est-à-dire le modèle tenant.

**Le mur est réel, mais ce n'est pas celui que j'avais nommé.** `agent_id` est un `z.string()` **fourni par l'appelant**, absent d'`AuthClaims` (9 champs, mesurés par `F02`). Un `tenant` bâti là-dessus serait une clé de routage **non authentifiée** : c'est un trou d'autorisation, pas une impossibilité topologique. Le corpus bute donc bien pour la cinquième fois sur le même obstacle — `C01` §7.3, `F02`, `F03`, `G03` — et il s'appelle **identité d'agent authentifiée**, pas adressabilité.

**Second correctif : mon « 1 sur 8 » mesurait la mauvaise source.** Mon propre K1 disait « non dérivable de `src/types.ts` **+ `src/tools/*.ts`** » et je n'ai lu que le premier. Sur le second : **26 outils, 26 `description`, 26 `annotations.title`** — de quoi remplir `AgentSkill[]` mécaniquement (`id` = nom d'outil, `name` = titre, `description` = description, `tags` = groupement). Et pour une carte **du daemon**, le reste se remplit aussi :

| Champ REQUIRED | Source |
|---|---|
| `name`, `description`, `version` | `package.json` |
| `supported_interfaces.url` | `COORDINATOR_PUBLIC_URL`, **obligatoire et validée au boot** (`src/boot.ts`) |
| `capabilities` | **0 champ REQUIRED** dans `AgentCapabilities` — `{}` est valide |
| `default_input_modes` / `default_output_modes` | constantes |
| `skills` | les 26 outils |

**8 sur 8 pour une carte du daemon.** K1 se déclenche à son seuil (`≥ 1`) pour une carte **par agent** — `description` et `version` n'ont pas de source par agent — mais le chiffre que j'allais publier était faux sous le périmètre que K1 s'était lui-même donné. C'est `feedback_adjudicate_all_criteria`, à nouveau.

#### K2 — aucun consommateur (se déclenche)

Les quatre clients que le README revendique — Claude Code, Cursor, Cline, Aider — parlent MCP. Aucun ne parle A2A. Une Agent Card servie aujourd'hui n'aurait aucun consommateur, et ajouterait une surface HTTP publique. **K2 se déclenche.**

#### K3 — YAGNI (se déclenche)

```
"A2A"        -> 0 issue        "AGNTCY" -> 0 issue
"cowork"     -> 0 issue        "agent card" -> 1 (faux positif sur les mots)
```

**K3 se déclenche.**

#### K4 — le recouvrement push est un doublon, pas un remplacement (se déclenche)

`src/types.ts` porte **16** valeurs d'`EventType` — `agent_online`, `task_claimed`, `quota_update`… A2A raisonne en **états de cycle de vie d'une `Task`**, pas en vocabulaire d'événements de coordination. Le §4 écrit que `*TaskPushNotificationConfig` « recouvre exactement » ce que font `sse-emitter` et `mqtt-bridge` : c'est vrai du **mécanisme de livraison**, faux du **vocabulaire**. **K4 se déclenche** — adopter A2A ne supprimerait pas notre modèle d'événements, il ajouterait un transport de plus.

#### K5 — Cowork est hors de portée empirique (inmesurable, comme annoncé)

La question fermée du §6.3 est déjà tranchée par la doc et le §0 : oui, un plugin Cowork peut déclarer un serveur MCP distant. La vérification empirique exige un compte payant, un Owner d'org et un daemon en HTTPS public avec allowlist. **Déclaré inmesurable**, et **aucun verdict ne s'y appuie**.

#### K6 — l'unité de conflit ne se transpose pas (se déclenche)

`file-tracker`, `conflict-detector` et `dependency-map` supposent tous un chemin repo-relatif — le challenge de `G02` vient d'ailleurs de mesurer que même un worktree hors dépôt est **refusé** (`path-normalize.ts:33`). Coordonner des sessions Cowork demanderait une seconde notion d'unité de conflit. **K6 se déclenche.**

#### K7 — ce qui reste en propre (ne se déclenche pas)

Ni A2A ni Cowork ne détectent un conflit d'intention sur des fichiers. **K7 ne se déclenche pas** — avec la réserve, déjà posée par `G01` et `D03`, que notre détection est celle d'un agrégateur de déclarations.

### 6.5 Contre-arguments

- **YAGNI, sévèrement.** Aucun utilisateur n'a demandé A2A. Le projet coordonne des agents de codage sur un
  dépôt ; A2A résout la communication inter-entreprise entre agents hétérogènes. La zone de recouvrement
  réelle est peut-être vide.
- **Effort XL pour une confiance `low`.** L'`api_surface` A2A était `unknown` dans la fiche brute et n'a été
  comblée qu'a posteriori par un vérificateur. Personne dans le projet n'a lu la spec v1.0.0. Engager un
  quatrième contrat de transport (MCP + REST + MQTT + A2A) sur cette base est disproportionné.
- **Aucun client ne le demande.** Claude Code, Cursor, Cline et Aider parlent MCP, pas A2A. Une Agent Card
  servie par le daemon n'aurait, aujourd'hui, aucun consommateur — c'est du code mort avec une surface
  d'attaque HTTP publique en plus.
- **Coût de maintenance permanent.** `Task`/`Message`/`Artifact` d'A2A et le modèle de threads de
  `src/consultation.ts` divergeront ; chaque évolution du modèle interne devra être re-mappée. Le projet
  maintient déjà `docs/openapi.yaml` (43 Ko) en parallèle des outils MCP.
- **Complexité pour l'auto-hébergeur.** Les Agent Cards signées (JWS) impliquent une gestion de clés
  supplémentaire, distincte du secret JWT existant (`cli/rotate-jwt-secret.ts`). Une clé de plus à faire
  tourner, un mode de panne de plus dans `cli/doctor.ts`.
- **Cowork casse la portabilité et le modèle de données.** Toute la chaîne conflit
  (`file-tracker` → `conflict-detector` → `dependency-map`) suppose un chemin repo-relatif. Coordonner des
  sessions Cowork demanderait une seconde notion d'unité de conflit, donc un second modèle — pas un
  paramètre.
- **Dépendance à une surface Anthropic non documentée pour les tiers.** Les champs `cowork_*` de l'API
  Analytics et les sessions Cowork de la Compliance API sont des surfaces d'administration d'entreprise,
  pas des points d'extension. Rien ne garantit qu'un daemon tiers y ait sa place.
- **Chiffres d'adoption incohérents entre les deux communiqués** (150 organisations vs 100 entreprises) :
  signal d'un écosystème encore en phase de récit, pas de standard installé.

---

## 7. Décision

**Sur le vocabulaire employé.** La fiche déclare `Nature: opportunity` en en-tête **et** dans `README.md`, l'index du corpus — seule du bloc `G`. C'est une source externe à la fiche, donc non circulaire. Je note aussi que `_CHALLENGE-PROMPT.md:155` écrit « Fiche « menace » (**blocs D et G**) », énumération explicite et non heuristique de préfixe : j'avais caricaturé le texte que j'écartais. La jurisprudence tranche pourtant dans mon sens — `E09`, `Nature: threat` hors blocs D/G, a coché `refuser` — donc le vocabulaire suit `Nature`, pas le bloc. Trois verdicts distincts, un par objet.

| | |
|---|---|
| **Verdict** | **A2A, migration de l'identité d'agent : ✅ refuser** · **A2A, carte du daemon : ✅ reporter** · **Cowork : ✅ reporter** |
| **Date** | 2026-08-17 |
| **Justification** | La §6.1 demande si l'identité d'agent doit migrer vers une Agent Card. **Non** — non pour une raison de topologie (le protocole gère explicitement plusieurs agents derrière un endpoint), mais parce que `agent_id` est une chaîne fournie par l'appelant, absente d'`AuthClaims` : un `tenant` bâti dessus serait une clé de routage **non authentifiée**. Cinquième récidive du préalable d'identité. En revanche la carte du **daemon** est dérivable à 8/8 aujourd'hui : ce n'est pas infaisable, c'est sans usage. |
| **Issue / PR** | aucune ; le dossier découvrabilité est renvoyé à `A10` |
| **Jalon visé** | aucun ; conditions de réveil en §7.4 |

### 7.1 Ce qui est refusé — la migration de l'identité d'agent vers A2A

Refusé, et le motif compte plus que le verdict. **Ce n'est pas « impossible » : c'est bloqué par le même mur que quatre fiches avant celle-ci.** `C01` §7.3 (sur `main`), `F02`, `F03` et `G03` (branches non fusionnées) ont chacune conclu qu'il n'existe pas d'identité d'agent exploitable côté serveur. A2A ne la fournit pas — il fournit un mécanisme de **routage** (`tenant`) qui suppose une clé de confiance que nous n'avons pas.

Tant que `agent_id` reste un `z.string()` du corps de la requête, toute carte par agent, tout `tenant`, tout gate et tout validator héritent du même défaut. **C'est le résultat le plus robuste de tout le bloc `G`**, et il ne vient d'aucune spec externe : il vient de notre modèle d'auth.

### 7.2 Ce qui est reporté, et pourquoi pas refusé — la carte du daemon

J'allais jeter ceci avec le reste, sur la foi de mon argument faux. Les huit champs obligatoires sont dérivables **aujourd'hui**, sans nouvelle colonne : `package.json` donne trois champs, `COORDINATOR_PUBLIC_URL` est déjà obligatoire et validée au boot, `AgentCapabilities` n'exige rien, et les 26 outils avec leurs titres et descriptions remplissent `skills`. Le modèle d'implémentation existe : `src/discovery.ts` sert déjà un document de découverte bien connu pour la RFC 8414, et `src/serve-http.ts` route déjà `/.well-known/…`.

Ce qui manque n'est donc pas la faisabilité mais **l'usage** : `K2` (aucun des quatre clients revendiqués ne parle A2A) et `K3` (**0** issue). Le protocole réserve exactement ce cas à `reporter` — « au premier utilisateur qui le demande ». Refuser fermerait une porte à ~25 lignes de coût ; ce serait déclarer mort ce qui est seulement inutile.

### 7.3 Cowork — reporter

`K5` est **inmesurable** ici et je n'en tire rien. `K6` tient, avec une correction : `file-tracker` et `conflict-detector` sont bien liés au chemin repo-relatif, mais `dependency-map` clé sur un `module_id` opaque — c'est le seul des trois qui se transposerait à un domaine hors dépôt. Deux sur trois, pas trois sur trois.

### 7.4 Conditions de réveil

| Signal | Objet |
|---|---|
| Un client de la population servie parle A2A, ou un déploiement le demande | la carte du daemon |
| `AuthClaims` gagne un `agent_id` authentifié | la migration d'identité, et avec elle tout le dossier des gates |
| Cowork devient testable sans compte payant ni Owner d'org | le volet Cowork |

### 7.5 Le dossier découvrabilité appartient à `A10`

Le §4 s'inquiète de devenir invisible si AGNTCY Directory devient le point d'entrée. Ne rien en dire serait une esquive — mais le traiter ici serait un doublon : **`A10`** (non tranchée) porte déjà le registre officiel, et son §2 a déjà jugé la famille voisine (`experimental-ext-server-card`, `/.well-known/ai-catalog.json`) en concluant *« le bénéfice est nul aujourd'hui […] à classer en veille, pas en action »*. Le fait vérifiable est là : `package.json` déclare `mcpName: io.github.swoofer/mcp-coordinator`, une promesse de publication **orpheline**. Ce constat va à `A10`, pas à `G05`.

### 7.6 Corrections obligatoires avant réutilisation

1. **§4 : « `*TaskPushNotificationConfig` recouvre exactement » sse-emitter et mqtt-bridge** — vrai du mécanisme de livraison, faux du vocabulaire. Nos **16** `EventType` (`agent_online`, `file_edited`, `quota_update`, `token_usage`…) n'ont aucune représentation dans un modèle qui ne connaît que des états de cycle de vie de `Task` et deux types d'événement de flux.
2. **En-tête : `v1.0.1` est sortie le 2026-05-28**, trois mois avant la vérification du §0 qui annonce v1.0.0 comme dernière version stable.
3. **§4, la thèse « migration d'identité »** est à reformuler : le protocole n'interdit rien topologiquement (`tenant` + 34 chemins tenant-scopés), c'est notre auth qui bloque.
4. **§6.1** demande de trancher une migration alors que la question utile est la carte du daemon — deux objets, deux verdicts.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 2 fiches brutes (A2A/AGNTCY, Claude Cowork). |
| 2026-08-14 | Vérification des faits : méthodes JSON-RPC A2A renommées en v1.0, Cowork est beta, question plugin/MCP distant tranchée (oui). |
| 2026-08-17 | Challenge, dernière fiche du corpus. **Trois verdicts** : `refuser` la migration de l'identité d'agent vers A2A, `reporter` la carte du daemon, `reporter` Cowork. Spec lue à sa **source canonique** — le site officiel rend `Error: Message AgentCard not found`, et `specification/json/a2a.json` est un artefact de build **non normatif et non commité** ; la source est `specification/a2a.proto`. `AgentCard` y porte **8** champs REQUIRED. **Mon argument décisif était faux** : j'allais publier que `AgentInterface.url` impose que chaque agent soit un serveur — « une direction inversée ». Le champ 3 de la même structure dit l'inverse (`tenant`, *« when multiple agents are served behind a single A2A endpoint »*), et **34** gabarits de chemin HTTP sont tenant-scopés. Second correctif : mon « 1 champ sur 8 dérivable » ne lisait que `src/types.ts` alors que K1 disait « + `src/tools/*.ts` » — les 26 outils remplissent `skills`, et une carte **du daemon** est dérivable **8/8** aujourd'hui. Le vrai mur est le même que pour `C01` §7.3, `F02`, `F03` et `G03` : `agent_id` est une chaîne fournie par l'appelant, absente d'`AuthClaims` — **cinquième récidive du préalable d'identité**. Le dossier découvrabilité (AGNTCY Directory, `mcpName` orphelin) est renvoyé à `A10`. |
