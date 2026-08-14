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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : surface d'API confirmée, params de list complétés, marqueur `since` tranché, §5 validé. |
