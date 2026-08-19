# C05 — Outil `Monitor` et transport MCP `ws` : le plan B du push, sans allowlist

| Champ | Valeur |
|---|---|
| **ID** | `monitor-websocket-push` |
| **Surface** | claude-code |
| **Statut** | Mixte. L'outil `Monitor` et sa source WebSocket sont documentés sans marqueur beta/preview (**GA**), tout comme le transport MCP `type: "ws"` (**GA**). En revanche les *monitors de plugin* (`experimental.monitors`) sont explicitement un « experimental component ». Le statut n'est donc pas uniforme sur toute la surface. |
| **Disponible depuis** | Source WebSocket de `Monitor` : **Claude Code v2.1.195** (note de version explicite dans la doc). L'outil `Monitor` lui-même est antérieur et non daté officiellement (des sources tierces avancent ~v2.1.98, non confirmé). Transport MCP `ws` : non daté, présent dans la référence MCP à jour août 2026. |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED sur l'existence et la surface d'API — le *cas d'usage* revendiqué (s'abonner au daemon en loopback) reste PLAUSIBLE tant qu'un test réel n'a pas levé le garde-fou « adresses privées ». |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — le test `type: "ws"` distant exige un endpoint public TLS. **Précision du 2026-08-16 :** l'appel `Monitor` sur loopback n'est pas exécutable **par un agent** non plus — il déclenche une approbation humaine bloquante. Tranché par lecture du client livré + un appel réel sur adresse bloquée. |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `refuser` : 6 critères de mort sur 7 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

Le cœur factuel tient : `Monitor` + source WebSocket et le transport MCP `type: "ws"` existent
bien, sans marqueur beta, aux ancres citées ; les garde-fous réseau, l'absence d'OAuth sur `ws`,
le refus de `--transport ws`, le statut « experimental component » des monitors de plugin et
l'indisponibilité Bedrock / Google Cloud Agent Platform / Microsoft Foundry sont confirmés mot
pour mot par `code.claude.com/docs`. Les corrections portent sur un détail inventé et sur des
numéros de ligne du repo.

**Corrections apportées :**

- §1 et §2 — « un monitor qui produit trop d'événements est arrêté automatiquement » : **aucune
  coupure « too many events » n'est documentée**. La doc n'énumère que quatre comportements de
  flux (message texte = 1 événement, frame binaire → placeholder, message > 1 MiB → fin de watch,
  fermeture du socket → fin de watch avec close code). Mention retirée de §1.
- §2 — `timeout_ms` (défaut 300000 / max 3600000) : marqueur tranché en `(non vérifiable)`, la doc
  ne publie pas le schéma d'entrée de `Monitor`. Idem pour `description` et `persistent`, dont
  seuls les noms sont attestés (§ « WebSocket source » cite `timeout_ms` et `persistent`).
- §2 — marqueur `(à vérifier)` sur `headersHelper` levé : ce n'est pas une API, la doc précise que
  `headersHelper` exécute une commande shell arbitraire dont la sortie JSON est fusionnée dans les
  en-têtes de connexion.
- §2 — fait ajouté, utile au point d'intégration `doctor` : les serveurs WebSocket **n'apparaissent
  pas dans `claude mcp list`** (`claude mcp get <name>` ou le panneau `/mcp`).
- §2, point 3 — nuance : `ReadMcpResourceDirTool` est bien absent de `tools-reference.md` (seuls
  `ListMcpResourcesTool` et `ReadMcpResourceTool` y figurent), mais le nom existe dans certaines
  distributions de l'outillage ; l'écarter comme « imaginaire » serait excessif, il est simplement
  non documenté.
- §5 — numéros de ligne recalés : `mqtt-broker.ts` 316-334 (et non 317-334) ; `serve-http.ts`
  `handleSse` 326-382, fallback `?token=` 327-330, démarrage broker 936-941 (et non « l. 927 »),
  annonce des endpoints 1412-1424 dont `sse:` en 1417 ; `sse-emitter.ts` 22-28 / 116-129 ;
  `doctor.ts` check `mqtt-<port>` en 956-968 (la commande commence en 825).
- §5 — vérifiés exacts, laissés tels quels : `cli/init.ts:195-202` (snippet `{ type: "http", url }`),
  `cli/channel.ts:1-35` (mention `--dangerously-load-development-channels` + `post_to_thread`),
  `package.json` `ws@^8.21.0` en dépendance directe, `examples/channels-quickstart/` existe.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Claude Code local est en **v2.1.219**, au-dessus du plancher v2.1.195, et ni `DISABLE_TELEMETRY`
ni `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` ne sont posés : les tests 1, 2, 3 et 5 de §6.3
(loopback / localhost / IP LAN, endpoint `/events/ws` jetable, friction d'approbation) sont
exécutables ici, sans credential Anthropic particulier. Le test 4 ne l'est pas en l'état : il
demande un déploiement distant réel en `wss://` avec certificat valide et un `headersHelper`
branché sur `src/auth/`, donc un hôte public ou un tunnel TLS qui n'est pas garanti sur ce poste.

---

## 1. Ce que c'est

Deux mécanismes distincts, réunis ici parce qu'ils ouvrent le même chemin : pousser des événements dans une session Claude Code vivante sans passer par les Claude Code Channels (donc sans research preview, sans allowlist Anthropic, sans `--dangerously-load-development-channels`).

Le premier est l'outil built-in **`Monitor`** : il lance une commande en arrière-plan et réinjecte chaque ligne de sortie à Claude au fil de l'eau, sans mettre la conversation en pause. Depuis v2.1.195 il accepte un input `ws` **en remplacement de** `command` — jamais les deux dans le même appel — avec `url` (`ws://` ou `wss://`, ASCII, sans credentials embarquées ni espaces) et `protocols` (sous-protocoles offerts au handshake). Sémantique du flux : un message texte = un événement (même multiligne) ; une frame binaire est remplacée par un placeholder `[binary frame, N bytes]` ; un message > 1 MiB termine la watch ; la fermeture du socket termine la watch avec son close code. (La doc ne décrit aucune autre coupure : pas d'arrêt automatique « trop d'événements ».) `timeout_ms` et `persistent` s'appliquent comme en mode commande, et `TaskStop` annule.

Les garde-fous sont la partie importante. Claude Code **refuse** les URLs pointant vers une adresse privée, link-local ou de métadonnées cloud, y compris les hostnames qui y résolvent ; refuse les hôtes de `sandbox.network.deniedDomains` ; et, si `allowManagedDomainsOnly` est posé dans les managed settings, refuse tout hôte hors allowlist gérée. L'ouverture d'un WebSocket déclenche une approbation humaine **qui ne propose pas de « ne plus demander pour cet hôte »**. Le mode `command`, lui, hérite des règles de permission de `Bash`. Enfin l'outil est indisponible sur Amazon Bedrock, Google Cloud Agent Platform et Microsoft Foundry, ainsi que lorsque `DISABLE_TELEMETRY` ou `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` est défini — exactement le même type de restriction de plateforme que les channels.

Le second mécanisme est le **transport MCP `type: "ws"`**, quatrième transport après `stdio`, `http` (alias `streamable-http`) et `sse` (déprécié). La doc le décrit pour ce cas d'usage précis : une connexion bidirectionnelle persistante, adaptée aux serveurs MCP distants qui poussent des événements vers Claude sans sollicitation. Il se configure uniquement via `.mcp.json` ou `claude mcp add-json` — le flag `--transport` n'accepte pas `ws` — et accepte les mêmes champs que `http` (`url`, `headers`, `headersHelper`, `timeout`, `alwaysLoad`). Contrepartie documentée noir sur blanc : **l'authentification est header-only, WebSocket ne supporte pas OAuth**.

## 2. Surface d'API exacte

```
Outil Monitor (built-in, Permission required: Yes)
  description            string   (nom non documenté — schéma d'entrée non publié)
  timeout_ms             number   (non vérifiable : la doc atteste le nom, jamais le défaut ni le max)
  persistent             boolean  (nom attesté ; « la watch se termine à l'échéance sauf si persistent »)
  command                string   ─┐ mutuellement exclusifs
  ws                     object   ─┘ « A WebSocket watch takes a `ws` input in place of `command`,
    ws.url               string     and a single Monitor call can't combine the two. »
    ws.protocols         string[]
  annulation             → outil TaskStop

Garde-fous réseau
  sandbox.network.deniedDomains          (settings)
  allowManagedDomainsOnly                (managed settings)

Monitors de plugin (experimental component)
  plugin.json → experimental.monitors    OU  monitors/monitors.json
  champs : name, command, description, when ("always" | "on-skill-invoke:<skill-name>")

Transport MCP WebSocket (.mcp.json / claude mcp add-json)
  type: "ws"
  url, headers, headersHelper, timeout, alwaysLoad
  auth header-only (pas d'OAuth) ; `claude mcp add --transport` n'accepte pas `ws`
  absents de `claude mcp list` → utiliser `claude mcp get <name>` ou le panneau `/mcp`
  pas de timer par requête (contrairement à http/sse) ; idle timeout 5 min (v2.1.187+)
```

```jsonc
// .mcp.json — pas d'OAuth possible sur ce transport
{
  "mcpServers": {
    "coordinator": {
      "type": "ws",
      "url": "wss://coordinator.example.com/mcp",
      "headersHelper": "mcp-coordinator token print"   // exemple libre : headersHelper exécute une commande shell dont la sortie JSON est fusionnée dans les en-têtes
    }
  }
}
```

**Contradictions entre chercheurs, non tranchées :**

1. *Le loopback passe-t-il ?* Un chercheur soutient que `ws://127.0.0.1:PORT` est bloqué puisque la doc refuse « private, link-local, or cloud-metadata address ». Un autre note que le loopback strict n'est pas littéralement énuméré parmi ces trois catégories et pourrait donc passer. **Point non résolu par la doc.** C'est le test bloquant de §6.3.
2. *Un monitor de plugin peut-il s'abonner en `ws` au démarrage ?* Une fiche brute affirmait qu'`experimental.monitors` permettrait un abonnement WebSocket auto-démarré. Le vérificateur l'a réfuté : les monitors de plugin déclarent un `command` shell (`name`/`command`/`description`/`when`), la référence plugins **ne documente pas** de monitor à source `ws`.
3. Un chercheur a cité `ReadMcpResourceDirTool` : **non documenté** dans `tools-reference.md`, où seuls `ListMcpResourcesTool` et `ReadMcpResourceTool` figurent. Le nom apparaît toutefois dans l'outillage réel de certaines sessions ; le traiter comme inexistant serait faux, il est simplement hors référence publique et donc inutilisable comme appui de conception.

## 3. Sources

- https://code.claude.com/docs/en/tools-reference.md — ancres `#monitor-tool` et `#websocket-source`
- https://code.claude.com/docs/en/plugins-reference.md — section « Monitors »
- https://code.claude.com/docs/en/mcp.md — transports, dont `type: "ws"`

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Aujourd'hui, le seul chemin de push *dans une session Claude Code* est `cli/channel.ts` : un processus stdio séparé (21 Ko) qui s'abonne au broker MQTT du daemon et traduit chaque événement en `notifications/claude/channel`. Ce chemin est en research preview et exige `--dangerously-load-development-channels` tant que le plugin n'est pas sur l'allowlist Anthropic — c'est la friction d'adoption numéro un du projet. `/api/events` (SSE, `src/serve-http.ts:326`) sert le dashboard navigateur, pas une session d'agent.

Deux gains concrets, de valeur inégale :

- **`type: "ws"` dans `.mcp.json`** : un endpoint unique porte à la fois les 26 appels d'outils et le push non sollicité. Si ce chemin tient, `cli/channel.ts` et sa dépendance `mqtt` côté client disparaissent du parcours utilisateur nominal, et l'install se réduit à changer `"type": "http"` en `"type": "ws"` dans le snippet écrit par `cli/init.ts:195-202`. Le blocage est frontal : pas d'OAuth sur `ws`, ce qui entre en collision avec toute la Phase 2 (`src/auth/`, 4 IdP, device flow). Le seul recours documenté est `headersHelper` pour fabriquer un JWT au moment de la connexion.
- **`Monitor` avec source `ws`** : n'importe quelle session s'abonne à un flux d'événements du daemon sans plugin, sans allowlist, sans admin d'org. Bénéficiaire direct : l'utilisateur Windows en self-host, pour qui le chemin channel est le plus pénible. Mais l'approbation manuelle **à chaque ouverture de socket, sans mémorisation par hôte**, en fait un outil de session interactive, pas un abonnement permanent.

Point technique découvert dans le repo, décisif pour le chiffrage : l'endpoint WebSocket existant (`src/mqtt-broker.ts:317-334`, monté sur l'upgrade HTTP au chemin `/mqtt`) transporte du **MQTT, protocole binaire**. `Monitor` remplace les frames binaires par `[binary frame, N bytes]` : il ne peut donc **pas** consommer l'endpoint existant. Il faudrait un second endpoint WebSocket texte (une ligne JSON = un message) republiant `SseEmitter`. Ce n'est pas gratuit, d'où l'effort **M** plutôt que **S** annoncé par les trois chercheurs.

**Risque si on ne fait rien :** le push en session reste conditionné à une allowlist Anthropic sur laquelle le projet n'a aucune prise, et à un flag `--dangerously-*` que peu d'utilisateurs accepteront de taper. Le coordinateur continue d'être un serveur d'outils que l'agent doit *interroger*, alors que toute sa valeur est de le *prévenir* d'un conflit de fichier ou d'une consultation entrante.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/mqtt-broker.ts` (l. 5, 316-334 ; `new WebSocketServer` l. 320, hook `upgrade` l. 325) | `WebSocketServer({ noServer: true, maxPayload: MQTT_WS_MAX_PAYLOAD_BYTES })` + hook `httpServer.on("upgrade")` sur `wsPath` : la plomberie d'upgrade existe déjà, un second chemin (`/events/ws`) se greffe sur le même hook. Mais le flux actuel est MQTT binaire, inconsommable par `Monitor`. |
| `src/serve-http.ts` (l. 83 `MQTT_WS_PATH`, l. 326-382 `handleSse`, l. 936-941 démarrage broker, l. 1412-1424 annonce) | `handleSse` fait déjà l'auth (`authenticateRequest` l. 331), le scoping `org_id` (l. 346) et la reprise `Last-Event-ID` (l. 366-374) ; l'abonnement est `services.sseEmitter.addListener(orgId, …)` l. 378 — un émetteur WS texte réutilise exactement ce chemin. Le bloc d'annonce des endpoints affiche déjà `sse:` (l. 1417) et `ws://…${mqttWsPath}` (l. 1420-1421) — il devrait annoncer l'URL d'événements. |
| `src/sse-emitter.ts` (l. 22-28, 116-129) | `addListener(orgId, listener)` est le point de branchement ; `MAX_SSE_CLIENTS` (défaut 100, `COORDINATOR_MAX_SSE_CLIENTS`) plafonne les abonnés — chaque session en `Monitor` consommerait un slot au même titre qu'un onglet dashboard. |
| `cli/channel.ts` (en-tête l. 1-35) | Le code candidat à la suppression. Son propre commentaire documente déjà la dépendance à `--dangerously-load-development-channels`. Attention : il porte aussi `post_to_thread` (le *retour* de Claude vers une consultation) ; `Monitor` est strictement unidirectionnel et ne le remplace pas. |
| `cli/init.ts` (l. 195-202) | Le snippet `.mcp.json` écrit en dur `{ type: "http", url }`. Une option `--transport ws` s'y insère en trois lignes. Rappel : `claude mcp add --transport` n'accepte pas `ws`, seul le fichier ou `add-json` fonctionne. |
| `src/auth/` + `serve-http.ts` l. 327-330 | `ws` est header-only, sans OAuth. Le fallback `?token=` déjà en place pour le SSE (EventSource n'envoie pas d'`Authorization`) est le précédent maison ; côté client MCP, `headersHelper` est l'alternative officielle. |
| `cli/doctor.ts` (`createDoctorCommand` l. 825 ; check `mqtt-<port>` l. 956-968) | Le check `mqtt-<port>` teste une simple joignabilité TCP (`tcpReachable(host, mqttPort)`). Un endpoint WS d'événements demanderait son propre check (handshake + premier message), sinon `doctor` valide un chemin de push muet. À noter : un serveur MCP `type: "ws"` n'apparaît pas dans `claude mcp list`, donc un check côté client devrait passer par `claude mcp get`. |
| `package.json` | `ws@^8.21.0` est déjà une dépendance directe (utilisée par `mqtt-broker.ts`) — aucune dépendance nouvelle à ajouter côté serveur. |
| `docs/mqtt-topics.md`, `docs/ARCHITECTURE.md`, `examples/channels-quickstart/` | Un troisième chemin de push doit être documenté et situé par rapport aux deux existants, sous peine de rendre le mode d'emploi illisible. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il remplacer `cli/channel.ts` par un chemin WebSocket sur le daemon — et si oui lequel : un `type: "ws"` dans `.mcp.json`, qui unifie outils et push mais fait perdre OAuth et donc la Phase 2, ou un endpoint `/events/ws` texte consommé par l'outil `Monitor`, qui préserve l'auth HTTP mais n'est pas prouvé fonctionnel en loopback et exige une approbation humaine à chaque connexion ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

**Ce que je crois qu'il va se passer.**

1. **Le loopback est refusé.** La contradiction n°1 de §2 se tranche contre l'optimiste : les
   garde-fous anti-SSRF regroupent en pratique loopback et RFC 1918 dans la même liste, même quand
   la prose ne cite que « private, link-local, cloud-metadata ». Et le refus tombera **avant** le
   prompt d'approbation.
2. Si c'est le cas, la moitié `Monitor` de la fiche est morte **pour notre profil de déploiement**,
   qui est majoritairement localhost ou LAN.
3. `type: "ws"` perd bien OAuth — donc il entre frontalement en collision avec la Phase 2, et le
   « remplacer `http` par `ws` en trois lignes » de §4 est une illusion.
4. `Monitor` reste de toute façon **unidirectionnel** : il ne remplace pas `post_to_thread`.

**Verdict pressenti :** `refuser` la branche `Monitor`, `reporter` la branche `type: "ws"`.

**Précaution de méthode.** Un appel `Monitor` réel sur une URL autorisée déclencherait une
**approbation humaine bloquante**, or ce challenge tourne en autonomie sans personne au clavier. Je
tranche donc le garde-fou **par lecture du binaire livré d'abord** — preuve de premier niveau, sans
risque de blocage — et je ne tente l'appel réel que si la lecture prédit un refus immédiat (donc
sans prompt).

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | le loopback est **refusé** | la branche `Monitor` est morte pour un produit auto-hébergé : `refuser`, sauf à exposer le daemon publiquement — ce qui est un changement de posture de sécurité, pas une option de confort. |
| **K2** | le loopback **passe** | la crainte centrale de §6.5 tombe, je dois l'écrire noir sur blanc, et le critère de décision devient la friction d'approbation. |
| **K3** | l'approbation n'offre **pas** de mémorisation par hôte | l'abonnement non supervisé est impossible ; `Monitor` est un outil de session interactive, pas un canal d'événements. |
| **K4** | `Monitor` est indisponible ici (plateforme, variable de désactivation) | `reporter` avec le blocage nommé, jamais `adopter`. |
| **K5** | le chantier dépasse **12 fichiers** | l'effort n'est plus M ; le gain ne justifie pas un **troisième** chemin de push chez un mainteneur unique. |
| **K6** | aucun utilisateur n'a demandé du push en session | filtre YAGNI : le besoin est supposé par la veille, pas constaté. |
| **K7** | `type: "ws"` perd réellement OAuth | la branche transport ne peut pas être `adopter` : elle imposerait soit de régresser sur la Phase 2, soit de maintenir deux chemins d'auth — donc plus de code, pas moins. |

