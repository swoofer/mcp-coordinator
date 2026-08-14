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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

Proposition de protocole (non exécuté) :

- [ ] Installer et lancer `mcp_agent_mail` en `serve-http` sur un dépôt jouet, l'attacher à deux instances Claude Code, et observer le comportement réel de `file_reservation_paths` quand deux agents visent le même fichier : refus dur ou simple avertissement ?
- [ ] Mesurer le coût réel de `search_messages` (FTS5) contre notre `list_threads` sur un jeu de 500 threads synthétiques injectés dans `src/database.ts`, en tokens rendus à l'agent et en latence.
- [ ] Prototyper un `search_threads` sur une table FTS5 virtuelle adossée à `thread_messages` et mesurer l'impact sur la taille du fichier SQLite et sur le temps de boot (`src/boot.ts`).
- [ ] Vérifier si `install_precommit_guard` d'agent-mail est portable : peut-il coexister avec les hooks Claude Code que nous utilisons déjà pour alimenter `working_files` ?
- [ ] Compter précisément la surface d'outils exposée par agent-mail avec un vrai client MCP (`tools/list`) pour trancher la contradiction du §1, plutôt que par lecture de README.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **La comparaison est déséquilibrée par construction.** agent-mail est pré-1.0, taggé v0.3.4, README « Under active development ». Aligner une roadmap sur un projet qui peut casser sa surface d'API à chaque mineure est un mauvais pari ; ses ~2 000 étoiles mesurent l'attention, pas la stabilité.
- **Les artefacts Markdown dans Git sont un choix coûteux.** Écrire l'historique de coordination dans le dépôt de l'utilisateur pollue ses diffs, ses PR et son blame, et pose immédiatement des questions de RGPD (`docs/gdpr.md`) et de multi-org que notre SQLite chiffré (`src/boot-encryption.ts`) résout déjà. Ce qui ressemble à un avantage lisible est aussi une charge que l'auto-hébergeur n'a pas demandée.
- **FTS5 n'est pas gratuit.** Un index plein texte sur `thread_messages` augmente la taille du fichier, ajoute une migration de schéma à un `src/database.ts` de 66 Ko déjà dense, et nous lie plus fort à SQLite alors que `src/db-adapter.ts` existe justement pour ne pas l'être.
- **YAGNI sur la recherche.** Nos threads sont scopés par org et par session, et la plupart se ferment en quelques heures. Le besoin « retrouver une décision de la semaine dernière » n'a été remonté par aucun utilisateur à ce jour ; on l'infère d'un concurrent, pas d'un ticket.
- **Copier le concurrent sur son terrain est le pire arbitrage.** Nous perdons sur la traction ; nous gagnons sur l'analyse sémantique. Investir dans une inbox recherchable, c'est dépenser sur l'axe où il a deux ans d'avance et zéro sur celui où il n'a rien.
- **Le TTL est déjà là.** L'idée présentée comme « à récupérer » existe dans `working_files.claim_until` ; le delta réel se réduit à l'exclusivité et à la garde pre-commit. L'effort utile est donc bien plus petit que ce que la fiche brute laissait entendre — ce qui affaiblit aussi l'urgence.

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
| 2026-08-14 | Vérification des faits : fiche saine, signature `file_reservation_paths` tranchée, décompte outils précisé, ligne schéma corrigée. |
