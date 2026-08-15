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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 2 fiches brutes (A2A/AGNTCY, Claude Cowork). |
| 2026-08-14 | Vérification des faits : méthodes JSON-RPC A2A renommées en v1.0, Cowork est beta, question plugin/MCP distant tranchée (oui). |