### 6.3 Protocole de vérification

> ⚠️ Le quatrième test (`type: "ws"` sur un déploiement distant réel) n'est pas exécutable sur le poste de dev : il exige un endpoint public en `wss://` avec certificat valide. Les tests 1, 2, 3 et 5 le sont (Claude Code v2.1.219 ≥ v2.1.195, aucune variable de désactivation posée).

Proposition de la veille — le test 1 est bloquant : s'il échoue, la moitié `Monitor` de la fiche tombe et il ne reste que `type: "ws"` en déploiement distant.

- [ ] Démarrer le daemon en local et appeler `Monitor` avec `ws: { url: "ws://127.0.0.1:3100/mqtt" }` depuis une session Claude Code. Noter si le refus « private address » tombe **avant** ou **après** le prompt d'approbation, et le message exact.
- [ ] Rejouer le même appel avec `ws://localhost:3100`, puis avec l'IP LAN (`192.168.x.x`), puis avec un tunnel public en `wss://`, pour isoler laquelle des trois catégories refusées mord réellement.
- [ ] Ajouter un endpoint jetable `/events/ws` qui republie `SseEmitter` en JSON texte (une ligne = un message), et vérifier côté Claude qu'un message = un événement, que le plafond de 1 MiB n'est pas atteint par un payload de consultation, et que la coupure « too many events » ne se déclenche pas sur une rafale d'annonces simultanées.
- [ ] Écrire `{ "type": "ws", "url": "wss://…/mcp" }` dans `.mcp.json` sur un déploiement distant réel et vérifier que les 26 outils se listent, qu'une notification serveur arrive non sollicitée, et qu'un `headersHelper` peut injecter le JWT produit par `src/auth/`.
- [ ] Mesurer la friction d'approbation sur une session de travail réaliste : combien de ré-approbations manuelles après timeouts, reconnexions et redémarrages du daemon.

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233** (et non v2.1.219 comme le disait §0 — le poste a été
mis à jour depuis). Preuves : lecture du bundle JS embarqué dans `claude.exe`, plus un appel `Monitor`
réellement exécuté.*

