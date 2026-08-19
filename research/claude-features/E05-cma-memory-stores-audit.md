# E05 — Memory stores : modèle pour la chaîne d'audit et la mémoire de repo partagée

| Champ | Valeur |
|---|---|
| **ID** | `cma-memory-stores-audit` |
| **Surface** | managed-agents |
| **Statut** | beta (public beta, header dédié `agent-memory-2026-07-22`) |
| **Disponible depuis** | `2026-07-22` — date du **header dédié**, pas nécessairement du lancement de la feature (voir §2) |
| **Tier** | T2-fort-levier |
| **Nature** | replace-homemade-code |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — angle (a) local OK, angle (b) exige API Managed Agents |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement : le patron sert pour le GDPR (#349), pas pour la rétention (#348) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — marqueur `(à vérifier)` de la ligne « Sur `since` » tranché : la note de bascule du header est confirmée mot pour mot dans la doc `managed-agents/memory` ; en revanche **aucune date de lancement réelle des memory stores n'est publiée** par Anthropic. Marqueur remplacé par le constat.
- §2 — complété la liste des query params de `GET .../memories` : `limit` (1–100, défaut 20, **plafonné à 20 quand `view=full`**) et `page` (curseur opaque `page_...`) manquaient. Ajout de la note sur les items `memory_prefix` retournés en rollup quand `depth=1`.
- §2 — précisé que `view` est aussi un query param sur `memories.update` (pas seulement sur list/retrieve).

**Vérifié sans changement** (tous confirmés par `platform.claude.com/docs/en/managed-agents/memory`, `/webhooks` et les références `/api/beta/memory_stores/…`) : le header `agent-memory-2026-07-22` et le 400 en cas de combinaison avec `managed-agents-2026-04-01` ; les 6 endpoints stores, 5 endpoints mémoires, 3 endpoints versions ; `POST` (et non `PATCH`) pour l'update ; l'absence de `restore` ; l'impossibilité de `redact` le head vivant ; `memory_version_id` comme pointeur de head faisant autorité et l'absence explicite d'`is_latest` ; `precondition {type: content_sha256}` → `memory_precondition_failed_error` HTTP 409, avec le 200 idempotent si l'état stocké correspond déjà ; 100 kB = 102 400 octets, 2 000 mémoires, 8 stores/session, `instructions` ≤ 4 096 car. ; `access` `read_write` (défaut) / `read_only` ; mount `/mnt/memory/<slug>` + `mount_path` + scratch perdu hors mount ; rétention 30 j avec conservation des versions récentes au-delà ; les 3 webhooks `memory_store.*` et l'absence d'événement par mémoire/version ; `client.beta.memory_stores.*` et `ant beta:memory-stores`. Statut **beta** toujours exact au 2026-08-14.

**§5 — points d'intégration :** les 10 fichiers cités existent tous. `insertAuditRowWithChain()` est bien défini à `src/security/audit.ts:137` et fait bien SELECT tip → `computeRowHash` → INSERT. `log_action_summary` est bien à `src/tools/consultation-tools.ts:441`. `SummaryContextProvider.getRelevantContext()` et `Consultation.getActionSummaries()` (`src/consultation.ts:630`) sont bien la seule chaîne de contexte partagé. `audit_log` est bien `INTEGER PRIMARY KEY AUTOINCREMENT` (`src/database.ts:312`) avec `prev_hash`/`row_hash` ajoutés par migration (l. 813 / 818). L'en-tête de `audit-chain.ts` documente bien les deux trous « Timestamp integrity » et « Deletion ». Et `canonicalRowFields()` inclut bien `metadata_json` et `target` — la remarque de la fiche (un caviardage de ces champs casserait `row_hash`) est exacte.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
L'angle (a) — le patron `redact` appliqué à notre chaîne d'audit — est intégralement testable ici : `src/sweeper/index.ts`, `scripts/verify-audit-chain.ts` (exit 0/1/2, gère les deux algorithmes) et `tests/unit/audit-chain-integration.test.ts` sont tous présents, et les 5 étapes du §6.3 ne demandent qu'une DB SQLite locale. L'angle (b) — monter un memory store réel — n'est pas exécutable : il faut une clé API Anthropic avec le header beta `agent-memory-2026-07-22`, un workspace Managed Agents, un agent avec l'*agent toolset* activé et un environment ; rien de tout cela n'est disponible sur le poste.

---

## 1. Ce que c'est

Un *memory store* est une collection de documents texte scopée au workspace, montée comme un répertoire dans le sandbox d'une session Managed Agents (`/mnt/memory/<slug>`, le chemin exact étant renvoyé dans `mount_path`). L'agent y lit et y écrit avec ses outils fichiers habituels — aucun outil dédié — et une note décrivant chaque montage est injectée automatiquement dans le system prompt. Un store s'attache **uniquement à la création de session**, via `resources[]`, avec un `access` (`read_write` par défaut, ou `read_only`) et des `instructions` libres plafonnées à 4096 caractères. Les quotas sont durs : 8 stores par session, 2000 mémoires par store, 100 kB (102 400 octets) par mémoire.

L'intérêt pour nous n'est pas d'abord la mémoire mais le **modèle de versionnement**. Chaque mutation d'une mémoire crée une `memory version` immuable (`memver_...`) qui survit à la suppression de la mémoire parente : c'est une chaîne d'audit consultable, avec un endpoint `redact` qui efface le contenu tout en conservant qui/quoi/quand. Les écritures concurrentes se protègent par un compare-and-swap explicite (`precondition: {type: "content_sha256", ...}`), qui renvoie 409 en cas de divergence. Le prérequis d'activation est que l'*agent toolset* soit activé à la création de l'agent, sans quoi l'agent ne peut pas lire le mount. La doc porte un avertissement de sécurité explicite : un store `read_write` exposé à une injection de prompt devient de la mémoire empoisonnée pour toutes les sessions suivantes.

## 2. Surface d'API exacte

```
Header beta : anthropic-beta: agent-memory-2026-07-22
  -> NE PAS combiner avec managed-agents-2026-04-01 sur le même appel (=> 400).
  -> Les endpoints de session, y compris l'attachement d'un store, restent
     sous managed-agents-2026-04-01.

Stores (ids memstore_...) :
  POST   /v1/memory_stores                       body: name, description
  GET    /v1/memory_stores                       query: include_archived
  GET    /v1/memory_stores/{memory_store_id}
  POST   /v1/memory_stores/{memory_store_id}     (update)
  POST   /v1/memory_stores/{memory_store_id}/archive   (irréversible, pas d'unarchive)
  DELETE /v1/memory_stores/{memory_store_id}

Mémoires (ids mem_...) :
  POST   /v1/memory_stores/{id}/memories                body: path, content
  GET    /v1/memory_stores/{id}/memories                query: path_prefix (doit finir par "/"),
                                                        depth (0 ou 1, sinon 400), view,
                                                        limit (1..100, défaut 20), page
  GET    /v1/memory_stores/{id}/memories/{memory_id}
  POST   /v1/memory_stores/{id}/memories/{memory_id}    (update — POST, PAS PATCH)
                                                        body: content, path, precondition
                                                        query: view
  DELETE /v1/memory_stores/{id}/memories/{memory_id}

  view=basic|full : content vaut null en basic ; content_sha256 et
  content_size_bytes sont toujours peuplés. view=full plafonne limit à 20
  (c'est le chemin de bulk-read pour export/sync).
  depth=1 fait remonter des items {type: "memory_prefix", path} en rollup,
  qui comptent dans le limit de la page.

Versions (ids memver_...) :
  GET    /v1/memory_stores/{id}/memory_versions              query: memory_id (plus récent d'abord)
  GET    /v1/memory_stores/{id}/memory_versions/{memver_id}
  POST   /v1/memory_stores/{id}/memory_versions/{memver_id}/redact

SDK / CLI : client.beta.memory_stores.*   |   ant beta:memory-stores ...
Webhooks : memory_store.created, memory_store.archived, memory_store.deleted
           (les mémoires et versions individuelles n'émettent AUCUN événement)
```

Compare-and-swap et attachement de session :

```json
// update d'une mémoire avec garde optimiste
{
  "content": "…",
  "precondition": { "type": "content_sha256",
                    "content_sha256": "<64 hex minuscules>" }
}
// mismatch -> HTTP 409, memory_precondition_failed_error
// si l'état stocké correspond DÉJÀ exactement au content/path demandés -> 200 (idempotence)

// attachement au moment de la création de session, dans resources[]
{ "type": "memory_store", "memory_store_id": "memstore_…",
  "access": "read_write", "instructions": "… (≤ 4096 car.)" }
```

Points de surface à ne pas se rater :

- Pas d'endpoint `restore`. Restaurer = relire la version puis réécrire via `memories.update` (ou `memories.create` si le parent a été supprimé).
- Une version qui est le **head vivant** d'une mémoire **ne peut pas** être `redact`ée : il faut d'abord écrire une nouvelle version, ou supprimer la mémoire. Un workflow naïf « droit à l'effacement » casse ici.
- Le champ `memory_version_id` porté par l'objet memory est le pointeur de head faisant autorité. Il n'existe **pas** de flag `is_latest`.
- Rétention des versions : 30 jours, **mais les versions récentes sont toujours conservées quel que soit leur âge**. Une mémoire peu modifiée garde donc de l'historique au-delà de 30 jours. Pour une rétention longue, l'export via API est requis.
- Les écritures sous `mount_path` sont persistées ; les écritures **ailleurs sous `/mnt/memory/`** atterrissent dans un scratch container-local et sont perdues en fin de session.
- Slug de montage = display name en minuscules, toute suite de caractères non alphanumériques réduite à un seul tiret.
- Sur `since` : la doc note qu'au 22 juillet 2026 `managed-agents-2026-04-01` adopte le même comportement de `list`, ce qui implique que les stores existaient avant sous l'ancien header. La date ci-dessus est celle du header dédié, pas d'un lancement. **Vérifié 2026-08-14 :** la note de bascule est bien présente telle quelle dans la doc, mais Anthropic ne publie aucune date de lancement réelle des memory stores — celle-ci est donc *(non vérifiable — non documentée)*.

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/memory
- https://platform.claude.com/docs/en/managed-agents/sessions
- https://platform.claude.com/docs/en/managed-agents/webhooks
- https://platform.claude.com/docs/en/api/beta/memory_stores/

> Note de méthode : une source de la fiche brute (`releasebot.io`, agrégateur tiers) n'a pas été vérifiée et a été retirée au profit des deux pages officielles ci-dessus.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu — deux angles distincts.**

*(a) Modèle de conception pour notre chaîne d'audit maison.* `src/security/audit-chain.ts` implémente déjà une chaîne append-only (SHA-256 non clé, ou HMAC-SHA256 dérivé par HKDF de la master key quand `COORDINATOR_ENCRYPTION_KEY` est posée), et son propre commentaire d'en-tête liste deux trous qu'il n'adresse pas : intégrité des horodatages, et détection des suppressions (le sweeper efface les lignes au-delà du TTL et laisse des trous d'id indiscernables d'une falsification). Le triptyque d'Anthropic — version immuable + `redact` qui préserve les métadonnées + `precondition content_sha256` — est exactement la réponse au second trou : au lieu de supprimer une ligne d'audit expirée, on la *caviarde* en gardant qui/quoi/quand, et la chaîne reste vérifiable de bout en bout. Ce n'est pas une adoption d'API, c'est un patron à recopier dans `src/sweeper/index.ts` (aujourd'hui `audit_retention_days` = 365, `audit_tier2_retention_days` = 90, tous deux en DELETE sec) et dans `scripts/verify-audit-chain.ts`. Le bénéficiaire est l'auto-hébergeur en démarche SOC 2, qui ne peut aujourd'hui pas prouver qu'un trou d'id vient du sweeper.

