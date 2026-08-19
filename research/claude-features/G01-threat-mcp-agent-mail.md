# G01 — MCP Agent Mail : le concurrent open source le plus proche

| Champ | Valeur |
|---|---|
| **ID** | `threat-mcp-agent-mail` |
| **Surface** | ecosystem |
| **Statut** | experimental (OSS pré-1.0, README « Under active development ») |
| **Disponible depuis** | v0.1.3 → v0.3.4 ; v0.3.2 publiée le 2026-04-16 ; dernier push 2026-08-04 |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | PLAUSIBLE |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — serveur OSS local, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — acceptation assumée : le recouvrement est réel et bon marché à combler, on ne le comble pas faute de besoin |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur la signature de `file_reservation_paths` est tranché : signature complète et sémantique du TTL extraites de la table de référence du README (l. 2304) et de sa description (l. 1670).
- §2 — précision du décompte d'outils : la table de référence du README documente **27** outils, auxquels s'ajoutent les build slots et les outils produit décrits ailleurs → ≥ 34. Confirme la lecture du vérificateur au §1 (surface du concurrent **plus grande** que nos 26 outils).
- §2 — la commande de service est `uv run python -m mcp_agent_mail.cli serve-http` (le README l'invoque via le module `cli`, pas comme binaire nu).
- §5 — le bloc de schéma `threads` / `thread_messages` / `action_summaries` de `src/database.ts` va de la l. 99 à la l. **146** (`events` démarre l. 148), pas 99-148.

**Faits recontrôlés et confirmés (aucune correction) :**

- Métadonnées GitHub au 2026-08-14 : dépôt Python **2 082** étoiles, `pushed_at` **2026-08-04**, `homepage` **null**, dernier tag **v0.3.4** ; portage Rust **126** étoiles, `homepage` null. Statut `experimental` / « Under active development » toujours exact.
- Citation transport du README l. 311 : `HTTP-only FastMCP server (Streamable HTTP). No SSE, no STDIO.` — exacte au caractère près. Tolérance des chemins `/api`, `/api/`, `/mcp`, `/mcp/` confirmée (README l. 2152).
- Tous les noms d'outils listés au §2 existent réellement dans le README amont. Aucun nom inventé.
- Repo : les 23 fichiers cités au §5 existent tous. Aucune table FTS5 ni requête `MATCH` dans `src/database.ts`. `src/tools/consultation-tools.ts` expose exactement **11** outils, aux noms cités. `src/tools/files-tools.ts` expose bien `hot_files` / `get_session_files` / `check_file_conflict`. `ALG_SHA256` est bien l. 62 de `src/security/audit-chain.ts`. Table `working_files` l. 217-226 avec `claim_until` indexé ; `working-files-tracker.ts` documente et implémente `start(orgId, agentId, filePath, ttlMinutes)` / `stop()` / `sweepExpired()` / `clearForAgent()`. `src/database.ts` fait bien ~66 Ko. Le total de 26 outils MCP côté mcp-coordinator est vérifié par comptage sur `src/tools/*.ts`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Nuance factuelle à porter au challenge (non tranchée ici) :** le README amont (l. 1670) précise que sur collision d'`exclusive` actifs, « reservations are still granted; conflicts are returned alongside grants ». L'exclusivité d'agent-mail est donc elle aussi **advisory** au niveau du serveur MCP — le refus dur ne vient que de la garde `pre-commit`. Cela ne contredit rien de ce qui est écrit dans la fiche, mais change ce que la première puce du protocole §6.3 est susceptible d'observer.

**Testabilité :** ✅ testable
Rien ici ne dépend d'un accès fermé : `mcp_agent_mail` est un serveur OSS Python lancé en local (`uv run python -m mcp_agent_mail.cli serve-http --port 9000`), attachable à deux instances Claude Code en transport HTTP streamable, sans credential Anthropic ni header beta. Les trois autres volets — benchmark `search_messages` FTS5 vs `list_threads`, prototype `search_threads` sur table virtuelle FTS5 adossée à `thread_messages`, et `tools/list` pour trancher le décompte du §1 — se font entièrement sur le repo avec Node 22 + pnpm. Seule friction possible : installer `uv` / une toolchain Python sur le poste Windows.

---

## 1. Ce que c'est

`Dicklesworthstone/mcp_agent_mail` est une couche de coordination asynchrone pour agents de codage, construite sur la métaphore de la boîte mail : identités d'agents, inbox, threads, accusés de réception, réponses. Le mécanisme différenciant est la **réservation de fichiers advisory à TTL** — un agent pose une lease exclusive sur des chemins avant d'éditer, la renouvelle, la relâche, et un tiers peut la casser de force ; le serveur signale les collisions de chemins. Une garde `pre-commit` optionnelle transforme cet advisory en application réelle côté Git. Le stockage est double : des artefacts Markdown lisibles et diffables commités dans le dépôt (piste d'audit), doublés d'une base SQLite avec index **FTS5** pour la recherche plein texte sur les threads. Le serveur est un FastMCP **HTTP streamable uniquement** — pas de SSE, pas de stdio — lancé par `serve-http`, tolérant les chemins `/api`, `/api/`, `/mcp`, `/mcp/`. Il expose aussi des « macros » qui compressent plusieurs appels en un seul. Le dépôt Python compte ~2 082 étoiles ; un portage Rust séparé (`mcp_agent_mail_rust`, 126 étoiles) existe et ne doit pas être confondu avec lui.

**Contradiction entre chercheurs, à trancher au challenge.** La fiche brute affirmait qu'agent-mail a une « surface minimale » et que les ~26 outils de mcp-coordinator sont « un vrai défaut compétitif à corriger ». Le vérificateur documente exactement l'inverse : le dépôt Python expose ~31+ outils, le jumeau Rust en annonce 34, et le site du portage Rust revendique en hero « 380 Coordination primitives » et « 250 Agent-discoverable resource surfaces ». Les macros sont des enveloppes **additives** par-dessus la surface complète, pas une réduction. Conclusion du vérificateur : les 26 outils de mcp-coordinator constituent une surface **plus petite** que celle du concurrent, et cet argument ne doit pas piloter de décision de roadmap. La fiche retient la version du vérificateur, mais l'écart est signalé ici plutôt que résolu en silence.

## 2. Surface d'API exacte

Noms d'outils MCP relevés par grep sur le README brut. **Tous vérifiés présents dans le README amont le 2026-08-14.** La table de référence du README (l. 2260-2310) documente **27** outils ; s'y ajoutent les build slots (l. 1886-1890) et les outils produit (l. 1940), soit **≥ 34**. La liste ci-dessous omet notamment `health_check`, `create_agent_identity`, `sweep_stale_agents`, `mark_message_read`, `uninstall_precommit_guard`.

```
ensure_project              register_agent            whois
send_message                fetch_inbox               list_agents
acknowledge_message         reply_message
search_messages             summarize_thread

file_reservation_paths      release_file_reservations
renew_file_reservations     force_release_file_reservation
install_precommit_guard

request_contact             respond_contact
list_contacts               set_contact_policy

acquire_build_slot          renew_build_slot          release_build_slot

ensure_product              products_link             search_messages_product

macro_start_session         macro_prepare_thread
macro_file_reservation_cycle  macro_contact_handshake
```

Transport, cité mot pour mot (README ligne 311) :

```
HTTP-only FastMCP server (Streamable HTTP). No SSE, no STDIO.
CLI : uv run python -m mcp_agent_mail.cli serve-http [--port N]
Endpoints tolérés : /api  /api/  /mcp  /mcp/   (var. HTTP_PATH, défaut /mcp/)
```

Signatures du cycle de réservation, extraites de la table de référence du README (l. 2304-2307) — marqueur `(à vérifier)` **tranché le 2026-08-14** :

```
file_reservation_paths(project_key: str, agent_name: str, paths: list[str],
                       ttl_seconds?: int, exclusive?: bool, reason?: str,
                       registration_token?: str) -> {granted: list, conflicts: list}

renew_file_reservations(project_key: str, agent_name: str, extend_seconds?: int,
                        paths?: list[str], file_reservation_ids?: list[int],
                        registration_token?: str) -> {renewed, file reservations[]}
```

- **Granularité** : globs acceptés — exemple canonique du README, `["src/**"]` avec `ttl_seconds=3600, exclusive=true`.
- **TTL** : en secondes, expiration automatique ; `renew_file_reservations` prolonge via `extend_seconds`, ciblable par chemins ou par ids de réservation.
- **Sémantique de l'exclusivité (README l. 1670)** : bail *advisory* en base + artefact JSON versionné dans Git par chemin ; en cas de recouvrement avec un `exclusive` actif, « reservations are still granted; conflicts are returned alongside grants ». Le serveur **signale** la collision, il ne la **refuse** pas — le refus dur est le fait de la garde `pre-commit` uniquement.

## 3. Sources

- https://github.com/dicklesworthstone/mcp_agent_mail
- https://mcpagentmail.com/ — **attention** : ce site est celui du portage Rust `mcp_agent_mail_rust` (126 étoiles), pas du dépôt Python. Le champ `homepage` du dépôt GitHub Python est nul. Les affirmations « production-ready / ~49 RPS / 380 primitives » appartiennent au projet Rust ; les ~2 082 étoiles appartiennent au projet Python.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** une comparaison honnête sur trois points vérifiables dans notre code.

1. **Lisibilité humaine de l'historique.** agent-mail commite des Markdown diffables dans Git. Chez nous, l'historique vit dans SQLite (`threads`, `thread_messages`, `action_summaries` dans `src/database.ts`) et la piste d'audit est une chaîne de hash (`src/security/audit-chain.ts`, `SHA-256` ou `HMAC-SHA256` sur `prev_hash || canonicalRowFields(row)`), donc vérifiable mais **opaque sans outillage**. Un mainteneur qui veut relire ce que les agents se sont dit lors d'un PR n'a aujourd'hui que le dashboard ou l'API.
2. **Recherche.** `grep` sur `src/database.ts` ne trouve **aucune** table FTS5 ni requête `MATCH` ; `src/consultation.ts` n'expose pas de recherche. Les 11 outils de `src/tools/consultation-tools.ts` s'arrêtent à `list_threads` / `get_thread` / `get_thread_updates`. Sur un dépôt avec des centaines de threads, agent-mail sait retrouver une décision, nous non.
3. **TTL des réservations.** L'idée à récupérer est **déjà à moitié présente** : `working_files` a une colonne `claim_until` indexée, et `src/working-files-tracker.ts` documente le cycle `start(orgId, agent, file, ttlMin)` → `stop()` → `sweepExpired()` → `clearForAgent()` via LWT MQTT. Ce qui manque n'est pas le TTL, c'est l'**exclusivité** : notre claim est un état de présence, pas une lease qui refuse la seconde prise, et il n'y a pas d'équivalent de `install_precommit_guard` côté Git.

Ce que mcp-coordinator fait mieux, et qu'il ne faut pas diluer : détection de conflit **sémantique** (`src/tree-sitter-extractor.ts`, `src/impact-scorer.ts`, `src/dependency-map.ts`, `src/git-cochange-builder.ts`, `src/conflict-detector.ts`) là où agent-mail compare des chemins ; **push temps réel** (`src/sse-emitter.ts`, `src/mqtt-broker.ts`, `src/mqtt-bridge.ts`) là où agent-mail est pull/inbox ; **transports multiples** — stdio (`src/index.ts`, `cli/channel.ts`) et Streamable HTTP (`src/serve-http.ts`) — contre HTTP seul ; et toute la Phase 2 (`src/auth/`, `src/security/`, `src/admin/`, `src/quota/`) qui n'a pas d'équivalent en face.

**Risque si on ne fait rien :** agent-mail occupe la même niche avec ~2 000 étoiles d'avance et un push il y a dix jours. Le risque n'est pas technique, il est narratif : un utilisateur qui compare les deux READMEs voit chez le concurrent une piste d'audit qu'il peut lire dans son éditeur et une recherche qui marche, et chez nous une base SQLite plus un argument sur tree-sitter qu'il faut lui expliquer. Le différenciateur réel (analyse d'impact sémantique) est le plus difficile à démontrer en trente secondes, et les deux acquis d'agent-mail sont les plus faciles à copier — ce qui rend l'inaction coûteuse dans les deux sens.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/database.ts` | Schéma `threads` / `thread_messages` / `action_summaries` (l. 99-146). **Aucune table FTS5, aucun `MATCH`** : c'est ici que se poserait un index de recherche plein texte. |
| `src/tools/consultation-tools.ts` | 11 outils (`announce_work`, `post_to_thread`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `close_thread`, `cancel_thread`, `get_thread`, `get_thread_updates`, `list_threads`, `log_action_summary`). Point d'accroche d'un éventuel `search_threads`. |
| `src/working-files-tracker.ts` + table `working_files` (`src/database.ts` l. 217-226) | TTL déjà là : `claim_until` indexé, `sweepExpired()`, `clearForAgent()` sur LWT. À comparer à la lease exclusive d'agent-mail — le delta est l'exclusivité, pas l'expiration. |
| `src/tools/files-tools.ts` | `hot_files`, `get_session_files`, `check_file_conflict` — l'équivalent le plus proche de `file_reservation_paths`, en lecture seule. |
| `src/security/audit-chain.ts` | Chaîne `prev_hash → row_hash` en `sha256` / `hmac-sha256-v1` (`ALG_SHA256`, l. 62). Vérifiable, non lisible : c'est l'anti-thèse de l'artefact Markdown. |
| `src/conflict-detector.ts`, `src/impact-scorer.ts`, `src/tree-sitter-extractor.ts`, `src/dependency-map.ts`, `src/git-cochange-builder.ts` | Le différenciateur à défendre. Rien à changer, tout à documenter. |
| `src/index.ts` (`StdioServerTransport`), `src/serve-http.ts` (`StreamableHTTPServerTransport`) | Avantage de portabilité : agent-mail refuse explicitement stdio. |
| `src/sse-emitter.ts`, `src/mqtt-broker.ts`, `src/mqtt-bridge.ts` | Push temps réel — le modèle inbox/pull d'agent-mail n'a pas d'équivalent. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels — surface où un `search_threads` devrait aussi apparaître si on l'ajoute. |
| `docs/ARCHITECTURE.md`, `docs/index.html` | Positionnement à réécrire si la comparaison change la narration produit. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il ajouter au-dessus de `thread_messages` une couche d'inspection humaine à la agent-mail — index FTS5 plus export d'artefacts Markdown versionnés dans Git — ou assumer que la chaîne d'audit SHA-256 de `src/security/audit-chain.ts` et le dashboard sont la seule surface de lecture, et concentrer 100 % de l'effort sur la détection sémantique que le concurrent n'a pas ?

### 6.2 Hypothèse

**Terrain vérifié avant de commencer.** J'ai lu le statut des fiches voisines **sur toutes les branches**, pas seulement sur `main` — la passe précédente m'a coûté un challenge entier refait parce que mon extraction des noms de branches avait tronqué `challenge-d01-d02` en `d01`. Aucune fiche `G` n'a de branche ; G01 est vierge.

Deux fiches tranchées mordent sur celle-ci :
- `F02` (2026-08-17) a mesuré que `working_files` porte `PRIMARY KEY (agent_id, file_path)` — **multi-détenteurs par construction**, ce qui corrobore le §4 point 3.
- Mais le challenge de `D02` (2026-08-17) a relevé **#266** : `handleClaimTask` refuse désormais un claim dont les fichiers cibles sont détenus par un autre agent. Il existe donc maintenant un **refus dur sur chevauchement de fichiers** dans le dépôt — exactement ce que le §4 point 3 dit qu'il nous manque. Ce point de la fiche est peut-être périmé.

**Ce que je pense avant de mesurer.** Que le §6.1 est mal posé, parce qu'il oppose deux choses de coûts incomparables : un index FTS5 (une migration, mesurable en octets et en millisecondes) et un export d'artefacts Markdown versionnés dans le dépôt de l'utilisateur (un changement de contrat produit, qui touche la RGPD et le multi-org). Les traiter comme une seule option force un verdict unique sur deux décisions indépendantes.

Je m'attends aussi à ce que le §0 ait déjà désarmé la thèse centrale du §4 sans que la fiche en tire les conséquences : si l'exclusivité d'agent-mail est elle aussi *advisory* — « reservations are still granted; conflicts are returned alongside grants » — alors le « delta = l'exclusivité » du §4 point 3 et du §6.5 compare deux mécanismes advisory et conclut à un écart qui n'existe pas.

Enfin, fiche **menace** : le verdict porte sur la **réponse**, pas sur l'adoption. Le vocabulaire prescrit par `_CHALLENGE-PROMPT.md:126-127` est *contre-mesure technique*, *recadrage du positionnement et de la doc*, ou *acceptation assumée du recouvrement* — pas `adopter`/`refuser`, que j'avais employés à tort en préparant `D02`.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

La §0 classe la testabilité ✅ : trois des cinq points du §6.3 tournent entièrement en local avec Node, sans Python. Je les exécute. Le quatrième (compter la surface d'agent-mail avec un vrai `tools/list`) demande une toolchain `uv`/Python ; s'il ne tourne pas, je le déclare **inmesurable** et je ne tranche pas la contradiction du §1 — je ne choisis pas un camp par confort.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le manque de recherche est réel.** | **0** table FTS5 et **0** `MATCH` dans `src/`, et aucun outil de recherche dans les 11 de `consultation-tools.ts` |
| **K2** | **FTS5 « n'est pas gratuit » (§6.5).** À mesurer, pas à supposer : taille du fichier SQLite et temps de boot. | si le surcoût de taille est **< 25 %** sur un corpus réaliste **et** le boot inchangé (**< 10 ms** de delta), l'objection de coût **tombe** |
| **K3** | **YAGNI sur la recherche (§6.5).** | **0** issue réclamant une recherche |
| **K4** | **Le §4 point 3 est périmé.** #266 a introduit un refus dur sur chevauchement de fichiers. | le refus existe dans le code d'aujourd'hui ⇒ « notre claim n'est qu'un état de présence » est **faux** |
| **K5** | **Le « delta = l'exclusivité » compare deux mécanismes advisory.** | l'exclusivité d'agent-mail est advisory au niveau MCP (§0) **et** la nôtre l'est aussi ⇒ le cadrage du §4/§6.5 s'effondre |
| **K6** | **L'argument « FTS5 nous lie plus fort à SQLite » (§6.5).** | si `src/db-adapter.ts` n'abstrait pas réellement le moteur, l'argument est nul |
| **K7** | **La contradiction du §1 sur le décompte d'outils.** | non résoluble sans client MCP réel ⇒ **inmesurable**, et aucun verdict ne s'y appuie |
| **K8** | **Ce qui reste défendable est-il non vide ?** | s'il ne reste ni détection sémantique, ni push temps réel, ni multi-transport, la fiche annonce une défaite et non une frontière |

**Ce que je m'interdis :** conclure sur du catalogue de README, et publier un chiffre de comparaison que je n'ai pas produit moi-même. `D05` a journalisé « mon décompte était malhonnête » et je ne veux pas d'une seconde occurrence.

### 6.3 Protocole de vérification

Proposition de protocole (non exécuté) :

- [ ] Installer et lancer `mcp_agent_mail` en `serve-http` sur un dépôt jouet, l'attacher à deux instances Claude Code, et observer le comportement réel de `file_reservation_paths` quand deux agents visent le même fichier : refus dur ou simple avertissement ?
- [ ] Mesurer le coût réel de `search_messages` (FTS5) contre notre `list_threads` sur un jeu de 500 threads synthétiques injectés dans `src/database.ts`, en tokens rendus à l'agent et en latence.
- [ ] Prototyper un `search_threads` sur une table FTS5 virtuelle adossée à `thread_messages` et mesurer l'impact sur la taille du fichier SQLite et sur le temps de boot (`src/boot.ts`).
- [ ] Vérifier si `install_precommit_guard` d'agent-mail est portable : peut-il coexister avec les hooks Claude Code que nous utilisons déjà pour alimenter `working_files` ?
- [ ] Compter précisément la surface d'outils exposée par agent-mail avec un vrai client MCP (`tools/list`) pour trancher la contradiction du §1, plutôt que par lecture de README.

### 6.4 Résultat observé

**Frontière entre ce qui a tourné et ce qui n'a pas pu.** Exécutés : les trois volets locaux du §6.3 (bench FTS5, prototype d'index, lecture du code), plus l'adjudication des huit critères sauf un. **Non exécuté** : lancer `mcp_agent_mail` et compter sa surface avec un vrai `tools/list` — `uv` est absent du poste, et installer un gestionnaire de paquets plus un serveur tiers dépasse le « PoC jetable » qu'un challenge s'autorise. Ce point est déclaré **inmesurable**, et **aucune conclusion ne s'y appuie**.

#### K1 — le manque de recherche est réel (se déclenche)

```
0 table FTS5, 0 requete SQL MATCH dans src/

les 3 occurrences du motif sont du CODE, sans rapport avec SQLite :
  src/auth/oauth-callback.ts:177   "PROVIDER_MISMATCH"            (litteral de chaine)
  src/auth/rate-limit-redis.ts:94  scanIterator({ MATCH: ... })   (option Redis SCAN)
  src/auth/rate-limit-redis.ts:102 idem

outils MCP par fichier : agents 4 · consultation 11 · dependencies 3 · files 3 · mqtt 3 · status 2
total : 26
occurrences de "search" dans src/tools/*.ts : 0
```

**K1 se déclenche.** Le décompte de 26 outils du §0 est confirmé par comptage, celui de 11 outils de consultation aussi, et aucun n'est un outil de recherche.

*Correction que je me suis faite : j'avais d'abord écrit que les 3 occurrences étaient « toutes en prose de commentaire », aux lignes 28 et 59. C'était faux deux fois — j'avais pris le **décompte** d'un grep sensible à la casse et les **numéros de ligne** d'un grep insensible (lequel remonte 232 hits, pas 3). Les trois sont du code exécutable. La conclusion ne bouge pas ; la preuve, si.*

#### K2 — l'objection de coût de §6.5 tombe des deux côtés (se déclenche)

**Il m'a fallu trois mesures pour obtenir un chiffre publiable, et les deux premières étaient fausses dans le sens qui m'arrangeait.** J'écris les trois, parce que le trajet est l'information.

*Version 1 — jetée.* Vocabulaire synthétique de 30 mots, index construit en masse, sans triggers : **+12,0 %**. Deux artefacts : la taille était relevée sans `wal_checkpoint` (le premier relevé donnait « +0,0 kio », ce qui aurait dû m'alerter tout de suite), et le delta de boot valait **−79,6 ms** — un index qui *accélère* le boot. Absurde : je comparais une **création + migration à froid** à une **ouverture à chaud**.

*Version 2 — jetée aussi.* Corrigée sur le checkpoint et le boot, mais toujours sur un vocabulaire de 30 mots. Un index inversé sur 30 termes distincts est artificiellement compressible : il **sous-estime** le coût. C'est la passe adversariale qui l'a relevé.

*Version 3 — celle-ci.* Vraie prose du dépôt (`src/`, `docs/`, `research/`), **17 403 mots distincts**, et surtout le **régime d'écriture réel** : les trois triggers de synchronisation en place *avant* les insertions, une transaction par message.

```
corpus : vraie prose du depot, 4000 tranches, 17403 mots distincts

A. en masse, SANS triggers (le protocole de ma v1, refait sur vraie prose)
   texte indexe : 1521 kio
   base 3064,0 -> 3652,0 kio        surcout +19,2 %

B. regime reel : triggers en place, une transaction par message
   base SANS index : 3064,0 kio
   base AVEC index : 3756,0 kio
   surcout de taille : +692,0 kio  =  +22,6 %
   ecriture de 2000 messages : 291 ms -> 668 ms   (x2,29)
   purge de 200 messages, index present : 6,33 ms

boot SANS index (median de 7) : 16,5 ms   [15,9 .. 18,1]
boot AVEC index (median de 7) : 16,9 ms   [16,2 .. 17,4]
```

**Les triggers ne sont pas une option.** Une table FTS5 à contenu externe ne se synchronise pas seule ; sans eux, l'index est un instantané figé. Ce n'est pas une déduction : le concurrent les a, et je l'ai vérifié dans son source — `db.py` crée `fts_messages USING fts5(message_id UNINDEXED, subject, body)` puis trois triggers `fts_messages_ai` / `_ad` / `_au` dans `_setup_fts()`. Et le point n'est pas cosmétique ici : `src/sweeper/index.ts` purge `thread_messages` par lots, donc sans triggers un balayage de rétention laisserait les mots des messages supprimés dans l'index — une fuite que `docs/gdpr.md` interdit.

**K2 se déclenche sur ses deux seuils pré-enregistrés**, mais de justesse et avec une réserve que je dois écrire : +22,6 % de taille (seuil < 25 %) et un delta de boot de +0,4 ms, **sous le plancher de bruit** de la mesure (l'étalement sur 7 ouvertures est de 2,2 ms) — la formulation honnête est « aucune différence de boot mesurable », pas « +0,4 ms ».

**Et mon seuil ne couvrait pas le bon axe.** J'avais pré-enregistré K2 sur la taille et le boot. Le coût réel que la mesure fait apparaître est ailleurs : **×2,29 sur l'écriture** de `thread_messages`. Je ne peux donc pas conclure « l'objection de coût de §6.5 tombe » au singulier. Ce que j'ai le droit de dire est plus étroit : *l'objection de coût **en taille de fichier et en temps de boot** ne tient pas ; l'objection de coût **en écriture** n'avait pas été formulée par §6.5, et elle est réelle.* La purge de 200 messages avec index prend 6,33 ms — chiffre relevé **avec** index seulement, je n'ai pas de référence sans, donc je n'en tire pas de ratio.

**Nuance sur le gain de recherche.** À 500 threads, un balayage met quelques millisecondes. Ce n'est pas une douleur. L'écart FTS5 décrit une différence de complexité, pas un problème actuel. La recherche ne se justifie donc pas par la latence — elle se justifierait par le besoin, et c'est K3 qui en décide. *Réserve supplémentaire : ma v1 comparait FTS5 à une requête `LIKE '%…%'` qui **n'existe nulle part dans le dépôt** — un homme de paille. Le dépôt n'a aucune recherche, pas une recherche lente.*

#### K3 — YAGNI (se déclenche)

```
"search"    -> 0 issue
"recherche" -> 0 issue
"full-text" -> 0 issue
```

**K3 se déclenche.** Le §6.5 avait raison sur ce point précis : le besoin est inféré d'un concurrent, pas d'un ticket.

#### K4 — le §4 point 3 est périmé (se déclenche)

Le §4 écrit : *« notre claim est un état de présence, pas une lease qui refuse la seconde prise »*. C'était vrai à la rédaction. Ça ne l'est plus depuis **#266**, qui a mis un refus dur dans `handleClaimTask` (`src/http/rest-handlers.ts:518-537`) :

```sql
UPDATE threads SET claimed_by = ?, claimed_at = ?
 WHERE id = ? AND org_id = ? AND claimed_by IS NULL AND status = 'open'
   AND (assigned_to IS NULL OR assigned_to = ?)
   AND NOT EXISTS (
     SELECT 1 FROM threads other
      WHERE other.org_id = threads.org_id AND other.id != threads.id
        AND other.status = 'open' AND other.claimed_by IS NOT NULL
        AND other.claimed_by != ?
        AND EXISTS (SELECT 1 FROM json_each(threads.target_files) mine
                    JOIN json_each(other.target_files) theirs ON mine.value = theirs.value))
```

Une prise est **refusée** si un autre agent détient un thread ouvert partageant un fichier cible. **K4 se déclenche** : la fiche décrit un manque qui a été comblé entre sa rédaction et son challenge.

#### K5 — le « delta = l'exclusivité » compare deux mécanismes advisory (se déclenche)

Des deux côtés :

```
-- src/database.ts:219-226
CREATE TABLE IF NOT EXISTS working_files (
  agent_id TEXT NOT NULL, file_path TEXT NOT NULL, started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL, claim_until TEXT NOT NULL,
  PRIMARY KEY (agent_id, file_path)
);
```

`PRIMARY KEY (agent_id, file_path)` : deux agents peuvent détenir le **même** `file_path`. Multi-détenteurs par construction — le constat est celui de `F02`, je le reprends vérifié. Et côté agent-mail, la §0 a déjà relevé que le README (l. 1670) dit *« reservations are still granted; conflicts are returned alongside grants »* : le refus dur n'y vient que de la garde `pre-commit`.

**K5 se déclenche.** Les deux réservations sont advisory au niveau MCP ; le §4 et le §6.5 opposent un manque à un manque.

**Ce que j'avais conclu ensuite était faux, et c'est la correction la plus importante de cette fiche.** J'avais écrit : *« une fois K4 pris en compte, le rapport de force s'inverse : nous avons un refus dur côté serveur, agent-mail n'en a pas »*. C'est une **erreur de catégorie**, et le code la contredit sur deux points que j'ai vérifiés après coup :

1. **#266 ne porte pas sur le même objet.** Il refuse une prise de **thread** (`UPDATE threads SET claimed_by = ?`). L'objet réellement en concurrence avec `file_reservation_paths`, c'est `working_files` — et `working-files-tracker.ts:31-44` est un **upsert inconditionnel**, sans une seule branche de refus :

```sql
INSERT INTO working_files (org_id, agent_id, file_path, started_at, last_activity_at, claim_until)
VALUES (...)
ON CONFLICT(org_id, agent_id, file_path) DO UPDATE SET
  last_activity_at = ..., claim_until = ...
```

Il ne regarde jamais si un autre agent tient le chemin. Mon propre K5 le démontrait par le schéma une section plus haut — et K4 l'oubliait.

2. **#266 n'est pas sur la surface comparée.** `claim_task` a **0 occurrence dans `src/tools/`** : c'est un endpoint REST, qu'aucun des 26 outils MCP n'expose. Or la surface où agent-mail nous concurrence est précisément MCP — Claude Code, Cursor, Cline, Aider. Un client MCP ne déclenche jamais ce refus.

**Conclusion corrigée : sur la surface MCP, nous n'avons rien de plus qu'agent-mail.** Deux mécanismes advisory, dont le sien a au moins l'honnêteté d'émettre un avertissement machine explicite. Le refus dur de #266 reste une vraie capacité, mais elle vit sur REST et sur un autre objet ; l'inscrire au crédit de la comparaison aurait été s'attribuer une force qu'on n'a pas.

C'est exactement l'erreur que `D02` a journalisée la veille — *« comparer les deux était une erreur de catégorie, pas une erreur de degré »* — commise dans l'autre sens, sur le même couple d'objets. Une fiche menace qui se prête une force inexistante est plus coûteuse qu'une fiche menace qui laisse une case vide.

#### K6 — « FTS5 nous lie plus fort à SQLite » est faux (se déclenche)

Le §6.5 s'appuie sur `src/db-adapter.ts`, « qui existe justement pour ne pas l'être ». Le fichier dit lui-même le contraire, dans son en-tête de conception :

> *« this file is the **contract** both `createBetterSqlite3` and `createBunSqlite` implement. The interfaces are a strict subset of better-sqlite3's API that Bun:sqlite also satisfies, so callers stay portable across **both runtimes**. »*

L'adaptateur abstrait **deux liaisons SQLite** — better-sqlite3 et bun:sqlite — pas deux moteurs. Il n'y a aucun couplage à desserrer, et FTS5 est disponible dans le binaire installé :

```
FTS5 disponible : OUI
requete MATCH   : [{"body":"le sweeper casse la chaine d audit"}]
sqlite_version  : 3.53.4
```

**K6 se déclenche : l'argument est nul.**

#### K7 — le décompte de la surface d'agent-mail (inmesurable)

```
uv      : ABSENT
python3 : ABSENT
python  : 3.12.10   (venv PlatformIO)
pip     : 26.1.1
```

Lancer `mcp_agent_mail` supposerait d'installer `uv` puis le projet sur le poste.

**Mais « je ne peux pas exécuter » n'est pas « je ne peux pas savoir », et j'avais confondu les deux.** Le protocole nomme le **code source** comme preuve documentaire de premier niveau, et le source d'agent-mail est public en HTTP non authentifié. J'ai donc réparé une partie de ce que j'avais déclaré hors de portée :

- **Vérifié moi-même, dans `db.py` :** `CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(message_id UNINDEXED, subject, body)`, plus trois triggers `fts_messages_ai` / `fts_messages_ad` / `fts_messages_au` dans `_setup_fts()`. C'est une table à contenu **interne** — l'index stocke une copie de `subject` et `body` — là où mon prototype utilisait `content=` externe. Nos deux chiffres de taille ne sont donc pas comparables.
- **Vérifié aussi :** `app.py` porte un `_filtered_tool_decorator` piloté par `settings.tool_filter.enabled` et `settings.tool_filter.profile` — le concurrent a une **surface d'outils filtrable par profil**. C'est un fait neuf, absent de la fiche, et qui touche `C06` plus que G01.

**Ce qui reste inmesurable, et que je refuse de publier :** le décompte exact d'outils. `app.py` fait ~650 kio, au-delà de ce qu'une requête me rend en une fois, et je n'ai pas pu compter les décorateurs moi-même. Un sous-agent avance 41 au boot et 49 au maximum ; **je ne reprends pas ce chiffre à mon compte** faute de l'avoir vérifié. La contradiction du §1 — surface « minimale » selon la fiche brute, ≥ 34 selon le vérificateur du 2026-08-14 — **reste donc ouverte**, mais elle penche nettement du côté du vérificateur : un projet qui a besoin d'un filtre par profil n'a pas une surface minimale. Notre propre décompte, lui, est vérifié : **26**.

#### K8 — ce qui reste défendable (ne se déclenche pas)

Non vide, mais nettement plus étroit que ce que j'avais d'abord écrit.

**Tient sans réserve :** le **multi-transport** — stdio (`src/index.ts`, `cli/channel.ts`) et Streamable HTTP (`src/serve-http.ts`) contre un concurrent qui refuse explicitement stdio (« No SSE, no STDIO », README l. 311) ; le **push temps réel** (`sse-emitter`, `mqtt-broker`, `mqtt-bridge`) contre un modèle inbox/pull ; et toute la **Phase 2** (`auth/`, `security/`, `admin/`, `quota/`), sans équivalent en face.

**Ne tient pas tel quel :** j'avais ajouté la détection sémantique « inchangée ». C'est démenti par une adjudication antérieure du même corpus. `D03` §7, tranchée le 2026-08-15, conclut mot pour mot : **« mcp-coordinator est un agrégateur de déclarations. »** Vérifié : `treeSitter.extract` n'a **qu'un** appelant de production (`src/http/rest-handlers.ts:979`), alimenté par un `body.content` **optionnel venu du client**, et les signaux du détecteur comparent des déclarations. La détection sémantique ne peut donc être portée au crédit qu'avec cette restriction — et elle est instruite sous **#275**.

**K8 ne se déclenche pas** : ce qui reste défendable n'est pas vide. Mais la liste honnête est celle-ci, pas celle du §4.

### 6.5 Contre-arguments

- **La comparaison est déséquilibrée par construction.** agent-mail est pré-1.0, taggé v0.3.4, README « Under active development ». Aligner une roadmap sur un projet qui peut casser sa surface d'API à chaque mineure est un mauvais pari ; ses ~2 000 étoiles mesurent l'attention, pas la stabilité.
- **Les artefacts Markdown dans Git sont un choix coûteux.** Écrire l'historique de coordination dans le dépôt de l'utilisateur pollue ses diffs, ses PR et son blame, et pose immédiatement des questions de RGPD (`docs/gdpr.md`) et de multi-org que notre SQLite chiffré (`src/boot-encryption.ts`) résout déjà. Ce qui ressemble à un avantage lisible est aussi une charge que l'auto-hébergeur n'a pas demandée.
- **FTS5 n'est pas gratuit.** Un index plein texte sur `thread_messages` augmente la taille du fichier, ajoute une migration de schéma à un `src/database.ts` de 66 Ko déjà dense, et nous lie plus fort à SQLite alors que `src/db-adapter.ts` existe justement pour ne pas l'être.
- **YAGNI sur la recherche.** Nos threads sont scopés par org et par session, et la plupart se ferment en quelques heures. Le besoin « retrouver une décision de la semaine dernière » n'a été remonté par aucun utilisateur à ce jour ; on l'infère d'un concurrent, pas d'un ticket.
- **Copier le concurrent sur son terrain est le pire arbitrage.** Nous perdons sur la traction ; nous gagnons sur l'analyse sémantique. Investir dans une inbox recherchable, c'est dépenser sur l'axe où il a deux ans d'avance et zéro sur celui où il n'a rien.
- **Le TTL est déjà là.** L'idée présentée comme « à récupérer » existe dans `working_files.claim_until` ; le delta réel se réduit à l'exclusivité et à la garde pre-commit. L'effort utile est donc bien plus petit que ce que la fiche brute laissait entendre — ce qui affaiblit aussi l'urgence.

---

## 7. Décision

Fiche menace : le verdict porte sur la **réponse** (`_CHALLENGE-PROMPT.md:126-127`), pas sur l'adoption.

| | |
|---|---|
| **Verdict** | **Réponse : acceptation assumée du recouvrement sur la lisibilité humaine.** ⬜ contre-mesure technique · ⬜ recadrage · ✅ **recouvrement réel, assumé** |
| **Date** | 2026-08-17 |
| **Justification** | Le recouvrement est **réel** (0 table FTS5, 0 `MATCH`, 0 outil de recherche sur 26, aucune commande CLI de lecture de threads), et **bon marché à combler** — mesuré : +22,6 % de taille, aucune différence de boot mesurable. On choisit de ne pas le combler, faute de besoin (**0** issue), pas faute de moyen. Ce n'est pas un cadrage à corriger : c'est une concession à assumer. |
| **Issue / PR** | une contre-mesure documentaire bornée, voir §7.3 |
| **Jalon visé** | aucun ; condition de réveil nommée en §7.2 |

### 7.1 La réponse à §6.1 — et pourquoi sa prémisse ne tient pas

**§6.1 est mal posée sur ses deux termes.**

*Le second terme est une erreur de catégorie.* Elle propose d'« assumer que la chaîne d'audit SHA-256 et le dashboard sont la seule surface de lecture ». Or la chaîne d'audit ne lit **rien** de l'historique de coordination. Ses champs hachés sont `action`, `actor_org_id`, `actor_ip`, `actor_user_agent`, `actor_user_id`, `metadata_json`, `outcome`, `request_id`, `target` (`src/security/audit-chain.ts`) — **aucun corps de message** — et `src/security/audit-events.ts` ne contient **0** occurrence de `thread`, `message` ou `consultation`. La chaîne couvre `audit_log`, un jeu de données **disjoint** de `thread_messages`. Opposer une intégrité vérifiable du journal d'auth à une lisibilité de contenu de consultation, c'est comparer deux objets sans intersection. Le §5 de la fiche porte la même erreur : « c'est l'anti-thèse de l'artefact Markdown » compare une garantie d'intégrité à une surface de lecture.

*Le premier terme confond deux décisions de coûts incomparables.* L'index FTS5 est une migration, chiffrable en octets et en millisecondes. L'export d'artefacts Markdown versionnés dans le dépôt de l'utilisateur est un **changement de contrat produit** qui touche la RGPD et le multi-org. Les traiter comme une seule option force un verdict unique sur deux questions indépendantes.

**Réponse, une fois la prémisse retirée :** la branche « statu quo » ne dit pas « on garde la chaîne d'audit et le dashboard comme surface de lecture ». Elle dit, une fois mesurée, **« on assume qu'il n'existe aucune surface de lecture humaine de l'historique de coordination »**. C'est plus dur, et c'est la position que je prends — en la nommant.

### 7.2 Ce qui est écarté, et à quelle condition ça se rouvre

**Pas d'artefacts Markdown dans Git.** L'objection de §6.5 tient et elle a maintenant une ligne : `docs/gdpr.md` exige que l'effacement atteigne les tables de Phase 1, en nommant `threads` et `messages`. Un historique versionné dans Git est immuable par construction. Les deux exigences sont incompatibles ; ce n'est pas un arbitrage de confort.

**Pas de FTS5 maintenant** — et il faut être précis sur le motif, parce que j'ai détruit la mauvaise objection avant de trouver la bonne. Le coût **en taille et en boot** ne justifie pas l'inaction : c'est mesuré, c'est faible. Le coût **en écriture** est réel (×2,29) mais ne suffirait pas non plus. Ce qui décide est K3 : **0 demande**.

**Condition de réveil, nommée** — un « pas maintenant » sans elle est un enterrement :

> Le premier ticket externe demandant de retrouver une décision passée, **ou** le jour où le dépôt se dote d'une surface de lecture humaine réellement exercée. L'ordre compte : **lire d'abord, chercher ensuite.** Indexer ce que personne ne lit ne sert à rien, et `D05` a mesuré que le dashboard ne l'est pas.

Avec une réserve sur K3 lui-même : « 0 issue » est un fait, mais sur un dépôt à deux contributeurs externes, « personne ne l'a demandé » est presque infalsifiable — l'argument vaudrait aussi contre le multi-org ou MQTT. Il porte le verdict **parce qu'il est adossé à la condition de réveil**, pas seul.

### 7.3 La frontière factuelle

**Ce que le concurrent fait**, vérifié dans son source : un index plein texte `fts_messages USING fts5(message_id UNINDEXED, subject, body)` avec ses trois triggers de synchronisation (`db.py`, `_setup_fts()`) ; une surface d'outils **filtrable par profil** (`_filtered_tool_decorator`, `settings.tool_filter.*` dans `app.py`) ; des artefacts Markdown versionnés dans Git ; des réservations de fichiers à TTL renouvelables.

**Ce qu'il ne fait pas :** aucune exclusivité **dure** sur les chemins — son README l'écrit (« reservations are still granted; conflicts are returned alongside grants ») et le refus n'existe que dans une garde `pre-commit` optionnelle ; pas de push (modèle inbox/pull) ; **pas de stdio** (« No SSE, no STDIO ») ; aucune couche org/auth/audit.

**Ce qui reste défendable :** le multi-transport, le push temps réel, et toute la Phase 2. **Et rien d'autre sans réserve** — la détection sémantique ne peut être revendiquée qu'avec la restriction mesurée par `D03` (« un agrégateur de déclarations »), instruite sous #275.

**La contre-mesure, bornée à une seule chose.** `docs/index.html` porte déjà une section « Why not alternatives? » avec cinq cartes comparatives. Il y manque la sixième — `mcp_agent_mail` — portant la frontière ci-dessus. C'est le seul livrable de cette fiche, et il est délibérément petit : la narration produit sur la chaîne d'audit est **déjà juste** (`README.md`, `docs/index.html` la cadrent sur `audit_log` et la conformité), et la seule phrase produit réellement fautive sur ce terrain appartient déjà à **#275** via `D03` §7.3. Ne pas la dupliquer.

### 7.4 Corrections à porter à la fiche, hors verdict

1. **§4 point 3 est périmé et de mauvais objet.** #266 a introduit un refus dur — mais sur le claim de *thread*, en REST, hors surface MCP. L'objet comparable, `working_files`, est un upsert inconditionnel (`working-files-tracker.ts:31-44`). La phrase « notre claim est un état de présence » reste **vraie pour `working_files`**, et le crédit que j'allais en tirer était une erreur de catégorie.
2. **§6.5, deux arguments faux.** « FTS5 augmente la taille » : vrai, +22,6 %, ordre de grandeur qui ne décide rien. « Nous lie plus fort à SQLite alors que `db-adapter.ts` existe pour ne pas l'être » : `db-adapter.ts` abstrait better-sqlite3 **contre** bun:sqlite — deux liaisons SQLite. *Réserve : `README.md` annonce toujours « SQLite (default) → Postgres (planned) », donc « aucun couplage à desserrer » serait trop fort ; FTS5 ne se porte pas vers Postgres.*
3. **§5 et §6.1** portent la même erreur de catégorie sur la chaîne d'audit (voir §7.1).
4. **§1** : la contradiction sur la surface d'outils reste ouverte, mais penche du côté du vérificateur — un projet doté d'un filtre d'outils par profil n'a pas une « surface minimale ».
5. **Ne pas écrire « 100 % de l'effort sur la détection sémantique »** tant que #275 n'a pas tranché ce que cette détection est.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : fiche saine, signature `file_reservation_paths` tranchée, décompte outils précisé, ligne schéma corrigée. |
| 2026-08-17 | Challenge. **Réponse : acceptation assumée du recouvrement sur la lisibilité humaine.** Mesuré : 0 table FTS5, 0 `MATCH`, 0 outil de recherche sur 26 ; coût d'un index FTS5 en régime réel (vraie prose, triggers, une transaction par message) = **+22,6 %** de taille, aucune différence de boot mesurable, **×2,29** en écriture ; **0** issue le réclamant. Il m'a fallu **trois** mesures : la première sous-estimait à +12 % (vocabulaire de 30 mots, index construit en masse, taille relevée sans `wal_checkpoint`, et un delta de boot de −79,6 ms qui comparait une création à froid à une ouverture à chaud). **Correction la plus grave :** j'allais publier que #266 nous donne un refus dur qu'agent-mail n'a pas — erreur de catégorie, `working_files` est un upsert inconditionnel et `claim_task` n'existe pas côté MCP. Vérifié dans le source du concurrent : `fts_messages` + trois triggers, et un filtre d'outils par profil. Le décompte exact de sa surface reste **inmesurable** et n'est pas repris. Corrections portées au §4 pt 3, §6.5, §5, §6.1 et K8. |
