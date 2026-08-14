# C04 — Relais de permission : le dashboard devient console d'approbation

| Champ | Valeur |
|---|---|
| **ID** | `channel-permission-relay` |
| **Surface** | claude-code (surface secondaire : managed-agents) |
| **Statut** | research-preview (le pendant managed-agents est en `beta`) |
| **Disponible depuis** | documenté dans `channels-reference` · sanitation des champs relayés à partir des clients v2.1.211 (un chercheur date cette version au 15 juil. 2026, les deux autres ne donnent pas de date — voir §3) |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — volet channel testable en local, volet managed-agents non |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 confirmée, marqueur deny_message tranché, date v2.1.211 levée, deux lignes corrigées. |