*(b) Nouvelle capacité — une mémoire de repo partagée entre agents.* Notre partage de contexte inter-agents est aujourd'hui un dérivé calculé : `src/context-provider.ts` recoupe les modules déclarés d'un agent avec les `target_modules` d'une annonce et renvoie les `action_summaries` (écrits par l'outil `log_action_summary`, `src/tools/consultation-tools.ts:441`). Il n'existe aucune surface où un agent écrit une connaissance durable — convention de repo, piège connu, décision d'archi. Un memory store scopé au repo, monté `read_write` pour les agents de confiance et `read_only` pour les autres, comblerait ce manque sans que nous ayons à concevoir un schéma de stockage, un versionnement et un contrôle d'accès. En contrepartie exacte, l'avertissement d'empoisonnement de la doc s'applique intégralement à notre modèle multi-agents : un agent compromis pollue durablement tous les suivants.

**Risque si on ne fait rien :** faible et non existentiel. La chaîne d'audit actuelle reste valide pour la tamper-evidence ligne-à-ligne ; elle reste juste incapable de distinguer une purge légitime d'une suppression malveillante, et ce point sera relevé par tout auditeur externe. Le manque de mémoire partagée est un manque de capacité, pas une régression.

## 5. Points d'intégration dans le repo

Chemins vérifiés par lecture directe.

