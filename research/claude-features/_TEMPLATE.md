# <ID> — <Nom de la feature>

> **Gabarit de fiche.** Une fiche = une feature de la plateforme Claude/Anthropic.
> Les sections 1 à 5 sont remplies par la veille. Les sections 6 à 8 sont remplies
> **pendant le challenge** de la feature (une session dédiée par fiche).

| Champ | Valeur |
|---|---|
| **ID** | `<slug-kebab-case>` |
| **Surface** | claude-code · mcp-spec · agent-sdk · claude-api · managed-agents · ecosystem |
| **Statut** | GA · beta · research-preview · announced · experimental · deprecated |
| **Disponible depuis** | `<date ou version>` |
| **Tier** | T1-incontournable · T2-fort-levier · T3-à-surveiller · T4-écarté |
| **Nature** | opportunity · integration · replace-homemade-code · threat · low |
| **Effort estimé** | S · M · L · XL |
| **Confiance veille** | high · medium · low |
| **Vérification** | CONFIRMED · PLAUSIBLE |
| **Statut du challenge** | ⬜ à faire · 🟡 en cours · ✅ tranché · ❌ abandonné |

---

## 1. Ce que c'est

<3 à 5 phrases : ce que fait la feature, comment on s'en sert techniquement.>

## 2. Surface d'API exacte

```
<nom exact du paramètre / champ JSON / hook / méthode SDK / endpoint / header beta>
```

<Extrait de code ou de payload minimal, si pertinent.>

## 3. Sources

- <URL doc officielle>
- <URL annonce / changelog>

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
<Ce que le projet gagne concrètement. Être spécifique : quel code disparaît, quelle capacité apparaît,
quel utilisateur en profite.>

**Risque si on ne fait rien :**
<Pour les fiches `threat` surtout. Sinon "aucun".>

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/...` | <quoi> |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> <Question posée par la veille. Recopiée telle quelle, puis affinée pendant le challenge.>

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] <étape 1>
- [ ] <étape 2>

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

<Ce qui plaide contre l'adoption : coût de maintenance, dépendance à une beta, portabilité
hors Claude Code, complexité pour l'auto-hébergeur, YAGNI.>

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
