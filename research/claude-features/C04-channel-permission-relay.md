# C04 — Relais de permission : le dashboard devient console d'approbation

| Champ | Valeur |
|---|---|
| **ID** | `channel-permission-relay` |
| **Surface** | claude-code (surface secondaire : managed-agents) |
| **Statut** | research-preview (le pendant managed-agents est en `beta`) |
| **Disponible depuis** | documenté dans `channels-reference` · sanitation des champs relayés à partir des clients v2.1.211 (un chercheur date cette version au 15 juil. 2026, les deux autres ne donnent pas de date — voir §3) |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | ~~M~~ **XL** — challenge 2026-08-16 : décompte honnête ≈ **22 fichiers** (§6.4-J), dont `docs/index.html` à 7 éditions par chaîne et un module de corrélation `request_id` entièrement à écrire. §5 en nommait 11 et avait déjà dérivé en 48 h. |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — ~~volet channel testable en local~~ **infirmé le 2026-08-16 : le volet channel n'est PAS testable depuis un agent** (le flag `dangerously` n'est pas parsé hors session interactive, cf. `C03` §6.4-K). En revanche le **volet bus MQTT** l'est intégralement, et c'est lui qui a tranché. Volet managed-agents toujours non testable. |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `refuser` : K1, K5, K6 et K7 déclenchés |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — marqueur `(à vérifier)` sur l'absence de `deny_message` **tranché** : `channels-reference` documente le verdict comme n'ayant que deux champs (`request_id`, `behavior`). Aucun champ de motif. Le fait est confirmé.
- §1 — précision de la sanitation v2.1.211+ : la doc mentionne aussi la neutralisation des **guillemets/chevrons sosies** et le **repliement des suites d'espaces** ; au-delà de 3 500 code points la valeur n'est pas tronquée mais **élidée en son milieu** (marqueur `⋯ N code points elided ⋯`), début et fin restant visibles. Le plafond s'applique **par champ de premier niveau** pour `input_preview`.
- §3 — divergence de date levée : la release `v2.1.211` d'`anthropics/claude-code` est bien datée du **15 juillet 2026**, et son changelog porte explicitement le correctif de neutralisation des caractères bidi/zero-width/sosies dans les prévisualisations de permission relayées.
- §5 `cli/channel.ts` — le commentaire « Phase 1 leaves this off by default » est aux lignes **279-281**, pas 283-285 (283 = `password?: string;`).
- §5 `src/security/audit-events.ts` — `TIER2_EVENTS` commence à la ligne **52** (51 = la ligne de commentaire), donc **52-68** et non 51-68.

Tout le reste de §2 est confirmé mot pour mot contre `code.claude.com/docs/en/channels-reference` et `platform.claude.com/docs/en/managed-agents/permission-policies` : les deux clés `capabilities.experimental`, les deux noms de méthode, les quatre champs de `permission_request`, la regex `[a-km-z]{5}`, la non-couverture du consentement projet/MCP, l'avertissement d'authentification, le header `managed-agents-2026-04-01`, `permission_policy` / `always_ask` / `always_allow`, `stop_reason.type = requires_action`, `stop_reason.event_ids[]`, `user.tool_confirmation` avec `tool_use_id` / `result` / `deny_message`, et le défaut `always_ask` des `mcp_toolset`. Statut `research preview` toujours exact (encadré en tête de la page de référence, avec activation explicite requise pour les orgs Team/Enterprise).

Tous les autres points d'ancrage de §5 ont été rouverts et vérifiés ligne à ligne : `cli/channel.ts` 24-25 / 277 / 311-317 / 324-330 / 463-467, `src/working-files-tracker.ts` 117-140, `src/conflict-detector.ts` 20-152 (fichier de 153 lignes), `src/types.ts` 94-110 et 122, `src/sse-emitter.ts` 39, `src/mqtt-bridge.ts` 260-392, `src/serve-http.ts` 188 et 732, `dashboard/public/index.html` 163-232 (avec `Clear UI` / `Reset Server` en 191-192), `src/tools/files-tools.ts` 49-74, `src/security/audit-events.ts` 15-49, `cli/doctor.ts` (zéro occurrence de « channel », confirmé). `src/auth/csrf.ts`, `src/auth/rate-limit.ts` et `src/security/audit-chain.ts` existent bien.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Le volet channel — le cœur de la fiche — est intégralement testable ici : Claude Code est installé, la doc donne un serveur de référence complet, et `--dangerously-load-development-channels server:<nom>` contourne l'allowlist de la research preview. On peut donc dérouler §6.3 points 1 à 5 en local sans aucun credential Anthropic. Le volet managed-agents (`permission_policy`, `user.tool_confirmation`, `deny_message`) n'est pas testable : il exige une clé API avec le header beta `managed-agents-2026-04-01` et un accès `/v1/agents` + `/v1/sessions`. Réserve secondaire : si le poste est rattaché à une org Team/Enterprise, la policy `channelsEnabled` peut bloquer les channels indépendamment du flag de développement.

## 1. Ce que c'est

Un serveur de channel — exactement le format que `cli/channel.ts` implémente déjà — peut déclarer une capability supplémentaire pour recevoir, **en parallèle du dialogue terminal**, chaque demande d'approbation d'outil de Claude Code. Claude Code émet une notification `notifications/claude/channel/permission_request` portant un `request_id`, le `tool_name`, une `description` et un `input_preview`. Le serveur répond par une notification `notifications/claude/channel/permission` avec le même `request_id` et un `behavior` valant `allow` ou `deny`.

Le point clé du protocole : le dialogue local **reste ouvert**. C'est une course — le premier verdict arrivé (humain au terminal ou serveur de channel) gagne. Le relais ne couvre que les approbations d'outil (Bash, Write, Edit…), pas le consentement projet ni le consentement d'ajout d'un serveur MCP. Les `request_id` sont cinq lettres minuscules tirées de a-z **sans le `l`** (regex `[a-km-z]{5}`), ce qui les rend lisibles à voix haute et non ambigus à l'écran.