| Fichier / module | Impact |
|---|---|
| `src/security/audit-chain.ts` | Cœur du sujet. Son en-tête documente déjà les limites « timestamp » et « deletion ». Le modèle `redact` (effacer le contenu, garder les métadonnées et le maillon) est le patron à évaluer ici. `canonicalRowFields` devrait alors exclure les champs caviardables, sinon un redact casse le `row_hash`. |
| `src/security/audit.ts` | `insertAuditRowWithChain()` (l. 137) fait SELECT tip → compute → INSERT. Si l'on introduit un caviardage, c'est ici que la sémantique « head vs version » doit se décider. |
| `src/sweeper/index.ts` | Aujourd'hui `audit_retention_days` (365) et `audit_tier2_retention_days` (90) déclenchent un DELETE. C'est le fichier à convertir en « redact au lieu de delete » si le patron est retenu. |
| `scripts/verify-audit-chain.ts` | Le vérificateur (exit 0/1/2, gère déjà les deux algorithmes) devrait distinguer trou-par-purge et trou-par-falsification. C'est le livrable qui rend la démarche démontrable. |
| `src/security/audit-queue.ts` | Chemin Tier 2 batché. Toute nouvelle colonne de version/caviardage doit y être répercutée, sinon la chaîne diverge entre Tier 1 et Tier 2. |
| `src/database.ts` | Schéma `audit_log` (`prev_hash`, `row_hash`, AUTOINCREMENT). Une colonne `redacted_at` ou un statut de version implique une migration. |
| `src/context-provider.ts` | Angle (b). `SummaryContextProvider.getRelevantContext()` est aujourd'hui le seul mécanisme de contexte partagé ; une mémoire de repo s'insérerait à côté, pas dedans. |
| `src/tools/consultation-tools.ts` | `log_action_summary` (l. 441) est le plus proche cousin d'une écriture de mémoire. Point de comparaison pour dimensionner un éventuel outil `remember` / `recall`. |
| `src/consultation.ts` | `getActionSummaries()` alimente le context-provider ; à confronter au modèle « store scopé + accès read_only ». |
| `docs/ARCHITECTURE.md` | À mettre à jour si la sémantique de rétention d'audit change (purge → caviardage). |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Adopte-t-on le patron `redact` d'Anthropic dans notre propre sweeper — caviarder les lignes d'`audit_log` expirées au lieu de les `DELETE`, pour que `verify-audit-chain.ts` distingue enfin une purge légitime d'une suppression malveillante — ou accepte-t-on que la chaîne reste trouée et compense-t-on par l'attestation externe de tip déjà décrite dans l'en-tête de `audit-chain.ts` ?

### 6.2 Hypothèse

**Ce que je pense avant de mesurer.** La fiche et les deux commentaires d'en-tête (`audit-chain.ts:26-30`, `verify-audit-chain.ts:39-43`) décrivent le même état supposé : le sweeper supprime des lignes, `verify-audit-chain.ts` signale les trous d'id **sans les qualifier**, mais la chaîne **reste vérifiable** — les `id_gap_before` sont explicitement exclus des `verificationFailures` (l. 333-335), donc exit 0.

Or la lecture du code contredit cette prémisse sur un point précis, et c'est ce que je vais mesurer. Le vérificateur est construit pour une **suppression de préfixe** — son propre commentaire le dit (`verify-audit-chain.ts:128-132` : *« robust to legitimate front-deletion by the retention sweeper »*), et c'est vrai : la première ligne survivante voit son `prev_hash` accepté verbatim. Mais le sweeper ne supprime pas un préfixe. Il exécute **deux DELETE avec deux TTL différents sur la même table**, discriminés par `action IN (...)` (`sweeper/index.ts:256-275`) : Tier 1 à 365 j, Tier 2 à 90 j, sur deux listes disjointes (`audit-events.ts`). Entre 90 et 365 jours, les lignes Tier 2 partent et les lignes Tier 1 restent — donc des **trous au milieu**, pas devant.

Hypothèse : à partir du 91ᵉ jour, sur tout déploiement mêlant les deux tiers, la purge **légitime** casse le chaînage `prev_hash` et fait sortir `verify-audit-chain.ts` en **exit 1**. Si c'est vrai, le sujet de cette fiche n'est plus « peut-on qualifier un trou ? » mais « notre vérificateur d'audit est-il utilisable au-delà de 90 jours ? » — et le livrable est un défaut chez nous, pas un emprunt à Anthropic.

