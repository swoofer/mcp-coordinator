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
| **Effort estimé** | ~~S~~ → **L** (recalibré au challenge du 2026-08-15, voir §7.4) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local suffit, aucun accès privilégié requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — adopter partiellement, voir §7 |

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

**Pré-enregistré le 2026-08-15, avant toute exécution.** Claude Code **2.1.219**, Node 22.21.0,
Windows 11.

**Apport des challenges déjà rendus** (à ne pas re-démontrer ici) :
[`C06`](C06-tool-search-defer-loading.md) a mesuré **0 annonce spontanée sur 12 runs** sans
`instructions` serveur, et 5/5 avec — le contre-argument YAGNI de §6.5 (« le problème est une
hypothèse du mainteneur, pas un ticket ») **est réfuté par la mesure**.
[`D03`](D03-threat-native-worktrees.md) a montré que **rien ne valide ce qui est déclaré** et que
le côté déclaré n'est jamais normalisé. Les deux poussent dans le même sens : la contrainte
manque, et elle ne peut pas venir du modèle.

**Hypothèse.** Le hook fonctionne mécaniquement, mais `check_file_conflict` est la **mauvaise
cible** : il exige un `agent_id` (`files-tools.ts:54`) que le hook ne peut pas interpoler — les
clés disponibles sont `${tool_input.*}`, `${session_id}`, `${tool_name}`. Et `${tool_input.file_path}`
d'un `Edit` est **absolu**, alors que le côté déclaré n'est pas normalisé (mesuré en `D03`). Je
m'attends donc à ce que le veto dur soit techniquement possible mais mal servi par l'outil existant,
et à ce que le fail-open documenté rende la branche « veto » moins dangereuse que §6.5 ne le craint.

**Critères de refus, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si Claude Code 2.1.219 **rejette** le bloc `type: "mcp_tool"` ou ne l'exécute jamais, la fiche s'effondre → `refuser`. | observation directe |
| K2 | Si le hook se déclenche mais que `check_file_conflict` échoue faute d'`agent_id`, la cible naturelle ne marche pas telle quelle → coût supplémentaire à chiffrer. | erreur observée |
| K3 | Si **aucune** forme de retour d'outil MCP ne produit un `deny`, la branche « veto dur » de §6.1 est morte ; seule survit `allow` + `permissionDecisionReason`. | 3 formes testées |
| K4 | Si le système est **fail-closed** (daemon arrêté ⇒ écritures bloquées), le veto dur est disqualifié pour un mainteneur solo, quelle que soit son élégance. | daemon arrêté |
| K5 | Si le `file_path` interpolé arrive sous une forme qui ne matche pas ce que le serveur stocke (absolu, casse, antislash), le gate produit des faux négatifs silencieux. | comparaison de chaînes |
| K6 | Si câbler ça proprement (`init --write-hooks`, `uninstall`, `doctor`) touche plus de 3 fichiers, l'effort n'est plus S. | > 3 fichiers |

### 6.3 Protocole de vérification

Amendé le 2026-08-15 — le protocole de la veille est repris, réordonné pour que les critères les
plus lourds tombent en premier, et exécuté dans un clone jetable.

- [x] **T1 — Le hook s'exécute-t-il ?** `.claude/settings.json` écrit à la main avec le bloc de §2,
      `Edit` sur un fichier, lecture des logs serveur. Tranche K1, et capture le `file_path` exact
      (K5).
- [x] **T2 — `agent_id` manquant.** Observer ce que renvoie `check_file_conflict` appelé sans lui.
      Tranche K2.