Les champs `description` et `input_preview` sont sanitizés côté client depuis v2.1.211 (neutralisation des caractères de direction-override, invisibles et des guillemets/chevrons sosies, repliement des suites d'espaces, relais intégral jusqu'à 3 500 code points — au-delà, élision du milieu avec un marqueur `⋯ N code points elided ⋯` qui préserve début et fin ; le plafond s'applique par champ de premier niveau pour `input_preview`), mais restent du texte d'origine modèle : à traiter comme non fiable, jamais comme instruction. La documentation insiste sur un point de sécurité : **ne déclarer la capability que si l'expéditeur est authentifié**, puisque quiconque peut répondre sur ce canal peut approuver un outil.

Une mécanique structurellement voisine existe côté managed-agents (statut `beta`) : chaque toolset porte une `permission_policy`, la session passe `requires_action`, et le client répond par un événement `user.tool_confirmation`. Ce n'est pas la même API, mais c'est le même modèle « bloquer jusqu'à verdict », avec en plus un `deny_message` renvoyé à l'agent — que le protocole channel n'offre pas.

## 2. Surface d'API exacte

```
# Claude Code — channels (research preview)
capabilities.experimental['claude/channel']              = {}   # déjà déclaré dans cli/channel.ts
capabilities.experimental['claude/channel/permission']   = {}   # la capability à ajouter

# Notification entrante (Claude Code -> serveur de channel)
notifications/claude/channel/permission_request
  params.request_id     : string   # [a-km-z]{5}
  params.tool_name      : string
  params.description    : string   # sanitizé v2.1.211+, non fiable
  params.input_preview  : string   # sanitizé v2.1.211+, non fiable

# Notification sortante (serveur de channel -> Claude Code)
notifications/claude/channel/permission
  params.request_id     : string   # echo
  params.behavior       : 'allow' | 'deny'

# Rappel du transport déjà utilisé
notifications/claude/channel        params { content, meta }   # tag <channel source="..." ...>
flags CLI : --channels <nom> , --dangerously-load-development-channels
```

Aucun champ de motif de refus n'est documenté dans la surface channel — pas d'équivalent `deny_message`. **Vérifié le 2026-08-14** : `channels-reference` décrit le verdict comme portant exactement deux champs (`request_id`, `behavior`), et précise que `deny` « rejects it, the same as answering No in the local dialog » — sans texte associé.

Pendant managed-agents (`beta`, header/version `managed-agents-2026-04-01`) :

```
tools[].default_config.permission_policy : { "type": "always_ask" | "always_allow" }
tools[].configs[]                        : { name, enabled, permission_policy }
stop_reason.type                         : "requires_action"
stop_reason.event_ids[]                  : string[]
{ "type": "user.tool_confirmation", "tool_use_id": "...", "result": "allow"|"deny", "deny_message": "..." }
```

Contrainte d'intégration à retenir : tout `mcp_toolset` est **`always_ask` par défaut**. Un agent managed branché sur mcp-coordinator demandera confirmation à chaque appel d'outil tant que l'intégrateur ne bascule pas explicitement en `always_allow`.

## 3. Sources

- https://code.claude.com/docs/en/channels-reference.md
- https://code.claude.com/docs/en/channels
- https://platform.claude.com/docs/en/managed-agents/permission-policies
- https://platform.claude.com/docs/en/managed-agents/tools
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming

Divergence entre chercheurs, signalée telle quelle : un seul des trois relevés channel date la v2.1.211 au 15 juillet 2026 ; les deux autres citent la version sans date. **Levée le 2026-08-14** : la release `v2.1.211` d'`anthropics/claude-code` est bien datée du 15 juillet 2026, et son changelog porte le correctif de neutralisation des caractères bidi / zero-width / guillemets sosies dans les prévisualisations de permission relayées. Le chercheur qui donnait la date avait raison.

- https://github.com/anthropics/claude-code/releases/tag/v2.1.211

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

C'est le premier point d'ancrage où mcp-coordinator peut **bloquer** une écriture, pas seulement la signaler. Aujourd'hui toute la chaîne est consultative : `ConflictDetector.detect()` (`src/conflict-detector.ts:20`) ne produit que des `ConflictReport` de sévérité `warning` ou `info` (`src/types.ts:120-127`), l'`impactScorer` classe en `concerned` / `gray_zone` / `pass`, et le dashboard affiche. Un agent qui décide d'ignorer l'avertissement écrit quand même. Avec le relais, la logique existante devient exécutoire : `WorkingFilesTracker.getIndex()` (`src/working-files-tracker.ts:117`) sait déjà, pour une liste de chemins, quels *autres* agents détiennent une claim non expirée ; il suffit de la brancher sur un `behavior: 'deny'` pour transformer un avertissement en refus.

Deuxième bénéfice, indépendant : le dashboard devient une console d'approbation pour N agents d'un même repo. L'infra est en place — SSE (`src/sse-emitter.ts`), broker MQTT (`src/mqtt-broker.ts`, `src/mqtt-bridge.ts`), auth OAuth/JWT (`src/auth/`), chaîne d'audit SHA-256/HMAC (`src/security/audit-chain.ts`) — et ne demanderait qu'un nouveau type d'événement plus une route de réponse. Le bénéficiaire concret : l'opérateur d'un essaim qui aujourd'hui doit surveiller N terminaux pour valider N prompts, et qui n'a aucune trace exportable de qui a approuvé quoi.

Aucun code existant ne disparaît. C'est une capacité nouvelle, pas un remplacement de code maison.

**Risque si on ne fait rien :**

Faible et non urgent — la feature est en research preview et rien ne casse. Le risque réel est de positionnement : le « annoncer avant d'écrire » de mcp-coordinator reste un contrat d'honneur tant qu'aucun mécanisme ne peut refuser, et un concurrent qui branche ce relais obtient l'application effective de la politique avec le même effort.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/channel.ts` | Cœur du chantier. Ajouter `"claude/channel/permission": {}` au bloc `capabilities.experimental` (l. 311-317). Le serveur ne fait aujourd'hui qu'**émettre** des notifications (`server.notification(...)`, l. 463-467) ; il faut un handler de notification **entrante**, qui n'existe pas encore dans ce fichier. Le commentaire d'en-tête l. 24-25 déclare explicitement « Phase 3 (permission relay …) remains deferred » : cette fiche est le dossier d'instruction de cette phase 3. |
| `cli/channel.ts` — auth MQTT | `buildChannelServer()` (l. 277) accepte `username`/`password` optionnels et se connecte anonymement par défaut (l. 324-330, et l. 279-281 « Phase 1 leaves this off by default »). La doc exige un expéditeur authentifié avant de déclarer la capability : c'est un pré-requis bloquant, pas un détail. |
| `src/working-files-tracker.ts` | `getIndex(orgId, filePaths, excludeAgentId)` (l. 117-140) filtre déjà sur `claim_until > now` et exclut l'appelant : c'est exactement le prédicat d'auto-deny. Rien à changer sur la signature, seulement à appeler depuis un nouveau chemin. |
| `src/conflict-detector.ts` | `detect()` (l. 20-152) est le moteur de politique candidat pour un verdict. Ne connaît aujourd'hui que `warning` / `info` — il faudrait décider s'il gagne une sévérité bloquante ou si le verdict vit ailleurs. |
| `src/types.ts` | `EventType` (l. 94-110) est une union fermée : un `permission_requested` / `permission_resolved` doit y être ajouté pour passer par `SseEmitter.emit()` (`src/sse-emitter.ts:39`). `ConflictReport.severity` (l. 122) n'a pas de valeur bloquante. |
| `src/mqtt-bridge.ts` | Nouveau motif de topic à définir sous `coordinator/<org>/…` (topics existants l. 260-392). Point d'attention : le bus est aujourd'hui unidirectionnel événementiel ; une demande de permission est une **requête** qui attend une réponse corrélée par `request_id`, ce que le bridge ne modélise pas. |
| `src/serve-http.ts` | Routes `/api/…` (l. 188-259, l. 732 pour le flux SSE `/api/events`). Une route `POST` de verdict côté dashboard n'existe pas ; à créer avec CSRF (`src/auth/csrf.ts`) et rate-limit (`src/auth/rate-limit.ts`). |
| `dashboard/public/index.html`, `dashboard/public/dashboard.js` | Le dashboard est strictement en lecture (timeline, agents, threads, métriques — cf. les `id=` l. 163-232 de `index.html`). Les seuls boutons mutants sont `Clear UI` et `Reset Server`. Une file d'approbation avec compte à rebours est un panneau entièrement nouveau. |
| `src/security/audit-events.ts` | `TIER1_EVENTS` (l. 15-49) et `TIER2_EVENTS` (l. 52-68) sont des `as const` fermés pilotant la rétention. Un `permission.allowed` / `permission.denied` doit y être inscrit, sinon la trace « qui a approuvé quoi » n'a pas de politique de rétention. |
| `src/tools/files-tools.ts` | `check_file_conflict` (l. 49-74) expose déjà le test au modèle en `readOnlyHint`. À garder tel quel — le relais ne le remplace pas, il court-circuite le cas où l'agent ne l'appelle pas. |
| `cli/doctor.ts` | Aucune vérification liée aux channels aujourd'hui (aucune occurrence de « channel » dans le fichier). Le relais introduit un pré-requis vérifiable : version du client, capability déclarée, expéditeur authentifié. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le verdict d'auto-deny doit-il être rendu **localement par le processus `cli/channel.ts`** (sans état, latence quasi nulle, mais il ne voit que MQTT et n'a pas le `working_files` du daemon), ou **par le daemon via un aller-retour MQTT corrélé sur `request_id`** (politique complète : working_files + conflict-detector + audit, mais on perd la course contre le dialogue terminal dès que l'humain est plus rapide) — et si c'est le daemon, que fait-on du fait que `src/mqtt-bridge.ts` ne sait aujourd'hui que publier des événements, jamais attendre une réponse ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

> ⚠️ **La testabilité annoncée en §0 est déjà infirmée par le challenge `C03` du même jour.** §0
> affirme que « le volet channel — le cœur de la fiche — est intégralement testable ici » parce que
> `--dangerously-load-development-channels` contournerait l'allowlist. C'est faux : ce flag
> **n'est pas parsé hors session interactive** (`if (!gr) { … }` dans le client livré, vérifié en
> `C03` §6.4-K). Un agent ne peut donc pas dérouler les points 1 à 4 de §6.3. Je le pré-enregistre
> ici pour que ce ne soit pas une découverte commode en cours de route.

**Ce que je crois qu'il va se passer.**

1. Le relais est **doublement fermé** : la porte channel de `C03` (`tengu_harbor`, défaut `false`)
   **plus** une seconde porte spécifique aux permissions que la fiche ignore complètement.
2. La forme du protocole de §2 se vérifie intégralement dans le binaire livré — noms de méthodes,
   schéma des `params`, alphabet du `request_id`, constantes d'assainissement.
3. **Le broker MQTT accepte une publication anonyme.** Le pré-requis d'authentification n'est donc
   pas un conseil de la doc mais un **bloqueur de release** — et c'est le point le plus important de
   la fiche, parce qu'il est testable **sans Claude Code**.
4. L'aller-retour daemon sera **bien plus rapide** que le temps de réaction humain, ce qui affaiblit
   l'argument de « course perdue » de §6.1 : le vrai obstacle n'est pas la latence.
5. `src/mqtt-bridge.ts` ne sait pas corréler une requête et sa réponse.

**Verdict pressenti :** `reporter`, avec pour vrai livrable la mesure du trou d'authentification.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | aucune preuve exécutée n'est atteignable sur le contrat hôte | `reporter`, jamais `adopter`. **Déjà acquis** par `C03` — donc ce challenge doit produire sa valeur ailleurs (§6.3 point 5 et la mesure de latence), sinon il ne vaut rien. |
| **K2** | le broker **rejette** la publication anonyme | le pré-requis d'authentification est déjà satisfait, le « bloqueur de release » de §5 tombe, et je dois le corriger noir sur blanc. |
| **K3** | l'aller-retour daemon dépasse **500 ms** en médiane | la topologie « verdict par le daemon » de §6.1 est morte, seul le verdict local dans `cli/channel.ts` survit, et §4 doit être révisé. |
| **K4** | la seconde porte spécifique aux permissions **n'existe pas** dans le binaire | ma preuve `C03` était mal lue ; je le signale et je re-instruis. |
| **K5** | le chantier dépasse **15 fichiers** | l'effort n'est plus M : `refuser` plutôt que `reporter`, parce qu'on ne réserve pas un chantier de cette taille pour une feature doublement fermée. |
| **K6** | aucun opérateur n'a demandé la fonction | filtre YAGNI, et `HANDOFF.md` l. 65 contient déjà la règle « don't accidentally re-spike this without a concrete operator request ». Le verdict ne peut pas être `adopter` même si la technique est séduisante. |
| **K7** | un `deny` est **opaque** pour l'agent refusé (pas de `deny_message`, aucun canal de motif) | le bénéfice « rendre la politique exécutoire » de §4 est très surévalué : on obtient un refus que l'agent ne peut pas comprendre ni corriger. À dire explicitement. |

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Le volet managed-agents (`permission_policy`, `user.tool_confirmation`, `deny_message`) n'est pas exécutable ici : il exige une clé API avec le header beta `managed-agents-2026-04-01` et un accès aux endpoints `/v1/agents` et `/v1/sessions`.

- [ ] Ajouter `"claude/channel/permission": {}` dans `buildChannelServer()` et lancer une vraie session Claude Code avec `--channels mcp-coordinator --dangerously-load-development-channels` ; logguer sur stderr la notification brute reçue pour un `Bash` refusable. Objectif : confirmer que le nom de méthode, la forme des `params` et le format du `request_id` correspondent à §2, sans rien deviner.
- [ ] Mesurer la latence réelle de la course : horodater la réception de `permission_request` et l'émission du verdict, sur les deux topologies (verdict local dans `cli/channel.ts` vs aller-retour MQTT vers le daemon). Un verdict qui arrive après l'humain est un verdict inutile.
- [ ] Vérifier ce qui se passe quand le serveur **ne répond pas** (silence) et quand il répond **après** que l'humain a tranché : le dialogue reste-t-il cohérent, la seconde réponse est-elle ignorée proprement ou provoque-t-elle une erreur de protocole ?
- [ ] Câbler `WorkingFilesTracker.getIndex()` sur un scénario à deux agents : agent A détient une claim sur un fichier, agent B tente un `Write` dessus. Vérifier que le `deny` part et, surtout, ce que l'agent B voit — le protocole n'ayant pas de `deny_message`, mesurer si le refus est actionnable ou juste opaque.
- [ ] Tester le chemin non authentifié : connecter un second client MQTT anonyme au broker et tenter d'émettre un verdict `allow`. Si ça passe, le pré-requis d'authentification n'est pas un conseil mais un bloqueur de release.

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233**, dépôt à `mcp-coordinator@2.1.0`. PoC jetable dans
le scratchpad, daemon de test démarré sur des ports dédiés puis arrêté.*

> **Frontière exécuté / lu.**
> **Exécuté :** tout le volet bus MQTT — connexions, publication, distribution, latence — sur un
> daemon réel, dans les **deux** configurations d'authentification.
> **Lu (code du client livré) :** les deux portes runtime et le schéma du verdict.
> **Jamais exécuté :** la réception d'un `permission_request`. Impossible depuis un agent — voir
> l'encadré de §6.2 et le challenge `C03` §6.4-K.

#### A. Le point le plus important : le bus est **entièrement ouvert** en configuration par défaut

`COORDINATOR_AUTH_ENABLED` est **par défaut à `false`** (`src/serve-http.ts` l. 102 ; le commentaire
l. 932-936 l'assume : « Default off (essaim and any client without auth keep working unchanged) »).
Daemon démarré sans cette variable, sur des ports dédiés :

```
=== 1. Connexion au broker ===
  CONNECTE   | anonyme, sans clientId impose  | sessionPresent=false
  CONNECTE   | anonyme, clientId 'intrus-c04' | sessionPresent=false
  CONNECTE   | identifiants bidon             | sessionPresent=false
```

Puis, **entre deux clients anonymes distincts**, sur un topic réellement écouté par le bridge :

```
abonne anonyme : connecte et abonne a coordinator/# (wildcard TOTAL)
publieur anonyme : connecte

messages recus par l'abonne anonyme : 1
  [coordinator/default/consultations/new] {"agent_id":"agent-forge-par-un-intrus",
   "subject":"INJECTION C04","target_modules":["src/auth"],"thread_id":"c04-injecti…
```

> 🔴 **Mon premier test ne prouvait rien, et je le retire.** Il n'exhibait qu'un `puback` QoS1. Or
> aedes écrit le PUBACK **avant** `broker.publish` (`lib/handlers/publish.js`) : c'est un accusé de
> *réception*, jamais de *routage*. Un topic totalement inventé est acquitté de la même façon. La
> preuve ci-dessous — un abonné qui **reçoit** — est la seule qui compte.

Deux faits distincts, à ne pas confondre :

1. **La distribution est réelle**, pas seulement acquittée. Mon premier test ne montrait qu'un
   `puback` QoS1 — ce qui ne prouve rien. Celui-ci montre qu'un abonné anonyme **reçoit** le message
   d'un publieur anonyme. Et il s'abonne à `coordinator/#` : **en configuration par défaut,
   n'importe quel processus local lit l'intégralité du bus de coordination de toutes les orgs.**
2. **Le daemon, lui, a jeté ce message précis :**
   ```
   {"component":"mqtt","reason":"no_listener","topic":"coordinator/default/consultations/new",
    "org":"default","msg":"MQTT message dropped"}
   ```
   L'injection était donc **inerte** ici. Il faut le dire, sinon je surinterprète.

**Ce que ça implique pour le relais, précisément.** Un verdict de permission est, par construction,
un message **avec un listener qui l'attend** — corrélé sur `request_id`. C'est exactement le cas où
`no_listener` ne protège plus. Le scénario du forgeur n'est donc pas spéculatif : il est le cas
nominal de la feature. Point 5 de §6.3 : **tranché, et le pré-requis d'authentification est réel.**

#### B. Mais l'inverse ferme la porte : les deux configurations sont exclusives pour le channel

Avec `COORDINATOR_AUTH_ENABLED=true` (le daemon de dev qui tournait déjà sur ce poste) :

```
  REFUSE | anonyme, sans clientId impose  | Connection refused: Not authorized
  REFUSE | anonyme, clientId 'intrus-c04' | Connection refused: Not authorized
  REFUSE | identifiants bidon             | Connection refused: Not authorized
```

Et le serveur channel du dépôt reçoit **le même refus** — capturé pendant le challenge `C03` :
`[channel] MQTT error Connection refused: Not authorized`. Or `buildChannelServer` (`cli/channel.ts`
l. 282-284) affirme le contraire, en commentaire : « Phase 1 leaves this off by default (**matches
daemon's anonymous-by-default broker config**) ».

> 🔎 **Correction de ma propre première lecture.** J'ai d'abord conclu qu'aucun chemin de credential
> n'existait pour le channel. **C'est faux** : `cli/channel.ts` l. 509-510 et 534-535 exposent
> `--mqtt-username` / `--mqtt-password` et `COORDINATOR_MQTT_USER` / `COORDINATOR_MQTT_PASSWORD`.
> Le pré-requis est donc **opérationnel**, pas architectural — mais il exige que l'opérateur minte
> un JWT à la main et gère sa rotation, pour un processus stdio lancé par Claude Code.

> 🔴 **Reformulation ABANDONNÉE après la passe adversariale.** J'allais écrire que §5 exagérait et
> que l'authentification n'était « pas un pré-requis bloquant mais un dilemme opérationnel ».
> **C'est l'inverse : §5 avait raison, et elle est même trop faible.** Voir §G — le trou existe dans
> **les deux** configurations. J'étais sur le point d'affaiblir la seule phrase de la fiche que le
> code confirme.

#### G. Le bloqueur décisif est **chez nous**, et aucune des deux configurations ne le referme

`src/mqtt-broker.ts`, `createAedesAuthorizePublishHook`, extrait **littéral** :

```ts
if (c.role === INTERNAL_BRIDGE_ROLE) return cb(null);
const org = c.org;
if (!org) return cb(new Error("MQTT client missing org"));
const prefix = `coordinator/${org}/`;
if (!packet.topic.startsWith(prefix)) {
  logger.warn({ client_id: c.id, org, topic: packet.topic },
    "MQTT publish denied (cross-org) — client will be disconnected");
  return cb(new Error("Cross-org publish denied"));
}
cb(null);
```

**L'autorisation se fait par préfixe d'org, et uniquement par là.** Aucune ACL par topic, aucune par
identité. Et `docs/mqtt-topics.md` l. 23 le dit en gras :

> « **The coordinator publishes EVERYTHING under a hardcoded org `default`.** »

confirmé l. 246 : « **No per-org MQTT routing.** The publisher org is hardcoded to `default` ».

**Conséquence, et c'est le résultat le plus dur du challenge :** même avec
`COORDINATOR_AUTH_ENABLED=true`, **tout détenteur d'un token quelconque peut publier un verdict
`allow` forgé** — puisque tous partagent l'org `default` et que le préfixe est la seule barrière.
Or l'agent B, celui dont on veut précisément refuser l'écriture, **possède nécessairement un token**.

> **Le mécanisme est contournable par construction par l'acteur exact qu'il prétend contraindre.**

Ce n'est pas une attente chez Anthropic. C'est un défaut de notre modèle de confiance, prouvé par
lecture de code — et il rend le bénéfice n°1 de §4 (« transformer un avertissement en refus »)
inatteignable tant que le broker ne sait pas dire *qui* a le droit de publier *quoi*.

#### H. Le classement des deux topologies de §6.1 s'**inverse**

§6.1 suppose que les deux topologies sont également sûres et ne diffèrent que par la latence et la
richesse de la politique. Elles ne sont pas également sûres, et l'ordre est l'inverse de l'intuition :

| Topologie | Politique | Sécurité |
|---|---|---|
| **Verdict local** dans `cli/channel.ts` | pauvre — pas d'accès à `working_files` | **sûre** : le verdict ne transite jamais par le bus, donc aucun tiers ne peut l'usurper |
| **Verdict par le daemon** | riche — `working_files` + `conflict-detector` + audit | **usurpable** : le verdict transite par un topic qu'aucune ACL ne protège par identité (§G) |

**La topologie riche est la topologie usurpable.** C'est la vraie tension de §6.1, et ce n'est ni la
latence ni même « le modèle d'authentification » en général : c'est que la politique la plus complète
est celle qui expose le verdict au bus.

#### C. La latence ne départage rien — §6.1 pose un faux dilemme

Aller-retour sur le bus, publieur et abonné anonymes, `n = 20` :

```
  min 0.26 | median 0.33 | p95 0.58 | max 1.01 ms
```

§6.1 oppose « verdict local » et « aller-retour daemon » en supposant qu'on « perd la course contre
le dialogue terminal dès que l'humain est plus rapide ». **La course n'est pas serrée** : un tiers de
milliseconde de bus contre le temps qu'un humain met à lire une description d'outil et à décider —
de l'ordre de la seconde. Trois ordres de grandeur.

> 🔴 **Corrigé après la passe adversariale — j'ai mesuré un proxy commode et je l'appelais
> « l'aller-retour daemon ».** Le cycle réel compte **huit sauts** (stdio ×2, bus ×2, handler,
> politique, sérialisation) ; j'en ai chronométré **un**, avec un client de test aux deux bouts.
>
> Pire : **le daemon ne pouvait pas être à l'autre bout.** `src/mqtt-bridge.ts` ne souscrit qu'à
> trois motifs — `coordinator/+/agents/+/status`, `coordinator/+/consultations/#`,
> `coordinator/+/broadcast` — et tout topic hors de ceux-là est classé `unroutable_topic` (l. 477).
> Aucun topic de permission n'y figure. **J'ai chronométré un broker qui se parle à lui-même.**
>
> **K3 n'est donc pas adjugeable** : ce n'est pas « non déclenché », c'est *non mesuré*. Ce que le
> chiffre établit reste vrai : le transport n'est pas le goulot, à trois ordres de grandeur du temps
> de réaction humain. Ce qu'il n'établit pas : que le cycle complet tienne dans le budget.
>
> **Et le vrai mode de défaillance n'est pas la lenteur, c'est le silence.** Chaque publication du
> bridge commence par `if (!this.client || !this.connected) return;` — pendant une déconnexion MQTT,
> l'émission est un **no-op silencieux** ; une réception sans listener est droppée (`no_listener`,
> l. 208). Un verdict qui ne part pas laisse le dialogue local trancher seul : **la politique échoue
> en ouvert.** C'est ça qu'il aurait fallu mesurer.

Réserve honnête, et elle compte : **je n'ai pas mesuré le cycle complet.** Ma mesure est un
aller-retour de broker, pas « demande reçue → `WorkingFilesTracker.getIndex()` + `ConflictDetector.detect()`
→ verdict republié ». Il manque le coût du handler, la requête SQLite et la sérialisation. Ce que la
mesure établit, c'est que **le transport n'est pas le goulot** — pas que le cycle complet tient dans
le budget. **K3 ne se déclenche pas sur ce qui a été mesuré**, et je note explicitement ce qui ne
l'a pas été.

Conséquence pour la question de §6.1 : le critère de choix entre les deux topologies n'est **pas** la
latence. C'est le modèle d'authentification (§B).

#### D. Côté client : une **seconde** porte runtime, que la fiche ignore

Vérifié dans `claude.exe` 2.1.233 :

```js
function Vzf(){ return rt("tengu_harbor_permissions", !1) }
```

C'est un feature flag **distinct** de celui des channels (`tengu_harbor`, également par défaut à
`false`, établi en `C03`). Le relais de permission est donc **doublement fermé** côté Anthropic, et
`Xzf` exige en plus que le serveur déclare **les deux** capabilities *et* que
`protocolEra !== "modern"`. **K4 ne se déclenche pas : la porte existe bien.**