Sur l'angle (b) — mémoire de repo partagée — l'hypothèse est plate : personne ne l'a demandée, et le mode d'échec documenté par Anthropic (mémoire empoisonnée persistante) est plus grave que le manque comblé.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ces critères sont écrits **avant** d'exécuter quoi que ce soit. Un seul qui se déclenche tue `adopter` pour l'angle concerné.

| # | Angle | Critère de mort | Seuil chiffré |
|---|---|---|---|
| **K1** | (a) | **Le problème n'est pas celui qu'on croit.** Si le sweeper réel, avec ses deux TTL et les vraies listes d'actions, laisse la chaîne vérifiable (`exit 0`, findings uniquement `id_gap_before`), alors le seul manque est la *qualification* d'un trou — un problème documentaire, pas structurel, et `redact` est surdimensionné. | `verify-audit-chain.ts` sort **0** après une purge sweeper mixte Tier 1/Tier 2 |
| **K2** | (a) | **Le caviardage détruit ce qu'il prétend préserver.** Si nullifier les champs caviardables oblige à les retirer de `canonicalRowFields`, la tamper-evidence disparaît sur ces champs pour **toutes** les lignes, y compris les vivantes. Le remède est alors pire que le mal si ces champs portent la charge utile. | > **50 %** des lignes d'audit réelles ont un `metadata_json` non nul |
| **K3** | (a) | **La migration invalide l'historique.** Le commentaire de `canonicalRowFields` (l. 131-137) interdit d'ajouter un champ sans stratégie de versionnement ; en retirer un a la même conséquence. Si les lignes pré-migration cessent de se vérifier, l'effort n'est pas `L` mais une migration de chaîne complète. | ≥ **1** ligne pré-migration devient `wrong_row_hash` |
| **K4** | (a) | **Le caviardage ne libère rien.** Le sweeper existe pour borner la croissance. Si une ligne caviardée coûte encore l'essentiel d'une ligne pleine, on garde le coût et on perd la purge. | la part caviardable (`metadata_json` + `target`) < **50 %** des octets d'une ligne moyenne |
| **K5** | (a) | **Deux chemins à modifier, pas un.** Si `audit-queue.ts` (Tier 2 batché) construit sa chaîne par un code distinct de `insertAuditRowWithChain`, tout changement de sémantique doit être fait deux fois et testé deux fois. | le calcul de `prev_hash`/`row_hash` est dupliqué dans ≥ **2** fichiers |
| **K6** | (a) | **L'emprunt est une projection.** Si `redact` chez Anthropic ne conserve pas réellement qui/quoi/quand, ou ne s'applique pas au head vivant (ce que §2 affirme déjà), le patron ne transpose pas à un log append-only dont **chaque** ligne est un head. | la doc Anthropic contredit la lecture de §4 |
| **K7** | (b) | **YAGNI.** Aucune demande utilisateur pour une mémoire de repo partagée. | **0** issue ou discussion GitHub la réclamant |
| **K8** | (b) | **Dépendance réseau dans un produit hors-ligne.** Si l'angle (b) n'est atteignable que par une API Anthropic beta, il crée deux classes d'agents (clients Anthropic vs autres clients MCP) dans un coordinateur qui sert du MCP générique. | le montage exige un workspace Managed Agents — déjà établi en §0 |

**Règle que je m'impose :** l'angle (b) n'est **pas** exécutable ici (§0). Il ne peut donc jamais recevoir `adopter` — au mieux `reporter`, quel que soit le résultat des mesures de l'angle (a).

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ L'angle (b) n'est pas exécutable ici : monter un memory store réel exige une clé API Anthropic avec le header beta `agent-memory-2026-07-22`, un workspace Managed Agents et un agent avec l'*agent toolset* activé. Seul l'angle (a) — le patron `redact` sur notre propre `audit_log` — est testable en local.

- [ ] Sur une DB de test, écrire ~50 lignes d'audit, lancer le sweeper avec un TTL court, puis `tsx scripts/verify-audit-chain.ts --json` : capturer la sortie exacte et confirmer que les trous d'id sont bien signalés sans pouvoir être qualifiés.
- [ ] Rejouer le même scénario en simulant une suppression malveillante (DELETE direct au milieu de la chaîne) et comparer les deux rapports : sont-ils réellement indistinguables ?
- [ ] Prototyper un caviardage : ajouter `redacted_at` + nullifier `metadata_json`/`target` sur les lignes expirées au lieu de les supprimer, et mesurer si `computeRowHash` reste vérifiable — c'est-à-dire déterminer quels champs doivent sortir de `canonicalRowFields`.
- [ ] Mesurer le coût en volume : combien de lignes `audit_log` conservées à 365 jours sur un déploiement réaliste si l'on ne supprime plus rien (le caviardage ne libère que le contenu, pas la ligne).
- [ ] Vérifier que le chemin Tier 2 (`audit-queue.ts`) produit la même chaîne que le chemin Tier 1 après modification, via `tests/unit/audit-chain-integration.test.ts`.

### 6.4 Résultat observé

#### A. Le résultat qui renverse la fiche — la purge de rétention ne troue pas la chaîne, elle la **casse**

50 lignes écrites par le vrai `audit()`, vieillies de 100 jours, puis vrai `Sweeper.runPass()`, puis vrai `scripts/verify-audit-chain.ts` :

```
lignes ecrites        : 50   (25 actions Tier 1, 25 actions Tier 2, alternees)

--- verify-audit-chain.ts AVANT sweeper ---
  exit code  : 0        ok : true     findings : {}

sweeper deletions : {"audit_log_tier1":0,"audit_log_tier2":25,...}
lignes restantes  : 25 -> ids 1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,...,49

--- verify-audit-chain.ts APRES sweeper ---
  exit code  : 1        ok : false
  findings   : {"id_gap_before":24,"wrong_prev_hash":24}
```

