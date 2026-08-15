# E08 — Push et outils conditionnels côté Messages API (system messages, tool_addition)

| Champ | Valeur |
|---|---|
| **ID** | `mid-conversation-system-and-tools` |
| **Surface** | claude-api |
| **Statut** | mixte — mid-conversation system messages : **GA** ; tool_addition / tool_removal : **beta** |
| **Disponible depuis** | system messages : 2026-05-28 (Opus 4.8), élargi 2026-07-15 (Fable 5 / Mythos 5 / Opus 4.8) · tool changes : 2026-07-24 (Opus 5) |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC Messages API exige clé API + header beta |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur `defer_loading` vs cache est tranché : la doc précise que l'inventaire complet est déclaré d'emblée dans `tools` et que « the `tools` array itself never changes, so the cached prefix stays intact ». Un outil `defer_loading: true` reste donc bien présent dans le préfixe haché ; il est seulement *non offert* au modèle. Ce que la doc ne dit pas : s'il est facturé en tokens d'entrée — `(non vérifiable — non documenté)`.
- §2 — la « contradiction entre chercheurs » est levée : l'annonce du 24 juillet 2026 figure bien dans les release notes API (`### July 24, 2026`), avec le header `mid-conversation-tool-changes-2026-07-01` et la liste Fable 5 / Mythos 5 / Opus 4.8 / Opus 5. Aucun écart d'API.
- §2 — précision ajoutée : la ligne « PAS Sonnet 5 » ne vaut que pour la beta `tool changes`. Les **messages système mid-conversation sont disponibles sur Sonnet 5** (doc actuelle). Cela affecte la portée du contre-argument de §6.5, sans le contredire.
- §5 — `CoordinatorEvent` est **déclaré dans `src/types.ts`**, pas dans `src/sse-emitter.ts` (qui l'importe et l'émet). Ligne corrigée.