Schéma du verdict, vérifié littéralement :

```js
params: be({ request_id: F(), behavior: Mr(["allow","deny"]) })
```

**Exactement deux champs.** Aucun `deny_message` — §2 est confirmée par le code, pas seulement par la
doc. L'alphabet du `request_id` est `FvS = "abcdefghijkmnopqrstuvwxyz"` : 25 lettres, pas de `l`,
conforme à `[a-km-z]{5}`.

#### E. Côté dépôt : le bus ne sait pas corréler, et le typage est fermé

```
$ grep -c 'request_id\|correlat\|responseTopic' src/mqtt-bridge.ts
0
```

**Zéro.** Le bridge ne modélise que de l'événementiel unidirectionnel — §5 avait raison. Une demande
de permission est une **requête corrélée qui attend une réponse** : c'est un mécanisme entièrement à
construire, pas une extension.

`src/types.ts` l. 94-110 : `EventType` est une union fermée de **16** valeurs, aucune liée aux
permissions. `ConflictReport.severity` (l. 122) n'a pas de valeur bloquante.

#### F. Aucune demande d'opérateur — K6 se déclenche

```
$ gh issue list --state all --search "permission"
OPEN   #328 [swoofer] docs(channels): la surface ne se charge sur aucune installation stock…
CLOSED #130 [swoofer] feat(channels): integrate as Claude Code Channel…
CLOSED #75  [swoofer] bug: tree-sitter optionalDependencies…
```