La prémisse de §6.1, celle de l'en-tête d'`audit-chain.ts:26-30`, celle de `verify-audit-chain.ts:39-43` et celle de `docs/ops/audit-integrity.md:35-41` sont **les mêmes et toutes fausses** : elles supposent que la purge laisse des trous *informationnels*. La purge produit `wrong_prev_hash` — que `docs/ops/audit-integrity.md:78-81` définit comme « a middle row was deleted » (falsification), et dont `:139-141` dit : « **A failing verification (exit 1) should page the on-call engineer immediately — this is a Tier 1 security signal.** »

La cause est structurelle : le sweeper exécute **deux DELETE avec deux TTL sur la même table** (`sweeper/index.ts:256-275`), discriminés par `action IN (...)` — Tier 1 à 365 j, Tier 2 à 90 j. Il supprime donc *par âge **et** par action*, c'est-à-dire des lignes du **milieu**. Or le dépôt affirme le contraire, noir sur blanc, dans son propre test (`tests/unit/verify-audit-chain.test.ts:215-217`) :

> « The retention sweeper never deletes middle rows — it deletes by age, oldest first. **A middle gap is an attacker signature.** »

Ce n'est pas un faux positif isolé : sur 40 lignes, une purge Tier 2 produit **19 `wrong_prev_hash`** — à peu près un par ligne survivante. Après le 91ᵉ jour, le seul détecteur de falsification du projet devient **intégralement du bruit**, et le runbook entraîne l'opérateur à ignorer une astreinte Tier 1 de routine.

#### B. Périmètre exact — correction d'une erreur de ma part

Mon second banc (`k1b`) était étiqueté « déploiement mono-tenant **sans OAuth** ». **C'est faux**, et la passe adversariale l'a relevé : `audit("config.boot")` (`boot.ts:544`) et `audit("encryption.config.loaded")` (`boot-encryption.ts:390`, appelé depuis `boot.ts:499`) sont **tous deux à l'intérieur de `bootPhase2`**, qui retourne `null` en `boot.ts:164` quand OAuth est désactivé. `k1b` mesure donc un déploiement **Phase 2**, pas Phase 1. Le périmètre honnête :

| Profil | Écrit | Verdict |
|---|---|---|
| **Phase 2 (OAuth activé)** | Tier 1 + Tier 2 + 5 actions non classées | **casse à J+91**, certain |
| **Phase 1 mono-tenant** | `auth.invalid_token` seul (Tier 2, `src/auth.ts`) | **échappe** — chaîne mono-tier ⇒ purge en préfixe strict ⇒ exit 0 |
| Phase 1 **après un upgrade** | + `migration.audit_backfill` (Tier 1) en tête | **casse** — une seule ligne d'un autre tier suffit |

Le cas minimal a été mesuré : **une** ligne survivante en tête d'un bloc purgé suffit pour un `wrong_prev_hash` et l'exit 1.

Et le sweeper tourne dans **tous** les profils — vérifié, le « WIRING NOTE » ne ment pas : `boot.ts:541` (`sweeper.start()` dans `bootPhase2`) et `serve-http.ts:1282-1286` (`if (!phase2Bootstrap) retentionSweeper.start()`).

#### C. Cinq actions ne sont dans aucun tier — et cela condamne le correctif le plus évident

```
actions distinctes emises dans src/ : 36
  classees Tier 1 (TTL 365 j) : 19
  classees Tier 2 (TTL  90 j) : 12
  DANS AUCUNE LISTE (jamais purgees) : 5
    auth.idp.token_refreshed        <- src\auth\refresh-rotation.ts:764
    encryption.config.loaded        <- src\boot-encryption.ts:390
    encryption.decrypt.failed       <- src\auth\refresh-rotation.ts:661
    encryption.key.rotation_begin   <- src\boot-encryption.ts:288
    encryption.token.invalidated    <- src\boot-encryption.ts:250
```

Ces cinq-là sont des **ancres perpétuelles**, par choix délibéré (`audit-events.ts:23-27`, épinglé par `tests/unit/sweeper.test.ts:376`). Conséquence : « faire supprimer au sweeper un préfixe strict » est **structurellement impossible**, pas seulement coûteux — `encryption.config.loaded` est émis au boot, donc un sweeper-préfixe s'arrêterait à la première ligne de démarrage et ne supprimerait plus jamais rien.

#### D. Le second défaut, plus net que le premier : notre propre runbook GDPR casse la chaîne

`docs/gdpr.md` prescrit à l'opérateur, en SQL manuel, deux `UPDATE` sur `audit_log` (`:199` et `:313-317`). Les deux colonnes visées — `actor_user_id` et `metadata_json` — sont **dans `canonicalRowFields`** (`audit-chain.ts:144`, `:146`). Runbook rejoué verbatim sur le vrai chemin :

```
lignes avec actor_user_id non NULL : 10/10
  avant le runbook GDPR            exit 0  ok=true   {}
  UPDATE #1 (anonymisation)  -> 10 ligne(s)
  UPDATE #2 (ticket SAR)     -> 10 ligne(s)
  apres le runbook GDPR            exit 1  ok=false  {"wrong_row_hash":10}
```

`wrong_row_hash` est défini par `audit-integrity.md:78` comme « the row content has been **mutated in place** after the original insert » — la définition même de la falsification. Et le runbook affirme à la ligne suivante (`gdpr.md:202-205`) que « SOC 2's *complete audit trail* requirement is satisfied ». Le même document explique par ailleurs (`gdpr.md:190-194`) que `scripts/lint-no-audit-mutation.sh` rend l'`UPDATE audit_log` « impossible to merge » — **le projet interdit dans le code ce qu'il prescrit dans le runbook**, et le faire déclenche son propre signal d'incident.