> **Frontière exécuté / lu.** **Exécuté :** un appel `Monitor` sur une IP LAN, qui valide que je lis
> la bonne fonction. **Lu (code du client livré) :** tout le reste. **Délibérément non exécuté :**
> l'appel sur loopback — le code prédit un `behavior: "ask"`, donc une approbation humaine bloquante,
> et ce challenge tourne sans personne au clavier. Précaution pré-enregistrée en §6.2.

#### A. Le loopback est **explicitement exempté** — K1 ne se déclenche pas, K2 se déclenche

Prédicat IPv4, extrait littéral :

```js
function h4f(e){let t=e.split(".").map(Number),[r,n]=t;
  if(t.length!==4||…)return !1;
  if(r===127)return !1;                        // ← loopback : PAS privé
  if(r===0)return !0;
  if(r===10)return !0;
  if(r===169&&n===254)return !0;
  if(r===172&&n>=16&&n<=31)return !0;
  if(r===100&&n>=64&&n<=127)return !0;
  if(r===192&&n===168)return !0;
  return !1}
```

IPv6 : `function tSS(e){let t=e.toLowerCase(); if(t==="::1")return !1; if(t==="::")return !0; …}`.

Ce n'est pas un effet de bord. La fonction sœur du hook HTTP porte l'intention **en toutes lettres
dans le binaire livré** :