Aucune issue tierce. Et `HANDOFF.md` contient déjà, écrite par le mainteneur :

> « **Channels Phase 3 (permission relay)** — intentionally deferred per #139's reference-plugin
> study. The `claude/channel/permission` capability needs a sender allowlist to be safe, and the
> loopback-MQTT trust model doesn't have one. **Don't accidentally re-spike this without a concrete
> operator request.** »

Le challenge confirme cette note par la mesure : le modèle de confiance loopback n'a effectivement
aucune allowlist d'expéditeur (§A et §G), et aucune demande n'est arrivée. Commande exacte :
`gh issue list --state all --search "permission" --limit 20`.

#### I. Le binding loopback n'atténue rien **ici**

Le broker n'écoute que sur `127.0.0.1` (vérifié : `TCP 127.0.0.1:1883 LISTENING`, idem pour le
daemon de test sur 18899). Dans le cas général, ça réduit fortement la surface : un attaquant qui a
déjà l'exécution locale a largement gagné par ailleurs.

**Mais ce raisonnement ne s'applique pas au relais de permission**, parce que l'adversaire de ce
modèle de menace précis est **l'agent qu'on veut contraindre** — un processus local par définition,
qui possède un token, et qui a un intérêt direct à publier `allow`. Le binding loopback ne le gêne
pas d'un iota. C'est ce qui distingue cette fiche des autres discussions de sécurité du dépôt.