- [x] **T3 — Quelle forme produit un `deny` ?** Faire retourner successivement à l'outil : du texte
      brut, `{"permissionDecision":"deny"}`, puis
      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`.
      Tranche K3.
- [x] **T4 — Le chemin d'échec.** Daemon arrêté, puis timeout court dépassé. Tranche K4 — c'est le
      critère qui décide du verdict.
- [ ] **T5 — Variante `type: "http"`.** Comparer le coût d'auth. Traité en lecture si le budget
      d'expérience est consommé par T1-T4.

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

Exécuté le 2026-08-15. Claude Code **2.1.219**, Node 22.21.0, Windows 11. PoC dans le scratchpad,
daemon dédié (base et `COORDINATOR_REPO_ROOT` neufs), arrêté en fin de session.

---

**(A) Incident de départ, hors sujet mais réel : le daemon ne démarrait plus.**

```
Error: Cannot find module '@babel/runtime/helpers/defineProperty'
Require stack: … broker-factory@3.1.15 … worker-timers … mqtt@5.15.2 …
```

`@babel/runtime` est déclaré par `broker-factory` mais était **absent du store pnpm** ; le mode
stdio échouait aussi. `pnpm install --frozen-lockfile` a restauré 5 paquets — *« Lockfile is up to
date, resolution step is skipped »* — sans modifier `package.json` ni `pnpm-lock.yaml`. À signaler
au mainteneur : l'arbre `node_modules` était dans un état cassé.

> ⛔ **(B) CI-DESSOUS EST UN FAUX NÉGATIF. Conservé pour mémoire, réfuté en (D).** Ma sonde était
> incapable de produire une preuve : `--include-hook-events` n'était pas passé, le stdout d'un
> `PreToolUse` en code 0 n'est pas rendu dans le flux par conception (seuls `UserPromptSubmit`,
> `UserPromptExpansion` et `SessionStart` le sont), et la clé que je grepais — `"hook_event"` —
> n'existe dans aucun schéma. Les 7 runs ont fait varier 4 dimensions sans rapport pendant que la
> seule variable qui pilote l'observable restait constante.

**(B) ~~Le blocage central : aucun hook d'outil n'a jamais tiré en headless.~~**

Sept configurations, chacune avec un `Edit`/`Write` **réellement effectué** (fichier vérifié) :

| # | source des hooks | cwd | mode permission | SessionStart | PreToolUse |
|---|---|---|---|---|---|
| 1 | `--settings` | non approuvé | `--dangerously-skip-permissions` | (global) ✓ | ✗ |
| 2 | `.claude/settings.json` du projet | non approuvé | `--dangerously-skip-permissions` | (global) ✓ | ✗ |
| 3 | `--settings` | non approuvé | `acceptEdits` | (global) ✓ | ✗ |
| 4 | `--settings` | **approuvé** | `acceptEdits` | (global) ✓ | ✗ |
| 5 | `--settings`, SessionStart **et** PreToolUse dans le même fichier | approuvé | `acceptEdits` | **✓ le mien tire** | ✗ |
| 6 | `--settings`, matchers `"*"` / `"Write"` / aucun, + un `PostToolUse` | approuvé | `acceptEdits` | — | ✗ (et PostToolUse ✗) |
| 7 | `--settings` (idem 6) | approuvé | défaut + `--allowedTools "Write"` | — | ✗ |

Le run **5** est le discriminateur : `MY_SESSIONSTART_FIRED` apparaît, donc **les hooks de
`--settings` se chargent bien** ; c'est `PreToolUse`/`PostToolUse` qui ne se déclenchent pas.
La piste « répertoire non approuvé » est écartée par le run 4 (`hasTrustDialogAccepted: true`,
vérifié dans `~/.claude.json`).

**Je n'ai donc jamais atteint `type: "mcp_tool"`** : K1 reste sans réponse. La doc officielle des
hooks, fetchée aujourd'hui, est **muette** sur le mode headless, sur l'effet des modes de permission
sur `PreToolUse`, et sur la légitimité des hooks fournis via `--settings`.

> ~~**Correction à §0.** Le champ *Testabilité* serait faux depuis une session headless.~~
> **Retiré** : cette « correction » découlait du faux négatif. La §0 avait raison — la fiche **est**
> entièrement testable ici, y compris en headless (voir D, E, F). Seule nuance à ajouter à §0 :
> il faut passer `--include-hook-events`, sans quoi rien d'un hook d'outil n'est observable.

**(C) Ce qui se tranche par lecture, et qui ne dépend pas du hook.** Trois faits indépendants,
`src/tools/files-tools.ts:49-74` :

```ts
server.tool("check_file_conflict", "Check if another agent is editing a file", {
  file_path: z.string().describe("Repo-relative file path."),
  agent_id:  z.string().describe("ID of the agent checking for conflicts (excluded from the match)."),
  within_minutes: z.number().optional(),
}, { readOnlyHint: true, … },
async ({ file_path, agent_id, within_minutes }, extra) => { …
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
```

1. **`agent_id` est requis** (`z.string()`, sans `.optional()`), et les seules clés interpolables
   dans l'`input` d'un `mcp_tool` sont `${tool_input.*}`, `${session_id}`, `${tool_name}` — **aucune
   ne fournit un `agent_id`**. Le hook ne peut donc pas appeler l'outil avec succès.
2. **La forme du chemin ne correspond pas** : `file_path` est documenté « Repo-relative », alors que
   `${tool_input.file_path}` d'un `Edit` est **absolu**. Et [`D03`](D03-threat-native-worktrees.md) a
   mesuré que le côté déclaré n'est jamais normalisé.
3. **Le retour ne peut pas exprimer une décision.** L'outil renvoie
   `{"conflict":true|false,"agents":[…]}`. D'après la doc, ce texte est traité comme le stdout d'un
   hook `command` : s'il parse en JSON, il est interprété comme une décision. Or ce JSON ne contient
   **ni `hookSpecificOutput`, ni `permissionDecision`** — même quand `conflict` vaut `true`.
   **`check_file_conflict` ne peut structurellement jamais produire un `deny`.**

Autrement dit : même si le hook tirait, la cible que la fiche désigne comme « naturelle » est
inutilisable telle quelle, pour trois raisons indépendantes. Un **outil dédié au gating** est
nécessaire dans les deux branches de §6.1.

---

**(D) Le vrai résultat, après correction de la sonde.** Test comportemental (immunisé : le hook
écrit un fichier témoin et sort en code 2 ; on lit l'effet, pas le flux), avec
`--include-hook-events` :

```
"hook_name":"PreToolUse:Write"   x2   (hook_started + hook_response)
TEMOIN : FIRED
CIBLE  : (absent)  -> ECRITURE BLOQUEE
```

**Les hooks `PreToolUse` fonctionnent parfaitement en `claude -p`.** Le blocage de (B) était
entièrement un artefact d'instrumentation.

**(E) K1 et K2 — le hook `mcp_tool` atteint bien le coordinateur.** Bloc de §2 posé tel quel,
serveur `coordinator` en HTTP :

```
[tool_use] Edit
[hook_started]  PreToolUse:Edit
[hook_response] PreToolUse:Edit -> "MCP error -32602: Input validation error:
                Invalid arguments for tool check_file_conflict:
                Invalid input: expected string, received undefined at agent_id"
[result] success        <- et le fichier a bien ete modifie
```

K1 **répondu** : `type: "mcp_tool"` est fonctionnel en 2.1.219, la forme du bloc de §2 est correcte
(le marqueur `(à vérifier)` de §0 est levé). K2 **répondu** : l'appel échoue exactement pour la
raison prédite en (C). Et **K4 est répondu du même coup — le système est bien fail-open** :
l'erreur de validation n'a pas bloqué l'`Edit`. Second cas observé plus tard, même conclusion :
serveur non démarré → `"MCP server 'coordinator' not connected"` → l'écriture passe.

**(F) K3 — un outil MCP *peut* opposer un veto.** PoC jetable : `agent_id` rendu optionnel dans
`dist/` et forme de retour pilotée par variable d'environnement (dist restauré à l'identique
ensuite). Forme `hookSpecificOutput` :

```
[tool_use] Edit
[hook_response] "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",
                  \"permissionDecision\":\"deny\",
                  \"permissionDecisionReason\":\"forme hookSpecificOutput\"}}"
=== K3 === BLOQUE
```

L'`Edit` est **refusé**. L'agent a ensuite tenté Read/Bash/Glob puis appelé `check_file_conflict`
de lui-même — mais l'écriture n'a pas eu lieu. **Le mécanisme complet est prouvé de bout en bout :
`PreToolUse` → `mcp_tool` → outil du coordinateur → `permissionDecision: "deny"` → écriture
bloquée.**

**(G) Le fait qui tue la cible, vérifié par grep ici.** `file_activity` — la table que
`check_file_conflict` interroge — **n'est jamais écrite par un outil MCP** :

```
INSERT INTO file_activity   -> src/file-tracker.ts:18  (unique)
appelants de fileTracker.log( -> rest-handlers.ts:172 (POST /api/log-file)
                                 rest-handlers.ts:850 (POST /api/file-activity)
```

Les deux sont **REST**. Le dépôt le documente lui-même (`src/http/rest-schemas.ts:49`) :
*« POST /api/log-file — no MCP equivalent (essaim/hook telemetry only) »*. Dans une installation
purement MCP — celle qu'un hook `server: "coordinator"` utiliserait — la table est **vide**, et
`check_file_conflict` renvoie `{"conflict":false,"agents":[]}` à perpétuité. **Le gate serait un
no-op garanti.**

Et le comparateur ne pardonne rien : `normalizePath` n'est appelé **que** depuis
`rest-handlers.ts:834,877,901`. Ni `check_file_conflict` (MCP), ni `/api/check-conflict`, ni
`/api/log-file` ne normalisent — alors que `${tool_input.file_path}` est absolu et que
`file-tracker` compare par égalité stricte. Trois formats, un `=`.

**(H) Incident d'environnement, récurrent.** Le problème `@babel/runtime` de (A) est **revenu** une
seconde fois en cours de session, après avoir été réparé. Quelque chose élague `node_modules` entre
les exécutions. `pnpm install --frozen-lockfile` répare à chaque fois sans toucher au lockfile.
À investiguer hors challenge.

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | Le **mécanisme** est prouvé de bout en bout (§6.4 D-F). La **cible** de la fiche est réfutée pour quatre raisons indépendantes (§6.4 C, G). L'effort annoncé est faux. |
| **Issue / PR** | à créer — périmètre en §7.2 |
| **Effort réel** | **L**, pas S — voir §7.4. K6 est franchi d'un facteur ~5. |
| **Jalon visé** | après résolution du préalable d'identité (§7.3), partagé avec [`F02`](F02-canusetool-distributed-lock.md) |

### 7.1 Ce qui est retenu — le mécanisme, prouvé

Le hook `PreToolUse` de type `mcp_tool` **fonctionne**, mesuré ici : il atteint le coordinateur, et
un retour de la forme

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
                       "permissionDecision":"deny",
                       "permissionDecisionReason":"…"}}
```

**bloque l'écriture avant qu'elle atteigne le disque**. C'est le seul des trois chemins vers la
contrainte du Mouvement 1 de la synthèse dont l'exécution soit démontrée à ce jour. Le marqueur
`(à vérifier)` de §0 sur la forme du bloc `.claude/settings.json` est **levé** : la forme de §2 est
correcte telle quelle.

C'est d'autant plus à retenir que le besoin est **mesuré**, pas supposé :
[`C06`](C06-tool-search-defer-loading.md) a établi 0 annonce spontanée sur 12 runs sans
`instructions`, et — même avec — **0/3 sur une tâche à écriture immédiate**. Le contre-argument
YAGNI de §6.5 (« aucune demande utilisateur, c'est une hypothèse du mainteneur ») **est réfuté par
la mesure**, et l'argument « `instructions` rend le hook redondant » ne tient pas : `C06` conclut
explicitement que c'est un plancher, pas une garantie.

### 7.2 Ce qui est écarté — la cible

**`check_file_conflict` ne peut pas être la cible du hook.** Quatre raisons indépendantes, chacune
suffisante, toutes établies par lecture ou mesure :

1. **`agent_id` est requis** et non interpolable (mesuré : `expected string, received undefined at
   agent_id`). Le repli proposé en §5 — « repli sur les claims de session » — **n'est pas
   implémentable en l'état** : `AuthClaims` ne porte aucun `agent_id`, et rien dans le dépôt ne lie
   une session MCP à un agent enregistré.
2. **La table interrogée est vide en MCP.** `file_activity` n'est écrite que par
   `POST /api/log-file` et `POST /api/file-activity` — deux routes **REST**. Le dépôt le documente :
   « no MCP equivalent (essaim/hook telemetry only) ». Le gate serait un **no-op garanti**.
3. **Le comparateur ne matche pas.** `${tool_input.file_path}` est absolu ; `normalizePath` n'est
   appelé ni par `check_file_conflict`, ni par `/api/check-conflict`, ni par `/api/log-file` ; et
   `file-tracker` compare par égalité stricte. Prolongement direct de
   [`D03`](D03-threat-native-worktrees.md).
4. **Le retour ne peut pas exprimer une décision.** `{"conflict":…,"agents":[…]}` parse en JSON
   valide mais ne porte ni `hookSpecificOutput` ni `permissionDecision` — même quand `conflict` vaut
   `true`.

**Écarté aussi : le veto dur comme posture par défaut.** Le fail-open est confirmé par l'expérience
(erreur de validation → écriture passe ; serveur arrêté → écriture passe). C'est une bonne nouvelle
pour le risque produit — on ne peut pas geler le poste d'un utilisateur — mais c'est une mauvaise
nouvelle pour §4, qui vend le hook comme une contrainte « **non contournable par l'agent** ».
Un gate qui s'évapore quand le daemon est arrêté est une garantie **molle**. Il faut le dire dans la
doc au lieu de promettre l'inverse.

### 7.3 Le préalable, qui n'appartient pas à cette fiche

**D'où vient l'`agent_id` ?** C'est la question que `C01` n'a jamais posée et sans laquelle aucune
des deux branches de §6.1 n'est constructible. Elle est **partagée avec
[`F02`](F02-canusetool-distributed-lock.md)** (`canUseTool`), qui bute sur la même identité, et elle
touche le modèle de données (`src/register-workflow.ts`, `src/agent-registry.ts`, `AuthClaims`).
**Elle doit être tranchée avant d'écrire une ligne de gate**, et probablement dans le cadre de
`F02` ou d'une fiche dédiée.

Le successeur, une fois l'identité résolue : un outil **dédié** (`gate_file_write`) qui renvoie un
`hookSpecificOutput` conforme, adossé à **`working_files`** — qui a un propriétaire et un TTL —
plutôt qu'à `file_activity`, et qui normalise **des deux côtés** du comparateur.

### 7.4 L'effort : L, pas S

Ma propre estimation initiale (« S, 3 fichiers ») déclenchait mon critère K6. Comptage réel :
`cli/init.ts` (`--write-hooks`, avec une **stratégie de fusion neuve** — `hooks.PreToolUse[]` est un
tableau, sans clé d'objet comme `.mcp.json` ni sentinel comme CLAUDE.md), `cli/uninstall.ts`,
`cli/doctor.ts`, `src/tools/files-tools.ts` (outil dédié), plus le modèle d'identité de §7.3 ;
4 fichiers de tests ; et la doc, dont `docs/index.html` où la chaîne d'installation est répétée
**7 fois**. Ordre de grandeur : **~15 fichiers**. La fiche annonçait S ; c'est **L**.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API confirmée, les deux `(à vérifier)` tranchés, fail-open documenté, template l.10-89. |
| 2026-08-15 | **Challenge tranché : adopter partiellement — le mécanisme, pas la cible.** Prouvé de bout en bout : `PreToolUse` + `type: "mcp_tool"` atteint le coordinateur, et un retour `hookSpecificOutput` avec `permissionDecision: "deny"` **bloque l'écriture**. Fail-open confirmé à l'exécution (erreur de validation et serveur arrêté : l'écriture passe) — donc la garantie est **molle**, contrairement à ce que promet §4. Cible réfutée pour 4 raisons indépendantes : `agent_id` requis et non interpolable (mesuré) sans repli implémentable ; `file_activity` **jamais écrite par un outil MCP** (deux appelants, tous deux REST) donc gate no-op ; aucune normalisation sur ce chemin face à un `file_path` absolu ; et le retour ne peut porter aucune décision. Préalable identifié et sorti du périmètre : **d'où vient l'`agent_id`**, question partagée avec `F02`. Effort recalibré **S → L** (~15 fichiers, dont une stratégie de fusion neuve pour `hooks.PreToolUse[]` et une chaîne répétée 7 fois dans `docs/index.html`). **Mon premier résultat expérimental était un faux négatif** : 7 configurations « aucun hook ne tire » étaient un artefact de sonde — `--include-hook-events` manquant, stdout d'un `PreToolUse` non rendu par conception, et une clé `"hook_event"` qui n'existe dans aucun schéma. Réfutateur 1 a trouvé l'erreur, réfutateur 2 a chiffré l'effort et établi le no-op de `file_activity`. Incident annexe, récurrent : `@babel/runtime` disparaît de `node_modules` (deux fois), `pnpm install --frozen-lockfile` répare sans toucher au lockfile. |
