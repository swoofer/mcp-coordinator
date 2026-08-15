# C01 — Hooks de type `mcp_tool` : rendre l'annonce obligatoire au lieu de l'espérer

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6.2 à 6.4 et 7 sont remplies **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `hook-mcp-tool-gate` |
| **Surface** | claude-code |
| **Statut** | GA |
| **Disponible depuis** | `inconnu` — présent dans la référence hooks à jour en août 2026 (à verrouiller sur un changelog) |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local suffit, aucun accès privilégié requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — les deux `(à vérifier)` sont tranchés par la doc officielle : (a) le texte
  retourné par l'outil MCP est traité **comme le stdout d'un hook `command`** — s'il parse
  en JSON valide il est interprété comme décision, sinon comme stdout brut ; aucun hook
  `prompt`/`command` en aval n'est nécessaire. (b) Les clés d'interpolation disponibles dans
  `input` d'un `mcp_tool` sont `${tool_input.*}`, `${session_id}` et `${tool_name}`.
- §2 — ajout du fait, absent de la fiche, que le système **fail-open** : timeout, serveur MCP
  non connecté, `isError: true` ou échec HTTP produisent une erreur non bloquante et l'action
  continue. Un `PreToolUse` en timeout ne bloque pas. Cela répond par avance à la 3ᵉ puce de
  §6.3 et désamorce partiellement le contre-argument « fail-closed » de §6.5.
- §2 — `timeout` par défaut : 600 s pour `command`/`http`/`mcp_tool` (le `5` de l'exemple est
  une valeur choisie, pas le défaut). `if` est documenté comme filtre en syntaxe de règle de
  permission (`"Bash(git *)"`, `"Edit(*.ts)"`), `once` est réservé au frontmatter de skill,
  `async`/`asyncRewake`/`shell` aux hooks `command` uniquement.
- §4 et §5 — `CLAUDE_MD_TEMPLATE` s'étend de la ligne 10 à la ligne 89 de `cli/init.ts`, pas
  `10-35` comme l'affirmait la fiche (deux occurrences corrigées).
- Tous les autres ancrages de §5 ont été rouverts et sont exacts : `files-tools.ts` l. 49-74 /
  l. 54 (`agent_id` requis) / l. 70 (fenêtre 30 min) / l. 72 (forme du retour) ;
  `consultation-tools.ts` l. 36-53 et l. 52 (« Absolute paths are not accepted in team-mode ») ;
  `handle-rest.ts` l. 67 (`/api/check-conflict`) ; `rest-handlers.ts` l. 138-157 avec le champ
  de corps nommé `file` l. 150 ; `init.ts` l. 220-251 / l. 253-292 / l. 259 (sentinel) /
  l. 306 (« Claude Code, Cursor, Cline ») ; `uninstall.ts` l. 84 et l. 140 ;
  `doctor.ts` (`phase2.public_url`, `phase2.sqlite`, `phase2.audit_queue` existent bien).
  Aucun fichier cité n'est manquant. `grep` confirme qu'**aucun** fichier de `cli/` ou `src/`
  ne mentionne `settings.json` : l'affirmation « aucune option n'écrit `.claude/settings.json`
  aujourd'hui » tient. `sdk/src/client.ts` ne contient aucune occurrence de `hook`.