#### J bis. Ce que j'ai réellement démontré : un tiers anonyme met un agent hors ligne

Ma maquette de « verdict forgé » était une mise en scène — le topic `permissions/verdict` n'existe
nulle part. Voici la même attaque sur du code **livré**, mesurée de bout en bout :

```
1) enregistrement d'un agent legitime
   {"id":"victime-c04","org_id":"default","status":"online",…}
2) etat avant : "status":"online"
3) publication ANONYME de {status:offline} sur coordinator/default/agents/victime-c04/status
4) etat apres : "status":"offline"
```

Un client MQTT **anonyme, non authentifié**, a fait basculer un agent vivant. Et la branche qui
traite ce message (`src/mqtt-bridge.ts` l. 190-194 → `onOfflineHandler`, câblé en
`src/serve-http.ts` l. 999-1006) appelle aussi `consultation.handleAgentDeparture()` **et
`workingFiles.clearForAgent()`** — dont la doc interne dit « DELETE that org rows for agent ».

**Un tiers peut donc effacer les claims de fichiers d'un agent vivant** : exactement l'état sur
lequel §4 veut adosser l'auto-deny. Le socle de la feature est mutable par n'importe qui.

**Honnêteté sur la nouveauté :** ce n'est **pas** une faille inconnue.
`docs/security/threat-model.md` l. 17 déclare explicitement l'auth du broker hors périmètre
(« Phase 1 still trust-on-first-connect »), et `docs/mqtt-topics.md` l. 66-68 annonce le broker
anonyme par défaut. **Mon critère K2 était donc mal écrit** : il testait une chose déjà publiée dans
la doc. Ce qui n'est écrit nulle part, en revanche, c'est la **conséquence** — et surtout le fait que
`docs/usage.md` l. 40-49 documente une recette « Team setup — shared coordinator on LAN » avec
`COORDINATOR_BIND=0.0.0.0` **sans un mot sur l'authentification**. Le broker TCP est bien cloué au
loopback (`tcpServer.listen(tcpPort, "127.0.0.1", …)`, en dur), mais la **jambe WebSocket** est
greffée sur le serveur HTTP, lui gouverné par `COORDINATOR_BIND`. Dans ce profil documenté,
`ws://<hôte>:3100/mqtt` est ouvert à tout le LAN.