Nuance décisive, vérifiée : `withAuditContext` n'a **aucun site d'appel en production** (issue **#319**, ouverte), donc `actor_user_id` est toujours `NULL` et le `WHERE actor_user_id = ?` du runbook ne matche rien **aujourd'hui**. Ce défaut est donc **armé, pas actif** — et il s'active le jour où #319 est corrigée. Mais l'`UPDATE #2` vise `metadata_json`, et c'est précisément là que `audit-helpers.ts:57` range le `client_ip` : une demande d'effacement qui doit scrubber une IP tape la colonne hachée, sans dépendre de #319.

#### E. Le patron **transpose** — mes deux premières justifications étaient fausses

J'allais écrire que le patron ne transpose pas, pour deux raisons. La passe adversariale a démoli les deux, mesure à l'appui, et je les corrige :

1. **« Chez Anthropic on ne caviarde jamais un enregistrement vivant ; chez nous chaque ligne est un head vivant. »** — Mauvaise correspondance. Une ligne d'`audit_log` correspond à une **`memory version`**, pas à une mémoire ; le *head* n'est pas chaque ligne, c'est **la tip**, une seule. Toute ligne est supersédée dès qu'une suivante est écrite, et le sweeper ne touche que des lignes de ≥ 90 jours. La contrainte d'Anthropic (« write a new version first ») est donc **automatiquement satisfaite chez nous**, jamais violée.
2. **« Caviarder obligerait à sortir `metadata_json` de `canonicalRowFields`, détruisant la tamper-evidence de 98 % des lignes. »** — Faux : dans un design tombstone on **préserve** le `row_hash` stocké au lieu de le recalculer. Mesuré :

```
S0 baseline                                          exit=0  {}
S2 tombstone 6 lignes du milieu, row_hash PRESERVE   exit=1  {"wrong_row_hash":6}   <- 0 wrong_prev_hash, 0 id_gap
S3 tombstone + row_hash RECALCULE (l'erreur naive)   exit=1  {"wrong_prev_hash":6}
```

S2 est décisif : **le chaînage survit intégralement au caviardage**. `canonicalRowFields` ne bouge pas d'un octet. Ce qui reste — les lignes caviardées ne sont plus vérifiables *par leur contenu* — est inhérent et se règle par une règle côté vérificateur.

Un piège mesuré au passage : le mécanisme de préfixe d'algorithme déjà présent (`algorithmOf`, `hmac-sha256-v1:`) **n'est pas recyclable tel quel**, parce que `audit-chain.ts:195-198` fait porter au `prev_hash` le `row_hash` complet *préfixe compris* — préfixer une ligne caviardée casserait le maillon suivant. Il faut une colonne hors-hash (`redacted_at`) ou un `stripRedactionPrefix()` dans l'avance de chaîne.

#### F. Ce qui tue l'adoption n'est donc pas la faisabilité, c'est la cible et le coût

- **Coût de stockage — K4 se déclenche.** Sur des lignes réelles, la part caviardable (`metadata_json` + `target`) est de **20,5 %** ; `prev_hash` + `row_hash` pèsent **58,3 %** et sont **incompressibles** (128 o/ligne non keyed, 158 o keyed). Une ligne tombstonée coûte ~80 % d'une ligne pleine et `audit_log` ne décroît plus jamais. Sensibilité honnête : K4 basculerait si le `metadata_json` moyen dépassait ~175 o/ligne — chiffre à confirmer sur un vrai déploiement, pas sur des lignes synthétiques.
- **La valeur livrée est nulle sur la cible « rétention ».** Le patron vend « conserver **qui**/quoi/quand ». Chez nous il n'y a **pas de *qui*** : `actor_user_id`, `actor_org_id`, `actor_ip`, `actor_user_agent` sont NULL sur 100 % des lignes écrites en production (#319, vérifiée : zéro site d'appel de `withAuditContext`). Et `created_at` — le *quand* — **n'est pas dans le hash** (`audit-chain.ts:19-25`). Une ligne caviardée ne conserverait que `action`, `outcome`, `request_id`.
- **Et il existe deux correctifs qui font le même travail pour un dixième du prix.** Mesuré :

| scénario | vérificateur actuel | option (b) « tolérer un `prev_hash` non vérifiable après un trou d'id » |
|---|---|---|
| purge sweeper légitime | **exit 1** — `id_gap ×19`, `wrong_prev_hash ×19` | **exit 0** ✅ |
| attaquant efface la ligne 20 | exit 1 | **exit 0** ❌ détection perdue |
| attaquant efface le bloc 15..24 | exit 1 | **exit 0** ❌ détection perdue |
| attaquant réécrit la ligne 20 en place | exit 1 — `wrong_row_hash` | exit 1 ✅ préservée |

  L'option **(d)** domine et n'était dans aucune liste de la fiche : **le sweeper déclare sa propre purge dans la chaîne** — `DELETE … RETURNING id`, puis une ligne Tier 1 `retention.audit_purged` portant les plages, et le vérificateur ne tolère un trou que s'il est **couvert par une déclaration**. Coût : ~30 lignes dans le sweeper, aucune migration, `canonicalRowFields` intact, **aucun des 4 sites de calcul de chaîne touché**, rétention à deux tiers préservée, croissance toujours bornée — et en déploiement keyed la déclaration est infalsifiable. (Piège : n'émettre que si `count > 0`, sinon 1 440 lignes/jour.)

- **Troisième défaut trouvé en chemin.** `docs/ops/audit-integrity.md:87-134` affirme que le workflow de tip-attestation distingue purge et falsification. **Il ne le fait pas** pour une suppression du milieu : l'attestation compare le `prev_hash` de la première ligne à la tip précédente, et une suppression au milieu ne change ni l'une ni l'autre. Ce que l'option (b) « sacrifie » n'était donc **déjà** rattrapé par rien.

#### G. Et l'outil n'est livré nulle part

```
package.json  files: ["dist/src/","dist/cli/","dashboard/","LICENSE","README.md"]   -> pas de scripts/
Dockerfile    COPY dist, node_modules, package.json, dashboard, LICENSE            -> pas de scripts/
```