```
Loopback (127.0.0.1, ::1) is allowed for local dev.
```

**La contradiction n°1 de §2 est donc tranchée contre le pessimiste, et le premier contre-argument de
§6.5 tombe.** Mais la réponse est plus fine que ce qu'aucun des deux chercheurs n'envisageait :

| Adresse | Verdict |
|---|---|
| `127.0.0.0/8`, `::1` | ✅ **autorisé** |
| `10/8`, `172.16-31`, `192.168/16`, `100.64/10` | ❌ bloqué |
| `169.254/16` (link-local), `0.0.0.0/8`, `::` | ❌ bloqué |

**Le profil auto-hébergé sur localhost passe ; le profil « coordinateur partagé sur le LAN »
— celui que `docs/usage.md` documente — est exclu.**

#### B. Vérification exécutée, à risque nul

Le code place le refus dans la fonction de **permission** (`behavior: "deny"`), donc **avant** le
prompt. Un appel réel sur une adresse bloquée est donc sans danger :

```
Monitor({ ws: { url: "ws://192.168.1.10:3100/events/ws" } })
→ Monitor cannot open a WebSocket to 192.168.1.10: the address is in a private,
  link-local, or cloud-metadata range.
```

Retour **immédiat, sans prompt**, message identique au caractère près au template lu
(`Monitor cannot open a WebSocket to ${host}: ${detail}.`). Cela répond à la sous-question du test 1
de §6.3 — **le refus tombe avant l'approbation** — et confirme que je lis la bonne fonction.