Et le binding loopback n'atténue rien pour **cette** fiche : l'adversaire du modèle de menace est
l'agent qu'on veut contraindre — local par construction, porteur d'un token, et intéressé à publier
`allow`.

#### J ter. « Il suffit d'activer l'auth » n'est pas praticable

Deux raisons, l'une prouvée en §G, l'autre dans notre propre code :

1. Sous `AUTH_ENABLED=true`, **le verdict forgé passe toujours** : l'ACL n'autorise que par préfixe
   d'org, l'org est toujours `default`, donc tout agent authentifié de l'org publie le même verdict.
   Seul le *cross-org* est bloqué.
2. `cli/channel.ts` l. 425-430 s'abonne avec un **wildcard d'org** :
   ```ts
   const TOPICS = [
     "coordinator/+/consultations/new",
     "coordinator/+/consultations/+/messages",
     "coordinator/+/agents/+/status",
   ];
   ```
   Or `createAedesAuthorizeSubscribeHook` teste `startsWith("coordinator/<org>/")`, faux pour un
   `+`. **Activer l'auth casse aujourd'hui les abonnements du processus channel lui-même.**

#### J quater. Le broker n'est même pas le chemin le plus court

`src/tools/mqtt-tools.ts` expose un outil `mqtt_publish` : tout appelant MCP publie une charge
arbitraire dans son org. En profil ouvert, les claims sont synthétiques — un simple appel HTTP non
authentifié a donc le même pouvoir **sans jamais toucher le broker**. Durcir le broker seul ne
fermerait pas le trou.

#### J. Adjudication des sept critères de mort