`scripts/verify-audit-chain.ts` n'est publié ni sur npm ni dans l'image Docker. Le `README.md:397` l'annonce comme outillage opérationnel et `docs/ops/audit-integrity.md:146` le câble dans un cron en chemin absolu — pour un fichier que seul un cloneur du dépôt possède. C'est ce qui borne la gravité : population réellement exposée ≈ 0. C'est aussi, en soi, une promesse non tenue.

#### H. Adjudication des huit critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | exit 0 après purge mixte | exit **1**, `wrong_prev_hash ×24` (et ×19 sur 40 lignes) | **NE SE DÉCLENCHE PAS** — et l'inverse est vrai : le problème est plus grave que la fiche ne le dit |
| **K2** | > 50 % de `metadata_json` non nul | 61/62 sites portent un `metadata` — **mais l'antécédent est faux** : le tombstone ne touche pas `canonicalRowFields` (mesure S2) | **NE SE DÉCLENCHE PAS** — seuil atteint, prémisse fausse |
| **K3** | ≥ 1 ligne pré-migration en `wrong_row_hash` | aucune ligne pré-migration dans une base neuve ; l'amputation naïve casse 25/25, mais ce n'est pas le design retenu | **INMESURABLE ici** — pas « non déclenché » |
| **K4** | part caviardable < 50 % | **20,5 %** ; `prev_hash`+`row_hash` = 58,3 %, incompressibles | **SE DÉCLENCHE** (bascule si `metadata_json` > ~175 o/ligne) |
| **K5** | calcul de chaîne dupliqué ≥ 2 fichiers | **4 fichiers / 5 sites** (`audit.ts:144`, `audit-queue.ts:138` et `:222`, `boot-orgs-uniqueness.ts:270`, `database.ts:59`) | **seuil atteint, inférence nulle** — un tombstone vit dans le sweeper et ne change pas la sémantique d'insertion |
| **K6** | la doc contredit §4 | doc fetchée le 2026-08-17 : « Redact scrubs content out of a historical version while **preserving the audit trail (who did what, when)** » ; « A version that is the current head of a live memory cannot be redacted » — la contrainte est satisfaite automatiquement chez nous | **NE SE DÉCLENCHE PAS** — c'était **ma** lecture qui inversait `version` et `head` |
| **K7** | 0 demande d'une mémoire partagée | **0 sur 81 issues** | **SE DÉCLENCHE** |
| **K8** | montage exigeant un workspace CMA | établi en §0 | **SE DÉCLENCHE pour E05** — mais ne se généralise pas à `E10` (memory tool GA, sans header beta) |

**Bilan honnête : sur huit critères, trois se déclenchent (K4, K7, K8), trois ne se déclenchent pas (K1, K2, K6), un est inmesurable (K3), un atteint son seuil sans porter d'inférence (K5).** Les deux critères que je croyais décisifs contre l'emprunt — K2 et K6 — sont tombés à la passe adversariale. Ce qui tue l'adoption n'est donc **pas** l'impossibilité du patron, c'est sa **cible** et son **coût**.

### 6.5 Contre-arguments