Faits vérifiés sans correction nécessaire : header beta, noms de blocs `tool_addition` / `tool_removal`, les trois types de référence (`tool_reference`, `mcp_tool_reference` avec `server_name`+`name`, `mcp_toolset_reference` avec `server_name`), `defer_loading`, absence de header pour les messages système, règles de placement et 400, avertissement sécurité, dates 2026-05-28 / 2026-07-15 / 2026-07-24, statut mixte GA + beta. Côté repo : les 26 outils (11/4/3/3/3/2 dans l'ordre cité), les 6 `register*Tools` de `src/server-setup.ts` (l. 242-247), les routes de `src/serve-http.ts` (`/api/auth/*`, `/api/events`, `/mcp`, `/health`, `/healthz`, `/health/ready` — aucun endpoint d'inventaire d'outils), `notifications/claude/channel` à `cli/channel.ts:465`, et l'existence de `sdk/src/client.ts` et `docs/ARCHITECTURE.md`.

**Marqueurs `(à vérifier)` restants :** un seul, requalifié en `(non vérifiable — non documenté)` : la facturation en tokens d'un outil `defer_loading: true`. Mesurable par PoC, pas par la doc.

**Testabilité :** ⚠️ partielle
Ce qui est exécutable ici : dumper `tools/list` sur le daemon local via `/mcp` et mesurer le poids du bloc des 26 outils, ce qui suffit à trancher l'argument YAGNI de §6.5 sur `defer_loading`. Ce qui ne l'est pas sans accès supplémentaire : tout le reste du protocole §6.3 (cache miss, `tool_addition`, 400 de placement, `mcp_toolset_reference`) passe par la boucle Messages API et exige une clé API Anthropic autorisée pour le header `mid-conversation-tool-changes-2026-07-01` sur un modèle non-Sonnet — Claude Code ne donne pas accès à cette boucle.

## 1. Ce que c'est

Deux mécanismes complémentaires de la Messages API qui permettent de modifier le contexte opérateur **en cours de conversation** sans invalider le prompt cache.

Le premier : on peut insérer une entrée `{"role": "system"}` au milieu du tableau `messages[]`, au lieu d'éditer le champ `system` de haut niveau. Comme le champ `system` est en tête du préfixe haché, le modifier provoque un cache miss total ; un message système inséré en fin de tableau laisse le préfixe byte-identique. L'instruction conserve l'autorité opérateur (elle prime sur les messages `user`). Les règles de placement sont strictes : jamais en position 0 ; le message doit suivre immédiatement un tour `user` (y compris un tour `user` ne portant que des `tool_result`) ou un tour assistant se terminant par un résultat d'outil serveur ; il doit précéder un tour assistant ou clore le tableau ; il ne peut jamais s'intercaler entre un `tool_use` et son `tool_result` (sinon 400). La documentation cite explicitement comme cas d'usage « des fichiers ont changé sur le disque », « les outils disponibles ont changé » et « l'utilisateur a envoyé un message pendant que tu travaillais ».

Le second, sous header beta, réutilise ce véhicule : des blocs `tool_addition` / `tool_removal` placés dans le `content` d'un message `role: "system"` font apparaître ou disparaître des outils entre deux tours, sans toucher au tableau `tools` (qui est le tout début du préfixe et invaliderait tout le cache). On déclare tout l'inventaire en amont — un outil marqué `defer_loading: true` reste retiré tant qu'un `tool_addition` ne le fait pas apparaître — et on ne manipule ensuite que des références. Référencer un nom non déclaré renvoie 400.

Avertissement de sécurité explicite dans la doc : ne jamais placer dans un message système du contenu non fiable (sortie d'outil, document récupéré), puisque cela lui confère l'autorité opérateur.

## 2. Surface d'API exacte

```
messages[] : {"role": "system", "content": <string | blocs text / tool_addition / tool_removal>}
             — aucun header beta ; interdit en position 0
             — modèles : Fable 5, Mythos 5, Opus 4.8, Opus 5 ET Sonnet 5

anthropic-beta: mid-conversation-tool-changes-2026-07-01
  blocs : tool_addition | tool_removal
  champ `tool` :
    {"type": "tool_reference",         "name": "<outil déclaré dans tools[]>"}
    {"type": "mcp_tool_reference",     "server_name": "...", "name": "..."}
    {"type": "mcp_toolset_reference",  "server_name": "..."}
  déclaration : tools[].defer_loading: true
  modèles (beta tool changes uniquement) : Fable 5, Mythos 5, Opus 4.8, Opus 5 — PAS Sonnet 5
```

Payload minimal (orchestrateur qui relaie un événement de coordination et ferme les écritures) :

```json
{
  "role": "system",
  "content": [
    { "type": "text", "text": "L'agent B a réservé src/api/routes.ts il y a 12 s. Les outils d'écriture sur ce chemin sont retirés jusqu'à libération." },
    { "type": "tool_removal", "tool": { "type": "mcp_tool_reference", "server_name": "mcp-coordinator", "name": "announce_intent" } }
  ]
}
```

Surfaces connexes citées par les sources, hors périmètre de cette fiche : `tool search tool` GA sans header depuis 2026-02-17, `requiresUserInteraction` côté outil MCP dans Claude Code, diagnostics de cache via `diagnostics.previous_message_id` + `cache_miss_reason` sous `anthropic-beta: cache-diagnosis-2026-04-07`.

**Contradiction entre chercheurs à noter :** deux fiches brutes datent le lancement de `mid-conversation-tool-changes` du 2026-07-24 avec Opus 5 mais l'une place l'annonce dans les release notes API et l'autre dans la page build-with-claude ; le nom du header est identique dans les deux (`mid-conversation-tool-changes-2026-07-01`), donc l'écart porte seulement sur la source citée, pas sur l'API. **Tranché le 2026-08-14 :** l'entrée `### July 24, 2026` des release notes API porte bien l'annonce, avec ce header et cette liste de modèles.

Comportement de `defer_loading` vis-à-vis du cache — **tranché le 2026-08-14 :** l'outil différé est déclaré dans `tools` comme les autres et le tableau `tools` ne change jamais, donc il est bien haché dans le préfixe ; `defer_loading: true` ne fait que le retenir hors de l'inventaire offert au modèle jusqu'à un `tool_addition`. La doc ne dit pas s'il est facturé en tokens d'entrée — *(non vérifiable — non documenté ; mesurable par PoC)*.

## 3. Sources

- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://platform.claude.com/docs/en/release-notes/api
- https://platform.claude.com/docs/en/release-notes/overview
- https://code.claude.com/docs/en/tools-reference

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. *Un second canal de push, sans MQTT.* Aujourd'hui le push temps réel passe par `src/mqtt-broker.ts` + `src/mqtt-bridge.ts` et se termine en `notifications/claude/channel` émis par `cli/channel.ts`, ou par SSE sur `/api/events` (`src/sse-emitter.ts`, `src/serve-http.ts`). Ces deux chemins n'existent que pour Claude Code. Pour un intégrateur qui pilote lui-même la boucle Messages API (le mode « avec orchestrateur »), le message système inséré est l'équivalent exact : il peut injecter « l'agent B vient de réserver `src/api/routes.ts` » comme fait opérateur juste après les `tool_result`, sans cache miss et sans attendre que l'agent pense à appeler `coordinator_status`. Aucun code serveur ne disparaît — c'est une recette d'intégration à documenter, alimentée par les données que `src/agent-registry.ts`, `src/working-files-tracker.ts` et `src/conflict-detector.ts` produisent déjà.

2. *La coordination peut devenir structurelle plutôt que consultative.* `tool_removal` permet de rendre la disponibilité d'un outil dépendante de l'état de coordination : tant qu'un autre agent tient un verrou sur `src/auth/`, l'orchestrateur retire les outils d'écriture ; à la libération, `tool_addition`. L'agent ne peut plus « oublier » de demander : l'outil n'existe pas. `mcp_toolset_reference` permet de couper ou rouvrir tout le serveur mcp-coordinator d'un bloc.

3. *Réponse au coût des 26 outils.* Le serveur enregistre 26 outils (vérifié : 11 dans `src/tools/consultation-tools.ts`, 4 dans `agents-tools.ts`, 3 dans `dependencies-tools.ts`, 3 dans `files-tools.ts`, 3 dans `mqtt-tools.ts`, 2 dans `status-tools.ts`), tous exposés en permanence via `src/server-setup.ts`. Avec `defer_loading` + `tool_addition`, un orchestrateur peut n'offrir que le noyau (`announce_*`, `coordinator_status`) et faire apparaître consultation / dépendances / conflits seulement quand le contexte l'exige, sans payer d'invalidation de cache. C'est un argument d'adoption concret face aux serveurs MCP obèses.

Ce qui manquerait côté serveur pour rendre ça exploitable : un endpoint qui répond « quels outils devraient être offerts à l'agent X maintenant », dérivé de l'état des verrous et des threads ouverts. Rien de tel n'existe aujourd'hui dans `src/serve-http.ts` (les routes présentes sont `/api/auth/*`, `/api/events`, `/mcp`, `/health*`).

**Risque si on ne fait rien :** faible mais réel. Les intégrateurs qui n'utilisent pas Claude Code n'ont aujourd'hui aucun chemin de push documenté ; ils polleront `coordinator_status`, ce qui coûte des tours et donne une coordination en retard. Le risque n'est pas une menace concurrentielle, c'est un angle mort de la doc.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | Point d'enregistrement des 6 familles d'outils (`registerConsultationTools`, `registerAgentTools`, `registerFilesTools`, `registerDependenciesTools`, `registerStatusTools`, `registerMqttTools`). C'est ici que se déciderait un découpage noyau / différé. |
| `src/tools/consultation-tools.ts` (11 outils) | Le plus gros bloc : premier candidat à `defer_loading`. |
| `src/tools/dependencies-tools.ts` (3), `src/tools/files-tools.ts` (3), `src/tools/mqtt-tools.ts` (3) | Familles secondaires, activables à la demande. |
| `src/tools/agents-tools.ts` (4), `src/tools/status-tools.ts` (2, dont `coordinator_status`) | Noyau à garder toujours chargé. |
| `src/serve-http.ts` | Routes existantes : `/mcp`, `/api/events` (SSE), `/api/auth/*`, `/health*`. Emplacement d'un futur endpoint « inventaire d'outils recommandé pour l'agent X ». |
| `src/sse-emitter.ts` | Source des événements de coordination qu'un orchestrateur convertirait en message système inséré. Le type `CoordinatorEvent` est déclaré dans `src/types.ts` et importé ici (l. 2). |
| `src/mqtt-bridge.ts`, `src/mqtt-broker.ts` | Chemin de push actuel, spécifique Claude Code ; à comparer, pas à remplacer. |
| `cli/channel.ts` | Émet `notifications/claude/channel` (ligne ~465). Illustre la traduction événement → push ; le format de phrase y est déjà normalisé et réutilisable. |
| `src/agent-registry.ts`, `src/working-files-tracker.ts`, `src/conflict-detector.ts` | Fournissent l'état « qui détient quoi » qui déciderait des `tool_removal`. |
| `sdk/src/client.ts` | Le SDK client TypeScript : lieu naturel d'un helper `buildSystemMessage(events)` pour les intégrateurs orchestrateurs. |
| `docs/ARCHITECTURE.md` | À compléter avec la section « mode orchestrateur » si la recette est retenue. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il se contenter de **documenter** une recette d'orchestrateur (le client insère lui-même les messages système et les `tool_addition` à partir du flux SSE), ou doit-il **exposer côté serveur** un endpoint d'inventaire d'outils dérivé de l'état des verrous — c'est-à-dire assumer une dépendance à une beta Messages API et à un modèle non-Sonnet dans son propre code ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Vérification 2026-08-14 : seul le premier point (mesure du poids des 26 outils via `tools/list` sur le daemon local) est exécutable ici. Les quatre autres passent par la boucle Messages API et exigent une clé API autorisée pour `mid-conversation-tool-changes-2026-07-01` sur un modèle non-Sonnet.

<Proposition de la veille — non exécutée.>

- [ ] Mesurer le coût contexte réel des 26 outils : compter les tokens du bloc `tools` produit par `src/server-setup.ts` (dump `tools/list` via `/mcp` puis `count_tokens`). Sans chiffre, le gain de `defer_loading` est une hypothèse.
- [ ] PoC minimal hors repo : une boucle Messages API avec deux outils déclarés dont un en `defer_loading: true`, un `tool_addition` inséré au tour 2, et vérification de `cache_read_input_tokens` avant/après pour confirmer qu'il n'y a pas de cache miss.
- [ ] Vérifier les règles de placement contre le vrai flux : insérer un message système juste après un tour `user` portant des `tool_result` et confirmer l'absence de 400.
- [ ] Brancher `src/sse-emitter.ts` sur ce PoC : convertir un `CoordinatorEvent` réel (réservation de fichier) en message système et observer si l'agent change de comportement sans appel à `coordinator_status`.
- [ ] Tester le retrait complet via `mcp_toolset_reference` sur `server_name: "mcp-coordinator"` et vérifier que l'agent ne tente plus d'appeler les outils retirés.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Ce n'est pas notre couche.** Les deux mécanismes vivent dans la boucle Messages API, côté client. mcp-coordinator est un serveur MCP : il ne construit pas `messages[]` et ne verra jamais ces blocs. Tout ce qu'on peut livrer, c'est de la documentation et éventuellement un helper SDK — soit un gain qui n'enlève aucune ligne de code au serveur.
- **Dépendance beta + exclusion de modèle.** `mid-conversation-tool-changes-2026-07-01` est en beta et absent de Sonnet 5, le modèle le plus probable pour un swarm d'agents à coût contenu. Bâtir une capacité de coordination sur une primitive indisponible sur le modèle le plus utilisé est fragile.
- **Deux chemins de push à maintenir.** MQTT + `notifications/claude/channel` existent déjà et fonctionnent. Ajouter une recette message-système crée un second contrat à tenir cohérent (même vocabulaire d'événements, même sémantique), pour une population d'utilisateurs — les intégrateurs orchestrateurs hors Claude Code — dont on n'a aucune preuve qu'elle existe aujourd'hui.
- **Risque de sécurité mal placé.** La doc interdit explicitement de mettre du contenu non fiable dans un message système. Or les payloads que relaierait un orchestrateur viennent d'autres agents : contenu tiers. Documenter « prends le payload MQTT et mets-le dans un message système » est une recette d'injection à autorité opérateur. Il faudrait imposer une reformulation en fait constaté, ce qui suppose une couche de normalisation côté SDK — coût non trivial.
- **YAGNI sur `defer_loading`.** 26 outils, c'est beaucoup, mais le vrai coût n'a jamais été mesuré. Découper `src/server-setup.ts` en noyau / différé complique l'enregistrement, l'auto-hébergeur, et les tests, pour une économie inconnue. Le `tool search tool` (GA, sans header) pourrait couvrir le même besoin sans toucher au serveur.
- **La coordination structurelle change la nature du produit.** Retirer un outil parce qu'un pair tient un verrou transforme mcp-coordinator d'assistant de coordination en autorité de contrôle d'accès. C'est un choix de positionnement, pas une optimisation, et il n'est exécutable que si l'orchestrateur coopère — donc contournable trivialement.

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
| 2026-08-14 | Vérification des faits : API et dates confirmées, `defer_loading` tranché, Sonnet 5 précisé, `CoordinatorEvent` recorrigé. |