| | Statut | Sur quoi |
|---|---|---|
| **K1** | 🔴 **DÉCLENCHÉ** | contrat hôte inatteignable (acquis `C03`) + double porte runtime (§D). Interdit `adopter`. |
| **K2** | 🟢 non déclenché — mais **mal écrit** | le broker accepte l'anonyme, distribution prouvée (§A). Mais K2 testait un fait **déjà publié** dans `docs/mqtt-topics.md` l. 66-68 et assumé par le threat-model. Un critère de mort qui interroge la documentation au lieu du comportement ne mesure rien. Le résultat qui compte est ailleurs (§G, §J bis). |
| **K3** | ⚫ **NON ADJUGEABLE** | l'instrument fonctionnait mais mesurait autre chose que le critère. Ni « déclenché », ni « non déclenché » : *non mesuré*. |
| **K4** | 🟢 non déclenché — mesuré | `tengu_harbor_permissions` existe bien dans le binaire (§D). |
| **K5** | 🔴 **DÉCLENCHÉ** | **≈ 22 fichiers contre un seuil de 15.** Conséquent pré-enregistré : **`refuser`, pas `reporter`.** Décompte ci-dessous. |
| **K6** | 🔴 **DÉCLENCHÉ** | aucune demande d'opérateur (§F), et `HANDOFF.md` porte déjà la consigne. |
| **K7** | 🔴 **DÉCLENCHÉ** | verdict à deux champs, aucun motif possible (§D). Le bénéfice n°1 de §4 est donc surévalué : on obtient un refus que l'agent ne peut ni lire ni corriger. |

**Décompte K5.** §5 nomme 11 fichiers, dont 2 explicitement « rien à changer »
(`working-files-tracker.ts`, `files-tools.ts`) → **9**. S'y ajoutent, imposés par le code et vérifiés :

`src/http/rest-handlers.ts` (c'est **là** que vivent les handlers `/api/…` et l'émission
d'événements — `task_claimed`/`token_usage` y apparaissent, et **zéro fois** dans `serve-http.ts` :
**§5 pointe le mauvais fichier**) · `docs/mqtt-topics.md` (se déclare « **canonical reference** for
every topic ») · `cli/init.ts` (**nommé par §6.5 elle-même**, jamais compté par §5) · un module de
corrélation neuf — `waitForMessage` est un rendez-vous **par agent**, pas par `request_id` ·
`docs/operating-modes.md` · `README.md` · `docs/usage.md` · `SECURITY.md` (une capability qui
approuve un `Bash` arbitraire est un item de modèle de menace) · **`docs/index.html` — 7 éditions par
chaîne, mesuré** · `tests/unit/cli-channel.test.ts` (assert la forme exacte des `capabilities`, donc
cassé par l'ajout d'une clé) · `tests/integration/channel-smoke.test.ts` et
`tests/helpers/channel-test-harness.ts` (le harnais **capture** des notifications sortantes, il ne
sait pas en **injecter** une entrante) · tests neufs corrélation/timeout/reconnect ·
`examples/channels-quickstart/`.

**≈ 22 fichiers, soit 1,5× le seuil.** Et je me suis fait prendre par **le mécanisme exact de
`C03`** : compter la table §5, écrite par une veille qui ne lit que le code source, en oubliant les
surfaces de doc multilingues et les tests. Vingt-quatre heures après avoir écrit que c'était mon
erreur, je l'ai refaite.

#### K. §5 a déjà dérivé en 48 h

§0 se prévaut d'une vérification « ligne à ligne » du 2026-08-14. Au 2026-08-16, trois ancrages sont
faux : `src/conflict-detector.ts` fait **187** lignes et non 153 ; `getIndex()` est en **125** et non
117 ; le bloc `capabilities` de `cli/channel.ts` est en **314-320** et non 311-317. Cause : les
commits du 2026-08-15, dont la migration SDK v2. Une §5 qui dérive en deux jours est un mauvais
support de décompte — raison de plus de ne pas s'y fier seule pour K5.

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Research preview sur une surface propriétaire.** Le protocole channel n'est pas dans la spec MCP : il ne concerne que Claude Code. Les noms de méthodes et la forme des `params` peuvent changer sans préavis, comme le note déjà l'en-tête de `cli/channel.ts` à propos de `post_to_thread`. Toute une console d'approbation adossée à une API preview est un pari sur la stabilité.

- **La course rend la garantie probabiliste.** Le dialogue local reste ouvert : le premier verdict gagne. Une politique de sécurité qui ne s'applique que quand le coordinateur bat l'humain à la vitesse n'est pas une politique de sécurité, c'est un nudge rapide. Vendre ça comme un contrôle d'accès serait malhonnête, et un aller-retour MQTT vers le daemon dégrade encore le pari.

- **Pré-requis d'authentification non satisfait aujourd'hui.** `buildChannelServer()` se connecte au broker anonymement par défaut. Déclarer la capability dans cet état donne à quiconque atteint le broker local le pouvoir d'approuver un `Bash` arbitraire dans la session d'un autre agent. Le chantier n'est donc pas « ajouter une clé de capability » mais « rendre l'auth MQTT obligatoire sur ce chemin », ce qui touche `cli/init.ts`, `cli/doctor.ts` et la doc d'installation.

- **Le bus n'est pas requête/réponse.** `src/mqtt-bridge.ts` publie des événements ; il n'y a aucune corrélation de requête, aucun timeout, aucune reprise. Introduire un premier motif requête/réponse corrélé sur `request_id` avec expiration, c'est une nouvelle classe de complexité (états en attente, fuites si l'agent meurt, comportement au reconnect MQTT) dans un composant aujourd'hui simple.

- **Coût pour l'auto-hébergeur.** Le relais n'a de valeur que si quelqu'un regarde le dashboard. Pour l'utilisateur solo — le profil dominant du projet — c'est un panneau de plus qui ne servira jamais, et un flag `--dangerously-load-development-channels` de plus dans la doc d'installation. YAGNI s'applique franchement en dessous de trois agents concurrents.

- **Surface d'attaque nouvelle sur du texte non fiable.** `description` et `input_preview` viennent du modèle. Les afficher dans le dashboard, c'est du contenu d'origine LLM rendu dans une page où un humain clique « approuver » : injection visuelle, XSS si le rendu est négligent, et l'humain qui approuve sur la foi d'un résumé qu'un agent contrôle partiellement. La sanitation v2.1.211 réduit le risque typographique, pas le risque sémantique.