**Marqueurs `(à vérifier)` restants :** un seul, sur la forme exacte du bloc
`.claude/settings.json` reconstitué en §2. La doc de référence documente chaque champ
individuellement mais ne donne pas d'exemple complet de bloc `mcp_tool` ; la forme reste donc
plausible mais non attestée telle quelle. Le champ « Disponible depuis » reste
`inconnu` — **(non vérifiable — la page de référence des hooks ne porte aucune version
d'introduction)**.

**Testabilité :** ✅ testable
Tout se teste ici : écrire à la main un `.claude/settings.json` avec le bloc de §2, pointer
`server: "coordinator"` sur le daemon local, faire un `Edit` et lire les logs serveur. Aucun
header beta, credential d'API ni allowlist d'org n'est requis — les hooks sont une mécanique
locale du client Claude Code, déjà installé. La seule question de §6.3 déjà tranchée sur pièce
plutôt qu'à l'exécution est le fail-open, désormais documenté.

## 1. Ce que c'est

Un hook Claude Code n'est plus forcément un script shell. Le champ `type` d'une entrée de hook
accepte `command`, `http`, `mcp_tool`, `prompt` et `agent`. Le type `mcp_tool` déclare
`server`, `tool`, `input` et `timeout` : Claude Code appelle lui-même l'outil MCP nommé, sur un
serveur déjà connecté, sans passer par un processus externe. Les champs de `input` supportent
l'interpolation depuis l'événement, par exemple `"file_path": "${tool_input.file_path}"`.

Combiné à l'événement `PreToolUse` avec un `matcher` sur `Edit|Write`, cela transforme un
serveur MCP en gardien d'écriture : la réponse du hook peut porter
`hookSpecificOutput.permissionDecision` à `allow` ou `deny`, avec un
`permissionDecisionReason` affiché à l'agent. Un `deny` bloque l'écriture avant qu'elle
n'atteigne le disque. Les champs annexes utiles sont `if` (garde conditionnelle, ex.
`"Bash(rm *)"`), `once`, `async`, `asyncRewake`, `statusMessage`, `shell`, plus le
`disableAllHooks` global. Le type `http` offre la même mécanique en postant vers une URL
(`url`, `headers`, `allowedEnvVars`), ce qui vise directement une route REST existante plutôt
qu'un outil MCP.

## 2. Surface d'API exacte

```
hooks[].type: "command" | "http" | "mcp_tool" | "prompt" | "agent"
hooks[].server, hooks[].tool, hooks[].input, hooks[].timeout      (type: "mcp_tool")
hooks[].url, hooks[].headers, hooks[].allowedEnvVars              (type: "http")
hooks[].if, hooks[].once, hooks[].async, hooks[].asyncRewake,
hooks[].statusMessage, hooks[].shell
disableAllHooks
événement: PreToolUse  ·  matcher: "Edit|Write"
interpolation: ${tool_input.file_path}
sortie: hookSpecificOutput.hookEventName = "PreToolUse"
        hookSpecificOutput.permissionDecision ("allow" | "deny")
        hookSpecificOutput.permissionDecisionReason
```

Précisions établies sur la doc officielle le 2026-08-14 :

- `server` et `tool` sont **requis** pour `mcp_tool` ; `input` et `timeout` sont optionnels.
  `timeout` vaut par défaut **600 s** (`command`/`http`/`mcp_tool`), 30 s pour `prompt`,
  60 s pour `agent`. Pour un serveur livré par un plugin, `server` prend la forme scopée
  `plugin:<plugin-name>:<server-name>`.
- Interpolation disponible dans `input` d'un `mcp_tool` : `${tool_input.*}`, `${session_id}`,
  `${tool_name}`. (`${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`
  ne valent que pour les `args`/env des hooks `command` ; `$VAR` dans les `headers` HTTP exige
  que la variable soit listée dans `allowedEnvVars`.)
- `if` est un filtre en **syntaxe de règle de permission**, sur les événements d'outil
  uniquement : `"Bash(git *)"`, `"Edit(*.ts)"`. `once` n'existe que dans le frontmatter de
  skill. `async`, `asyncRewake` et `shell` (`"bash" | "powershell"`) sont réservés aux hooks
  `command`.
- **Mapping résultat → décision :** le contenu texte de l'outil MCP est traité exactement
  comme le stdout d'un hook `command` — s'il parse en JSON valide il est interprété comme une
  décision, sinon il est traité comme du stdout brut. Aucun hook intermédiaire n'est requis.