#### C. 🔴 Le vrai tueur, que personne n'avait vu : le limiteur de débit et la troncature à 500 caractères

C'est le résultat qui décide de la fiche, et il n'apparaît nulle part dans la veille.

Le découpeur/limiteur `Fbi` est **partagé par les deux sources** (`command` et `ws`) — le chemin ws
appelle `f.onData(frame + "\n")` sur chaque frame texte. Constantes, extraites littéralement :

```js
var gXv=30000, $bi=500, fwf=3000, yXv=200, mwf=1048576;
var c4r=10, Wor=2000;
```

| Constante | Valeur | Effet |
|---|---|---|
| `yXv` | 200 ms | les frames sont agrégées en **lots** ; c'est le lot qui consomme un jeton |
| `c4r` / `Wor` | 10 / 2000 ms | seau à jetons : burst de 10 lots, recharge **1 jeton toutes les 2 s** → plafond soutenu ≈ **1 notification / 2 s** |
| `gXv` | 30 000 ms | **30 s de sur-débit continu → `killTask()`**, le monitor est arrêté |
| **`$bi`** | **500** | **toute ligne de plus de 500 caractères est coupée** et suffixée `...(truncated)`, *avant* de devenir un événement |
| `fwf` | 3000 | le lot agrégé est retronqué à 3000 caractères |

**Conséquence directe et fatale.** Le design proposé en §5 et au test 3 de §6.3 — « un endpoint
`/events/ws` qui republie `SseEmitter` en JSON texte, une ligne = un message » — **meurt dès qu'un
événement de consultation dépasse 500 caractères de JSON**, ce qui est le cas nominal, pas le cas
limite. Ce n'est pas le plafond de 1 MiB qui tue ce design : c'est **500 octets**.

Et le plafond 1 MiB lui-même est mal décrit par §1 : ce n'est pas « le message termine la watch »,
c'est un drop **puis** une fermeture explicite —
`[Dropped ${x}-byte frame (exceeds ${B8a}); closing]`.

> 🔴 **§0 a supprimé un fait VRAI.** Elle avait retiré la mention « un monitor qui produit trop
> d'événements est arrêté automatiquement » au motif qu'« aucune coupure n'est documentée ». Le
> mécanisme est bel et bien implémenté, il vaut pour la source `ws`, et ses messages sont en clair :
> `[N events suppressed — output rate too high…]` puis
> `[Monitor stopped — too much output (N events suppressed over Xs). Restart with a more selective
> source.]`. La description d'outil livrée au modèle le dit d'ailleurs aussi. **À rétablir en §1 et
> §2, avec les chiffres.**

#### D. 🔴 « GA » est faux : `Monitor` est derrière un feature flag distant

```js
function Oge(){ return rt("tengu_amber_sentinel", !1) }
```

`rt` lit une valeur de feature flag **distante, par défaut `false`**. La disponibilité de `Monitor`
n'est donc **pas** garantie par un plancher de version : c'est un interrupteur serveur, révocable
sans release. C'est aussi le mécanisme réel derrière la clause « désactivé sous `DISABLE_TELEMETRY` /
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` » — pas une vérification en dur, simplement un gate qui
retombe sur son défaut quand le trafic non essentiel est coupé.

**Troisième fiche consécutive où une surface annoncée GA/stable s'avère gouvernée par un flag runtime
à défaut `false`** — après `tengu_harbor` (`C03`) et `tengu_harbor_permissions` (`C04`).

#### E. Mon propre lemme était faux : la résolution DNS existe

J'avais conclu de `if (net.isIP(host) && rsr(host))` que **seuls les littéraux IP** sont testés, et
donc que §1 avait tort d'écrire « y compris les hostnames qui y résolvent ». **C'est moi qui avais
tort.** La résolution est ailleurs, dans l'exécuteur `oSS` :

```js
let o = await y4f.lookup(n, {all:!0});
for (let {address:a} of o)
  if (rsr(a)) throw new S5n(`${n} resolves to ${a}, which is in a private, link-local, or cloud-metadata range`);
```

**§1 a raison.** Il y a **deux étages** avec le **même** prédicat : le contrôle de permission
(`DTi`), puis le contrôle de connexion (`oSS`) qui, lui, résout le DNS. Le loopback franchit les
deux — ma conclusion tient, mais ma preuve était unijambiste.

Deux corollaires que ni §1 ni §5 n'énoncent :

1. **Un hostname qui résout vers du privé n'est pas refusé au stade permission.** L'humain approuve,
   *puis* la connexion échoue, avec un message différent. Deux étages, deux moments.
2. **`oSS` réécrit l'URL** hors `wss:` et hors proxy : il épingle l'adresse résolue et déplace le nom
   dans un en-tête `Host:` (anti-rebinding). `ws://localhost:3100/events/ws` part physiquement sur
   `ws://127.0.0.1:3100/…` avec `Host: localhost:3100` — un piège de plus si le daemon valide
   l'`Origin` ou le `Host`.

#### F bis. 🔴 Le schéma `ws` de `Monitor` n'a **aucun champ `headers`** — l'auth ne peut passer que par l'URL

Schéma complet de `ws`, vérifié sur l'outil réellement chargé : `url` et `protocols`. **C'est tout.**
Ni `headers`, ni `headersHelper` — ceux-là appartiennent au transport MCP `ws`, pas à `Monitor`.
§2 et §5 confondent les deux surfaces.

Conséquence non négociable : avec `AUTH_ENABLED=true`, le seul moyen d'authentifier un `/events/ws`
depuis `Monitor` serait `?token=<JWT>` dans l'URL — le fallback existant, `src/auth.ts` l. 516 :
« EventSource-compatible token transport: allow `?token=<JWT>` on GET requests ».