- **On n'adopte pas l'API, seulement l'idée.** Les memory stores sont une surface Managed Agents : ils vivent chez Anthropic, scopés à un workspace, et n'ont aucun chemin d'intégration dans un coordinateur MCP auto-hébergé qui stocke tout en SQLite local. Le bénéfice (a) est purement un patron de conception — le tirer d'une doc Anthropic ne le rend pas plus solide qu'une lecture des littératures append-only log existantes.
- **Dépendance à une beta pour l'angle (b).** Header dédié, incompatible avec `managed-agents-2026-04-01` sur le même appel, surface encore mouvante (POST là où on attendrait PATCH, pas de `restore`, pas de webhook sur les mémoires). Bâtir la mémoire de repo dessus, c'est accepter des breaking changes et une dépendance réseau à un service tiers dans un produit qui fonctionne aujourd'hui hors ligne.
- **Casse la portabilité.** mcp-coordinator sert des agents via MCP, pas seulement des sessions Managed Agents. Une mémoire partagée qui n'existe que pour les clients Anthropic crée deux classes d'agents.
- **Le caviardage ne résout pas le trou qu'on croit.** L'en-tête de `audit-chain.ts` note que l'intégrité des horodatages n'est pas couverte non plus, et qu'un attaquant avec accès write à la DB peut réécrire `created_at`. Caviarder au lieu de supprimer ferme un trou sur deux ; sans attestation externe du tip, la valeur SOC 2 reste partielle. Il faut décider si on veut le demi-pas ou le pas complet.
- **Coût de stockage.** Ne plus jamais supprimer une ligne d'audit fait croître `audit_log` sans borne sur un déploiement bavard. Le sweeper existe précisément pour ça.
- **YAGNI sur (b).** Personne n'a demandé de mémoire de repo. `log_action_summary` + `context-provider` couvrent le besoin actuel, et le mode d'échec (mémoire empoisonnée persistante entre agents) est plus grave que le manque qu'il comble.
- **Rétention 30 jours insuffisante pour l'usage d'audit.** Même chez Anthropic, l'export API est requis pour du long terme — la feature n'est donc pas, en l'état, un système d'archivage réglementaire.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | **Refusé — convertir le sweeper de rétention en caviardage.** Pas parce que le patron ne transpose pas (il transpose : mesure S2, le chaînage survit intact au tombstone, `canonicalRowFields` ne bouge pas), mais parce que c'est **la mauvaise cible**, pour trois raisons chiffrées. **(1) K4 se déclenche** : la part caviardable est de 20,5 %, `prev_hash`+`row_hash` pèsent 58,3 % et sont incompressibles — une ligne tombstonée coûte ~80 % d'une ligne pleine et `audit_log` ne décroît plus jamais, ce qui annule la raison d'être du sweeper. **(2) La valeur livrée est nulle** : le patron vend « conserver qui/quoi/quand » ; chez nous il n'y a pas de *qui* (`actor_user_id` NULL sur 100 % des lignes — `withAuditContext` a **zéro** site d'appel en production, #319) et le *quand* n'est pas dans le hash. **(3) Deux correctifs font le même travail pour un dixième du prix** — (b) tolérer un `prev_hash` non vérifiable après un trou d'id, ou (d) faire **déclarer sa purge par le sweeper** dans la chaîne (`retention.audit_purged`), qui ne touche aucun des 4 sites de calcul de chaîne. ⭑ **Retenu — le principe « caviarder en préservant le maillon » est la bonne forme, pour l'autre cible** : le runbook d'effacement GDPR. C'est le seul endroit où nous *devons* détruire du contenu tout en conservant l'imputabilité, et c'est exactement ce que `redact` décrit. **Renvoyé — l'angle (b)** (mémoire de repo partagée) est hors périmètre : `E10` pose déjà la même question, en mieux et sans dépendance beta. K7 (0 demande sur 81 issues) et K8 sont adjugés pour E05 seulement. ⭑ **Le livrable réel de ce challenge n'est aucun des deux angles** : ce sont deux défauts qui nous appartiennent, trouvés en confrontant `src/sweeper/` et `scripts/verify-audit-chain.ts` — un rapprochement que la §5 de cette fiche est la première chose à avoir imposé. **Correction de méthode :** deux des trois justifications que je m'apprêtais à écrire (« le patron ne transpose pas », « le caviardage détruit `canonicalRowFields` ») étaient **fausses**, et la passe adversariale les a démolies par la mesure. Mon verdict initial était `refuser` ; il ne survit pas. J'ai également étiqueté à tort `k1b` comme « déploiement sans OAuth » alors que ses deux événements sont écrits **dans** `bootPhase2` — le périmètre corrigé est en §6.4-B, et un déploiement Phase-1 mono-tier **échappe** au défaut jusqu'à son premier upgrade. |
| **Issue / PR** | **#348** (le sweeper à deux TTL casse `prev_hash` ; + le commentaire de test faux, la promesse fausse de l'attestation de tip, et l'outil non livré) · **#349** (le runbook GDPR casse `row_hash` — armé, s'active le jour où #319 est corrigée) |
| **Jalon visé** | #348 avant la prochaine mineure — c'est un contrôle de sécurité qui produit du bruit d'astreinte. #349 **doit précéder** toute correction de #319. Le caviardage GDPR : seulement dans le cadre de #349, jamais dans le sweeper. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : surface d'API confirmée, params de list complétés, marqueur `since` tranché, §5 validé. |
| 2026-08-17 | **Challenge — verdict `adopter partiellement`, et deux défauts trouvés chez nous.** La prémisse de §6.1 est fausse : le sweeper ne *troue* pas la chaîne, il la **casse**. Il exécute deux `DELETE` avec deux TTL sur la même table (Tier 1 365 j / Tier 2 90 j, discriminés par `action IN (...)`), donc il supprime des lignes **du milieu**. Mesuré sur le vrai chemin : exit 0 avant, **exit 1 après**, `{"id_gap_before":24,"wrong_prev_hash":24}` — 19 signalements sur 40 lignes, soit à peu près un par ligne survivante. Or `docs/ops/audit-integrity.md:139-141` demande de traiter tout exit 1 comme un **signal de sécurité Tier 1** et de réveiller l'astreinte, et `tests/unit/verify-audit-chain.test.ts:215-217` affirme que « the retention sweeper never deletes middle rows — **a middle gap is an attacker signature** ». → **#348**. Second défaut, plus net : notre propre **runbook GDPR** (`docs/gdpr.md:199`, `:313`) prescrit des `UPDATE` sur `actor_user_id` et `metadata_json`, deux colonnes **dans `canonicalRowFields`** → `{"wrong_row_hash":10}`, mesuré. Il est **armé, pas actif** : `withAuditContext` a zéro site d'appel en production (#319), donc le `WHERE` ne matche rien — **corriger #319 l'arme**. → **#349**. **La passe adversariale a démoli deux de mes trois justifications.** Le patron *transpose* : mesure S2, un tombstone qui **préserve** le `row_hash` laisse le chaînage intact (0 `wrong_prev_hash`, 0 trou) et ne touche pas `canonicalRowFields` — mon K2 avait le bon seuil et le mauvais antécédent. Et mon K6 inversait `version` et `head` : une ligne d'audit correspond à une `memory version`, le head est la **tip**, et le sweeper ne touche que des lignes supersédées — la contrainte d'Anthropic est satisfaite automatiquement. Verdict initial `refuser` → **`adopter partiellement`**. Ce qui tue l'adoption n'est pas la faisabilité mais la **cible** et le **coût** : K4 se déclenche (part caviardable 20,5 %, `prev_hash`+`row_hash` 58,3 % incompressibles), et la valeur est nulle sur la rétention puisqu'il n'y a **pas de *qui*** à préserver (#319). Deux correctifs dominent pour un dixième du prix — (b) tolérance après trou d'id, (d) le sweeper **déclare** sa purge. (c) préfixe strict est **impossible** : 5 actions ne sont dans aucun tier, dont `encryption.config.loaded` émise au boot. Angle (b) **renvoyé à `E10`**, qui pose la même question sans dépendance beta. Erreur de ma part corrigée : `k1b` était étiqueté « sans OAuth » alors que ses deux événements sont écrits **dans** `bootPhase2` — un Phase-1 mono-tier échappe au défaut jusqu'à son premier upgrade. Trouvé en chemin : `verify-audit-chain.ts` n'est publié **ni par npm ni par Docker** (`package.json` `files`, `Dockerfile`), ce qui borne la gravité de #348 ; et l'attestation de tip ne distingue **pas** purge et falsification pour une suppression du milieu, contrairement à `audit-integrity.md:87-134`. |