- **Le système fail-open.** Timeout de hook → annulé, aucune décision rendue ; un `PreToolUse`
  en timeout **ne bloque pas** et l'appel repart dans le flux de permission normal. Serveur MCP
  non connecté, outil renvoyant `isError: true`, réponse HTTP non-2xx ou échec de connexion :
  erreur non bloquante, l'exécution continue. L'action ne s'arrête que sur un code de sortie 2
  ou un `permissionDecision: "deny"` explicite. (Exception documentée : les hooks de callback
  de l'Agent SDK, eux, bloquent en cas de timeout.)

Bloc `.claude/settings.json` visé (forme reconstituée à partir des noms de champs
ci-dessus — **la syntaxe exacte du bloc est `(à vérifier)` par un essai réel**) :

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "coordinator",
            "tool": "check_file_conflict",
            "input": { "file_path": "${tool_input.file_path}" },
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Les deux points laissés ouverts par le bundle (mapping résultat → décision, autres clés
d'interpolation) sont **tranchés ci-dessus** par la doc de référence des hooks, vérifiée le
2026-08-14.

Le bundle ne contient qu'une seule fiche brute : aucune contradiction entre chercheurs à
signaler, mais aussi aucune corroboration croisée.

## 3. Sources

- https://code.claude.com/docs/en/hooks.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

C'est le chaînon manquant de la promesse produit « les conflits sont détectés AVANT qu'une
ligne soit écrite ». Aujourd'hui la garantie repose entièrement sur de la prose : `cli/init.ts`
écrit un `CLAUDE_MD_TEMPLATE` (lignes 10-89) qui explique à l'agent qu'il doit appeler
`announce_work` avant toute modification de fichier source et faire du polling sur
`coordinator_status`. Rien ne l'y oblige. Un agent qui saute l'étape écrit quand même, et le
texte lui-même l'admet : « If you skip the polling step, you can still write code, but you may
miss a question ». Un hook `PreToolUse` déplace cette obligation du niveau « instruction » au
niveau « harnais » — non contournable par l'agent.

Concrètement, trois choses :

1. Une partie du `CLAUDE_MD_TEMPLATE` devient redondante : la section « Before any source-file
   change — call `announce_work` » n'a plus besoin d'être crue sur parole. Les tokens de contexte
   consommés à chaque session par cette prose peuvent baisser.
2. Un cas d'usage nouveau apparaît : le blocage dur. `src/tools/files-tools.ts:50`
   (`check_file_conflict`) est aujourd'hui `readOnlyHint: true` — un outil que l'agent consulte
   s'il y pense. Avec le hook, son résultat devient un veto d'écriture.
3. Zéro script shell à maintenir. Le mainteneur est sur Windows/PowerShell, ses utilisateurs
   sont sur bash ; un hook `type: "command"` aurait imposé un wrapper cross-platform. `mcp_tool`
   et `http` évitent complètement ce problème.

Un bénéfice secondaire pour l'auth : un hook `mcp_tool` réutilise la connexion MCP déjà
authentifiée du client. Les handlers MCP lisent les claims via
`getSessionClaims(extra.sessionId)` (`src/tools/files-tools.ts:27`), donc l'org est résolue
sans configuration supplémentaire. Un hook `type: "http"` vers `/api/check-conflict`
(`src/http/handle-rest.ts:67`) exigerait au contraire de placer un jeton dans `headers` ou
`allowedEnvVars` du `settings.json` — surface de fuite de secret dans un fichier versionné.

**Risque si on ne fait rien :**

Pas de menace directe : rien ne casse. Le risque est positionnel — un concurrent qui câble ce
hook offre une garantie que mcp-coordinator ne peut que promettre. La documentation du projet
(`docs/ARCHITECTURE.md`, la landing page) devra continuer à parler de coordination
« coopérative » là où le harnais permet désormais de la rendre contraignante.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/init.ts` | Aucune option n'écrit `.claude/settings.json` aujourd'hui : seuls `--write-mcp-config` (`.mcp.json`, l. 220-251) et `--write-claude-md` (l. 253-292) existent. Il faut une troisième cible `--write-hooks`, avec la même stratégie de fusion non destructive que `.mcp.json` (l. 227-242) et le même sentinel qu'en CLAUDE.md (l. 259). |
| `cli/init.ts` (l. 10-89) | `CLAUDE_MD_TEMPLATE` : la puce « Before any source-file change — call `announce_work` » devient partiellement redondante si le hook est actif. À réécrire, pas à supprimer (le hook ne couvre pas `register_agent` ni le polling). |
| `src/tools/files-tools.ts` (l. 49-74) | `check_file_conflict` est la cible naturelle du hook. Signature actuelle : `file_path`, `agent_id` (**requis**), `within_minutes`. Le hook n'a pas d'`agent_id` à interpoler — il faut soit le rendre optionnel avec repli sur les claims de session, soit ajouter un outil dédié au gating. |
| `src/tools/files-tools.ts` (l. 72) | Le retour est `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Si Claude Code attend un `hookSpecificOutput` structuré, ce format ne convient pas tel quel. |
| `src/tools/consultation-tools.ts` (l. 36-53) | `announce_work` exige `agent_id`, `subject`, `target_modules`, `target_files`. Un hook ne peut pas fabriquer un `subject` ni des `target_modules` : gate ≠ annonce. Le hook peut au mieux **refuser** l'écriture en demandant à l'agent d'annoncer d'abord. |
| `src/path-normalize.ts` (`normalizePath`) | `${tool_input.file_path}` d'un `Edit`/`Write` est un chemin **absolu** ; les outils attendent du repo-relatif forward-slash (« Absolute paths are not accepted in team-mode », consultation-tools.ts l. 52). `normalizePath(repoRoot, input)` fait déjà la conversion et *throw* hors racine — c'est le point de passage obligé côté serveur. |
| `src/http/handle-rest.ts` (l. 67) + `src/http/rest-handlers.ts` (l. 138-157) | Alternative `type: "http"` : `POST /api/check-conflict` existe. Attention, le champ du corps est `file` (l. 150), **pas** `file_path` comme en MCP — divergence de nommage à trancher avant de documenter un bloc de hook. |
| `cli/doctor.ts` | Les checks sont nommés (`phase2.public_url`, `phase2.sqlite`, `phase2.audit_queue`…). Un check `hooks.pretooluse` qui lit `.claude/settings.json` et signale un hook absent, désactivé (`disableAllHooks`) ou pointant vers un `server` inexistant s'insère dans le même moule. |
| `cli/uninstall.ts` (l. 84, 140) | Gère déjà `--mcp-config` et `--claude-md`. Si `init` écrit des hooks, `uninstall` doit savoir les retirer, sinon on laisse un hook orphelin qui bloque toutes les écritures après désinstallation. |
| `cli/channel.ts` | Second serveur MCP stdio (Claude Code Channels). Un hook cible un `server` par son nom : décider lequel des deux serveurs est la cible canonique du gate. |
| `docs/ARCHITECTURE.md`, `docs/onboarding-self-host.md`, `docs/troubleshooting.md`, `docs/index.html` | Le discours « coopératif » et la procédure d'installation changent. Rappel : `docs/index.html` porte plusieurs langues inline. |
| `sdk/src/client.ts` | Non concerné a priori : le hook est une affaire de client Claude Code, pas du SDK. À confirmer si le SDK doit exposer un helper pour générer le bloc de hooks. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le hook `PreToolUse` doit-il appeler `check_file_conflict` en veto dur (`deny` sur conflit,
> ce qui casse l'écriture d'un agent solo mal enregistré et exige de résoudre l'absence
> d'`agent_id` interpolable), ou rester un signal `allow` + `permissionDecisionReason` qui
> injecte le contexte de conflit dans le fil de l'agent sans jamais bloquer ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à amender pendant le challenge.>

- [ ] Écrire à la main un `.claude/settings.json` avec le bloc `PreToolUse` / `mcp_tool` visé en
      §2, contre le serveur `coordinator` local, et faire un `Edit` sur un fichier quelconque :
      vérifier que l'outil MCP est bien appelé (log serveur) et avec quel `file_path` exact
      (absolu ? forward-slash ? casse ?).
- [ ] Déterminer empiriquement comment un outil MCP produit un `deny` : retourner successivement
      du texte brut, un JSON `{"permissionDecision":"deny"}`, puis un JSON
      `{"hookSpecificOutput":{...}}`, et observer laquelle des trois formes bloque l'écriture.
- [ ] Tester le chemin d'échec : coordinateur arrêté, puis `timeout` dépassé. L'écriture
      passe-t-elle (fail-open) ou est-elle bloquée (fail-closed) ? C'est déterminant pour le
      verdict — un fail-closed rend le projet capable de geler le poste d'un utilisateur.
- [ ] Vérifier le comportement sans `agent_id` : `check_file_conflict` le rend obligatoire
      (`z.string()`, files-tools.ts l. 54). Confirmer qu'un appel sans ce champ échoue, et
      décider entre repli sur les claims de session ou nouvel outil dédié.
- [ ] Comparer avec la variante `type: "http"` vers `POST /api/check-conflict` : mesurer ce que
      coûte l'auth (jeton en clair dans `settings.json` ?) et si `allowedEnvVars` suffit à
      l'éviter.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Verrouillage sur Claude Code.** Le projet se vend comme agnostique : `cli/init.ts` l. 306
  liste explicitement « Claude Code, Cursor, Cline, ... ». Un hook `PreToolUse` ne fonctionne que
  chez Claude Code. La garantie « détection avant écriture » deviendrait à deux vitesses selon le
  client, ce qui est plus difficile à documenter qu'une garantie faible mais uniforme.
- **Un gate n'est pas une annonce.** Le hook peut bloquer une écriture, mais il ne peut pas
  appeler `announce_work` à la place de l'agent : ce dernier exige `subject`, `target_modules` et
  `target_files` qu'aucune interpolation ne fournit. On gagne le veto, pas l'annonce — donc le
  `CLAUDE_MD_TEMPLATE` reste nécessaire et le gain en tokens de contexte est marginal.
- **Le mode fail-closed est un risque produit sérieux.** Un coordinateur arrêté, un timeout
  réseau ou un bug de normalisation de chemin (Windows, casse, monorepo hors `repoRoot` →
  `normalizePath` *throw*) peuvent transformer l'outil en blocage complet de toute écriture.
  Le coût du support d'un « Claude Code ne peut plus écrire de fichiers » dépasse largement le
  bénéfice pour un mainteneur solo.
- **Faux positifs.** `check_file_conflict` a une fenêtre par défaut de 30 minutes
  (files-tools.ts l. 70). Un agent qui reprend son propre travail après une pause, ou deux
  sessions du même humain, déclencheraient un `deny` sur un conflit qui n'en est pas un —
  d'autant plus que le `agent_id` d'exclusion est justement ce que le hook n'a pas.
- **Surface de configuration en plus.** `init` écrit déjà deux fichiers, `uninstall` en nettoie
  deux, `doctor` a une vingtaine de checks. Ajouter `.claude/settings.json` à ce triangle
  (écriture avec fusion, nettoyage, diagnostic) représente plus de code que le hook lui-même,
  et une nouvelle source de dérive entre ce que `init` a écrit et ce que l'utilisateur a modifié
  à la main.
- **Version de la feature non datée.** Le bundle donne `since: unknown`. Sans plancher de version
  Claude Code identifié, on ne peut ni le vérifier dans `doctor` ni l'annoncer proprement dans
  la doc. La confiance est « high » sur une seule source.
- **YAGNI.** Aucune demande utilisateur n'est citée dans le bundle. Le problème « l'agent
  n'annonce pas » est une hypothèse du mainteneur, pas un ticket. Mesurer d'abord la fréquence
  réelle des écritures non annoncées (`src/metrics.ts`, `src/observability/metrics.ts`) coûterait
  moins cher que de câbler le gate.

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
| 2026-08-14 | Vérification des faits : API confirmée, les deux `(à vérifier)` tranchés, fail-open documenté, template l.10-89. |