Or l'URL est recopiée **mot pour mot** dans le message d'approbation
(`Monitor will open a WebSocket to ${e.url}`), donc dans le transcript de session, donc dans
l'historique du modèle. Et ce projet a **déjà** classé cette famille de fuite en risque résiduel
accepté (`docs/security/threat-model.md`, `securite-auth-03`, avec `redactTokenParam()` pour colmater
ce qu'il contrôle) — la décision y étant motivée par le fait qu'EventSource n'a pas d'API d'en-têtes.
**Rejouer ce compromis pour un consommateur qui écrit le JWT dans un transcript LLM, ce n'est pas
invoquer un précédent : c'est aggraver un risque déjà classé.** L'alternative
(`Sec-WebSocket-Protocol`) serait un **troisième** chemin d'auth maison, dans un projet qui vient de
traiter #311 sur le rejet des JWT en `Authorization: Bearer`.

#### F ter. Un verrou de plus, absent de la fiche : `allow_web_fetch`

La **première ligne** de `wsEgressDenyReason` :

```js
if (!bs("allow_web_fetch")) return { kind:"compliance", host:"",
  detail:"arbitrary-URL egress is disabled by your organization's compliance policy" };
```

L'egress WebSocket de `Monitor` est donc gouverné par la capacité **`allow_web_fetch`**. Toute org
qui coupe WebFetch coupe `Monitor`-ws. Ce verrou **s'ajoute** à Bedrock / Google Cloud Agent Platform
/ Microsoft Foundry, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`sandbox.network.deniedDomains` et `allowManagedDomainsOnly`. **K4 se déclenche sur un motif que la
veille n'avait pas vu.**

#### F. Pas de mémorisation par hôte — K3 se déclenche

Quand l'URL est autorisée, la fonction de permission renvoie :

```js
{ behavior:"ask", message:`Monitor will open a WebSocket to ${e.url}${r}`, suggestions: [] }
```

**`suggestions` est un tableau vide** : aucune option « ne plus demander pour cet hôte ». Combiné à
« socket close ends the watch », chaque redémarrage du daemon, chaque coupure réseau et chaque
expiration de `timeout_ms` (défaut **300 000 ms**, max **3 600 000 ms**, vérifiés) impose une
**nouvelle approbation humaine**. Un abonnement d'événements censé survivre à l'inattention de
l'utilisateur ne survit pas à la sienne.

#### G. K5 : 26 fichiers pour un seuil à 12 — et §5 se trompe sur le point d'accroche

§5 affirme que « la plomberie d'upgrade existe déjà, un second chemin se greffe sur le même hook ».
**C'est faux, ou au mieux conditionnel.** Le seul `httpServer.on("upgrade")` du dépôt est
`src/mqtt-broker.ts` l. 325, **à l'intérieur de `startMqttBroker`**, lui-même appelé sous
`const broker = MQTT_EMBEDDED ? … : undefined` (`src/serve-http.ts` l. 937). En déploiement à broker
externe — configuration supportée — **il n'existe aucun listener d'upgrade du tout**. Il faut donc
l'extraire en routeur d'upgrade partagé, pas s'y greffer.

Décompte : **6 fichiers de code** (dont un nouveau handler, plus `sse-emitter.ts` dont
`MAX_SSE_CLIENTS` est un pool **unique** de 100 — chaque session `Monitor` évincerait un onglet
dashboard) · **4 fichiers CLI** · **5 à 7 tests** (la suite existante sur ces deux chemins compte
déjà **17 fichiers**) · **10 fichiers de doc**, dont `docs/operating-modes.md` qui est un comparatif
*polling vs push* auquel il faudrait ajouter une troisième colonne partout · **2 exemples de
reverse-proxy** (nginx et Traefik, chacun avec son bloc `Upgrade`) · et **`docs/index.html`**, 6
locales, où le vocabulaire de push est déjà présent en masse — au bas mot **4 chaînes × 6 langues =
24 sites d'édition**.

**Total ≈ 26 fichiers, seuil K5 = 12.** Et il n'existe pas de version dégradée qui passe : en coupant
le check `doctor`, l'option `init`, les deux exemples de proxy, en réduisant la doc à 3 fichiers et
les tests à 3, on est encore à **13**. **K5 se déclenche.**

#### H. Le coût des deux chemins de push existants n'est pas encore payé

Sur les issues ouvertes, **#236** est le seul rapport de terrain d'un utilisateur **externe** sur le
push — vérifié : `OPEN`, auteur `fosketer` (Keven Foster), titre *« Message loss windows: in-memory
listener queues + clean:true MQTT bridge + drain-without-ack »*. S'y ajoutent **#330** (l'ACL MQTT,
ouverte par le challenge `C04`) et **#280**.

Autrement dit : **le seul utilisateur externe qui parle du push ne demande pas un chemin de plus, il
demande que l'existant arrête de perdre ses messages.** Ajouter un troisième chemin — troisième cap
de clients, troisième backpressure, troisième reprise, troisième surface d'auth — chez un mainteneur
solo qui n'a pas fini de payer les deux premiers, est difficilement défendable.

#### I. K6 : la seule demande de push en session vient du mainteneur

Balayage des issues sur `push`, `websocket`, `monitor`, `sse`, `notification`, `subscribe` : **une
seule** demande de push *en session*, **#130**, ouverte et fermée par `swoofer`, sans aucune voix
externe. Tout le reste est du push *vers l'extérieur* (Slack, Discord, GitHub Actions, subscribers),
hors sujet. Et `HANDOFF.md` porte déjà, deux fois, la consigne de ne pas re-spiker ce chantier sans
demande concrète d'opérateur. **K6 se déclenche.**

#### J. 🟢 Ce qui survit — et qui ne demande aucune décision d'adoption

Le mode **`command`** de `Monitor`, pointé sur `/api/events` **qui existe déjà**. C'est d'ailleurs
l'exemple canonique de la description d'outil livrée par Anthropic pour ce cas précis
(« Node script that emits events as they arrive (e.g. WebSocket listener) » → `node watch-for-events.js`),
et non le mode `ws`.