- **Deux surfaces divergentes à maintenir.** Le pendant managed-agents (`user.tool_confirmation`, `permission_policy`) a une forme différente et un `deny_message` que le channel n'a pas. Couvrir les deux, c'est deux implémentations de la même idée ; n'en couvrir qu'une, c'est une capacité qui ne marche que dans un contexte d'exécution sur deux.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-16 |
| **Justification** | **K5 déclenché** (≈22 fichiers contre un seuil pré-enregistré de 15) : son conséquent littéral est `refuser`, pas `reporter`. Et surtout, la raison est **interne** : l'ACL du broker n'autorise que par **préfixe d'org**, l'org est toujours `default`, donc un verdict `allow` est publiable par **l'agent même qu'il doit contraindre** — avec ou sans `COORDINATOR_AUTH_ENABLED`. Mesuré : un client anonyme met un agent vivant hors ligne et déclenche `clearForAgent()` sur ses `working_files`, c'est-à-dire efface le socle sur lequel §4 veut fonder l'auto-deny. K1, K6 et K7 se déclenchent également. |
| **Issue / PR** | [#330](https://github.com/swoofer/mcp-coordinator/issues/330) — le trou d'autorisation, traité **séparément** et pour lui-même |
| **Jalon visé** | aucun |

### Pourquoi `refuser` et non `reporter`

C'est un changement de verdict en cours de challenge, et il mérite d'être justifié.

`reporter` serait le réflexe : la feature est fermée côté Anthropic par **deux** feature flags, on
pourrait donc « attendre que ça ouvre ». Ce serait déplacer la responsabilité chez le fournisseur
alors que **le bloqueur décisif est chez nous**. Même si Anthropic ouvrait les deux portes demain,
le relais resterait inutilisable : le verdict transite par un bus dont l'autorisation ne sait pas
distinguer *qui* publie *quoi*, et l'acteur hostile du modèle de menace — l'agent contraint — est
précisément un client légitime de ce bus.

S'y ajoutent trois faits qui achèvent le dossier :

- **Le bénéfice n°1 de §4 est surévalué** (K7). Le verdict est `{request_id, behavior}`, deux champs,
  **aucun motif**. « Transformer un avertissement en refus » livre à l'agent un refus qu'il ne peut
  ni lire ni corriger — il retente, contourne, ou abandonne. Aucun des trois n'est de la
  coordination.
- **La politique échouerait en ouvert.** Les publications du bridge sont des no-op silencieux quand
  la connexion MQTT est tombée, et une réception sans listener est droppée. Un verdict qui ne part
  pas laisse le dialogue local trancher seul. Pour un mécanisme de sécurité, c'est le mauvais sens de
  défaillance.
- **Ce challenge n'a rien découvert que `HANDOFF.md` ne disait déjà** : « needs a sender allowlist to
  be safe, and the loopback-MQTT trust model doesn't have one ». Reporter une chose déjà reportée par
  écrit, avec la même motivation, ce n'est pas trancher.

### Ce qui est refusé, exactement

Le relais tel que la fiche le décrit : **verdict rendu par le daemon** + **console d'approbation dans
le dashboard**. C'est-à-dire la topologie « riche », celle de §6.1.

### Ce qui n'est pas refusé

- **La question de l'autorisation MQTT**, qui sort de cette fiche et devient un chantier autonome :
  [#330](https://github.com/swoofer/mcp-coordinator/issues/330). Elle a de la valeur **hors** channels
  — c'est elle qui permet aujourd'hui à un tiers d'effacer les `working_files` d'un agent vivant.
- **La topologie « verdict local »**, si la question revient un jour. §H montre que le classement
  s'inverse : le verdict local est *plus sûr* (il ne transite jamais par le bus) au prix d'une
  politique pauvre. Ce n'est pas ce que la fiche proposait, et personne ne l'a demandé — mais c'est
  la seule variante qui ne soit pas cassée par construction.

### Condition de réouverture

Trois conditions **conjointes**, dont une seule dépend de nous :

1. une ACL MQTT **par topic et par identité** dans le broker maison (#330) — *chez nous* ;
2. `tengu_harbor_permissions` ouvert, ou une entrée d'allowlist obtenue — *chez Anthropic* ;
3. une **demande concrète d'opérateur**, au sens de `HANDOFF.md`.

### Note de méthode

Mon verdict projeté était `reporter`, et j'allais commettre deux fautes que la passe adversariale a
arrêtées. D'abord j'allais **affaiblir** §5 : je m'apprêtais à rétrograder son « pré-requis
bloquant » en « dilemme opérationnel », alors que le code montre que §5 avait raison et qu'elle était
même trop faible. Ensuite j'ai sous-compté les fichiers **par le mécanisme exact du challenge `C03`
de la veille** — en me fiant à la table §5 et en oubliant les surfaces de doc multilingues et les
tests. Vingt-quatre heures après avoir écrit que c'était mon erreur, je l'ai refaite.

Ma mesure de latence, enfin, était un proxy commode : j'ai chronométré un broker qui se parle à
lui-même et je l'ai appelé « l'aller-retour daemon », alors que le bridge ne souscrit à aucun topic
de permission et n'aurait pas pu être à l'autre bout.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 confirmée, marqueur deny_message tranché, date v2.1.211 levée, deux lignes corrigées. |
| 2026-08-16 | **Challenge — verdict `refuser`.** K1, K5, K6 et K7 déclenchés ; K3 non adjugeable. Raison **interne** et prouvée : l'ACL du broker n'autorise que par préfixe d'org (`src/mqtt-broker.ts` l. 207-223) et l'org est toujours `default` (`docs/mqtt-topics.md` l. 23), donc un verdict `allow` est publiable par l'agent même qu'il doit contraindre — avec ou sans `COORDINATOR_AUTH_ENABLED`. Mesuré : un client MQTT anonyme fait basculer un agent vivant en `offline`, ce qui déclenche `clearForAgent()` sur ses `working_files` — le socle de l'auto-deny est mutable par un tiers → issue #330. Côté client, découverte d'une **seconde** porte runtime `tengu_harbor_permissions` (défaut `false`) que la fiche ignorait, et confirmation du verdict à deux champs (aucun `deny_message`). §6.1 pose un faux dilemme : la latence ne départage rien (0,33 ms de bus contre ~1 s humain), et le classement des deux topologies s'**inverse** — la politique riche est la topologie usurpable. Corrections portées : §5 avait déjà dérivé (conflict-detector 187 l. et non 153, getIndex l. 125, capabilities l. 314-320) et pointait le mauvais fichier pour les handlers REST (`src/http/rest-handlers.ts`). Verdict projeté `reporter` **renversé** par la passe adversariale. |