Ses avantages sur le mode `ws` sont dirimants :

| | mode `ws` | mode `command` sur `/api/events` |
|---|---|---|
| Endpoint serveur à écrire | **oui** (≈26 fichiers) | **non**, existe depuis la v0.6 |
| Adresse LAN | **bloquée** | autorisée (aucun garde-fou SSRF) |
| Auth | JWT **dans l'URL**, recopié au transcript | en-tête `Authorization` propre |
| Approbation | à chaque ouverture, non mémorisable | hérite des règles de `Bash` → **pré-approuvable** via `permissions.allow` |
| Scoping org, reprise `Last-Event-ID`, heartbeat, bornage | à construire | **déjà là et déjà testés** |

Un script de quinze lignes qui consomme `/api/events` et recrache une ligne JSON par événement donne
le même résultat pour **zéro fichier serveur nouveau**. Si `Monitor` a une valeur pour ce projet,
elle est là — et elle coûte **une recette dans `docs/operating-modes.md`**, pas un chantier.

*(Réserve : la troncature à 500 caractères de §C s'applique aussi à ce chemin. Le script doit donc
émettre une ligne courte — un résumé, pas le JSON brut de l'événement.)*

#### K. Adjudication des sept critères

| | Statut | Sur quoi |
|---|---|---|
| **K1** | 🟢 **non déclenché** | le loopback est explicitement exempté (§A). **Mon hypothèse était fausse.** |
| **K2** | 🔴 **DÉCLENCHÉ** | et je l'écris noir sur blanc : la crainte centrale de §6.5 est **réfutée**. |
| **K3** | 🔴 **DÉCLENCHÉ** | `suggestions: []`, aucune mémorisation ; « socket close ends the watch » et le message `[Monitor timed out — re-arm if needed.]` font du ré-armement le cas **nominal**. Sous `CLAUDE_CODE_REMOTE`, `persistent` est en outre forcé à `false`. |
| **K4** | 🔴 **DÉCLENCHÉ** | verrou `allow_web_fetch` (§F ter) **en plus** des plateformes et des variables de désactivation ; et `Monitor` lui-même dépend du flag distant `tengu_amber_sentinel`, défaut `false` (§D). |
| **K5** | 🔴 **DÉCLENCHÉ** | ≈26 fichiers contre un seuil de 12 (§G). |
| **K6** | 🔴 **DÉCLENCHÉ** | aucune demande externe ; la seule est celle du mainteneur (§I). |
| **K7** | 🔴 **DÉCLENCHÉ** | `type: "ws"` est header-only, sans OAuth — incompatible avec la Phase 2 sans maintenir deux chemins d'auth. |

**Six sur sept.** Le seul non déclenché est celui dont je pensais qu'il déciderait de la fiche.

### 6.5 Contre-arguments

- **Le garde-fou adresses privées vise exactement notre profil de déploiement.** mcp-coordinator est majoritairement auto-hébergé en localhost ou sur le LAN. Si le loopback est refusé comme le reste des adresses privées, l'intérêt de `Monitor` pour ce projet est nul sans exposer le daemon sur un hôte public — ce qui est un changement de posture de sécurité, pas une option de confort.
- **L'argument « plus portable que les channels » est faux.** `Monitor` porte les mêmes restrictions de plateforme : indisponible sur Bedrock, Google Cloud Agent Platform et Microsoft Foundry, et désactivé sous `DISABLE_TELEMETRY` ou `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Deux des trois fiches brutes vendaient ce chemin comme échappant aux contraintes des channels ; c'est réfuté.
- **« Sans réglage d'org » est faux aussi.** `sandbox.network.deniedDomains` et `allowManagedDomainsOnly` sont précisément des verrous d'organisation, capables de tuer l'usage en entreprise — le public visé par la Phase 2.
- **L'approbation sans mémorisation par hôte disqualifie l'usage non supervisé.** Pas d'option « ne plus demander » : un agent long ré-approuve à chaque reconnexion. Un abonnement d'événements est censé survivre à l'inattention de l'utilisateur ; celui-ci non.
- **`type: "ws"` sacrifie OAuth.** Adopter le transport WebSocket pour le MCP, c'est soit régresser sur l'authentification que la Phase 2 a coûté cher à construire, soit maintenir deux chemins d'auth en parallèle (`http`+OAuth pour le contrôle, `ws`+header pour le push) — donc plus de code, pas moins.
- **`Monitor` ne remplace pas `cli/channel.ts`, il en couvre la moitié.** Le channel est bidirectionnel (`post_to_thread` renvoie la réponse de Claude dans une consultation). Un flux `ws` lu par `Monitor` est unidirectionnel : supprimer `channel.ts` demanderait de reconstruire le retour ailleurs.
- **Troisième transport de push dans un projet à mainteneur unique.** SSE navigateur + bridge MQTT + WS texte, chacun avec son cap de clients, sa backpressure et sa reprise à tester. Le coût de maintenance est réel et permanent, contre un gain qui dépend d'un garde-fou hors de notre contrôle.
- **YAGNI partiel.** Ce qui manque au projet n'est pas « du push » — `/api/events` et MQTT le font déjà pour le dashboard et les consommateurs externes — mais du push *dans une session*. Seuls les channels et `type: "ws"` l'adressent proprement ; `Monitor` y répond au prix d'un geste manuel répété.
- **La brique d'automatisation est experimental.** Les monitors de plugin, seul moyen envisagé de démarrer l'abonnement tout seul, sont marqués « experimental component » et ne documentent pas de source `ws` — l'automatisation espérée n'existe pas telle quelle aujourd'hui.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-16 |
| **Justification** | **Six critères de mort sur sept se déclenchent** (§6.4-K). Le seul qui ne se déclenche pas est celui dont je pensais qu'il déciderait de tout : le loopback **passe**. Mais le design proposé meurt sur un mécanisme que personne n'avait vu — `Monitor` **tronque toute ligne à 500 caractères** et arrête le monitor après 30 s de sur-débit (seau de 10 lots, recharge 1 toutes les 2 s). « Une ligne JSON = un événement » est donc mort au cas nominal. S'y ajoutent : ≈26 fichiers pour un seuil de 12, aucune mémorisation d'approbation, un verrou `allow_web_fetch` inconnu de la fiche, et l'absence de champ `headers` qui forcerait le JWT dans l'URL — donc dans le transcript du modèle. |
| **Issue / PR** | aucune. Voir ci-dessous : ce qui survit ne demande pas d'issue. |
| **Jalon visé** | aucun |

### Ce qui est refusé

Les **deux** branches de la fiche :

1. **Un endpoint `/events/ws` consommé par `Monitor` en mode `ws`.** Tué par la troncature à 500
   caractères et le limiteur de débit (§6.4-C), par le coût (≈26 fichiers, §6.4-G), et par
   l'authentification qui ne peut passer que par l'URL (§6.4-F bis) — ce qui **aggraverait** un
   risque que `docs/security/threat-model.md` a déjà classé résiduel.
2. **Le transport MCP `type: "ws"`** (K7) : header-only, sans OAuth. L'adopter, c'est soit régresser
   sur la Phase 2, soit maintenir deux chemins d'authentification en parallèle. Plus de code, pas
   moins.

### Ce qui n'est pas refusé, et ne demande aucune décision

**`Monitor` en mode `command` sur `/api/events`, qui existe déjà.** C'est l'exemple canonique de la
doc d'Anthropic pour ce cas, et il est strictement meilleur que le mode `ws` sur tous les axes qui
comptent ici : aucun endpoint à écrire, adresse LAN autorisée, token en en-tête et non dans l'URL,
approbation **pré-approuvable** via les règles de permission de `Bash`, et scoping d'org, reprise
`Last-Event-ID`, heartbeat et bornage déjà en place et déjà testés.

Ce n'est pas une adoption : c'est **une recette de quinze lignes à ajouter à
`docs/operating-modes.md`** le jour où quelqu'un la demande. Aucune issue ouverte — la demande
n'existe pas encore, et `HANDOFF.md` dit deux fois de ne pas spiker ce sujet sans elle.

### Ce que le challenge corrige dans la fiche

- **§0 a supprimé un fait vrai** : la coupure « too many events » est bien implémentée, et vaut pour
  la source `ws`. À rétablir en §1 et §2 avec ses chiffres (§6.4-C).
- **§1 et §2 manquent la contrainte décisive** : la troncature de ligne à **500 caractères**, plus
  celle du lot à 3 000. Le plafond de 1 MiB, seul mentionné, n'est pas ce qui tue le design.
- **§1 avait raison, moi non** : la résolution DNS existe bien, dans l'exécuteur (§6.4-E).
- **§2 et §5 confondent deux surfaces** : `headers` / `headersHelper` appartiennent au transport MCP
  `ws`, **pas** à l'outil `Monitor`, dont le schéma n'a que `url` et `protocols`.
- **§5 se trompe sur le point d'accroche** : le hook d'upgrade est enfermé dans `startMqttBroker`,
  sous le garde `MQTT_EMBEDDED` — en broker externe, il n'existe pas.
- **L'en-tête annonce « GA »** alors que `Monitor` dépend d'un flag distant à défaut `false`.
- **§0 date Claude Code à v2.1.219** ; le poste est en **2.1.233**.

### Note de méthode

Mon hypothèse principale était fausse, et c'est le meilleur résultat du challenge : je pariais sur un
loopback bloqué, il est **explicitement exempté** — l'intention est écrite en clair dans le binaire
(« Loopback (127.0.0.1, ::1) is allowed for local dev. »). K2 s'est déclenché et je l'écris sans le
diluer.

Mais la bonne nouvelle n'a pas sauvé la fiche, et j'ai failli m'arrêter là. Deux fautes ont été
corrigées par la passe adversariale : ma preuve du loopback était **unijambiste** (j'avais lu le
contrôle de permission, pas celui de connexion, et j'en avais tiré un lemme faux sur l'absence de
résolution DNS), et je n'avais **pas cherché ce qui se passe après** l'ouverture du socket — où se
trouvait le vrai tueur.

C'est la troisième fiche consécutive où une surface annoncée stable s'avère gouvernée par un flag
runtime à défaut `false` — après `tengu_harbor` (`C03`) et `tengu_harbor_permissions` (`C04`), voici
`tengu_amber_sentinel`. **Ce motif mérite d'être remonté à `00-SYNTHESE.md`** : le statut « GA »
affiché par la doc d'Anthropic ne dit rien de la disponibilité réelle chez un utilisateur donné.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : surface API confirmée, coupure « too many events » inventée retirée, lignes repo recalées. |
| 2026-08-16 | **Challenge — verdict `refuser`.** 6 critères de mort sur 7 déclenchés. **La contradiction n°1 de §2 est tranchée : le loopback est explicitement exempté** (`if(r===127)return !1` ; `if(t==="::1")return !1` ; et, en clair dans le binaire, « Loopback (127.0.0.1, ::1) is allowed for local dev. ») — donc K1 ne se déclenche pas et le premier contre-argument de §6.5 est réfuté. Le LAN, lui, reste bloqué. Mais le design meurt ailleurs : `Monitor` **tronque toute ligne à 500 caractères** (`$bi=500`) et tue le monitor après 30 s de sur-débit (seau de 10 lots, recharge 1/2 s) — « une ligne JSON = un événement » est mort au cas nominal. **§0 avait supprimé un fait vrai** en retirant la coupure « too many events » : elle est implémentée et vaut pour la source `ws`. Autres corrections : le schéma `ws` n'a **aucun champ `headers`** (§2/§5 confondent avec le transport MCP), donc le JWT irait dans l'URL et donc dans le transcript ; §5 se trompe sur le hook d'upgrade (enfermé sous `MQTT_EMBEDDED`) ; verrou `allow_web_fetch` non vu par la veille ; « GA » est faux (flag distant `tengu_amber_sentinel`, défaut `false`) ; §1 avait raison sur la résolution DNS, pas moi. Effort ≈26 fichiers pour un seuil de 12. Survit sans décision : `Monitor` en mode `command` sur `/api/events` existant. |
