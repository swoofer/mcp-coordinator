    const COORDINATOR_URL = 'http://localhost:3100';
    const FILTER_CATEGORIES = ['workflow', 'activity', 'impact', 'coordination', 'tokens'];
    const FILTER_LABELS = { workflow: 'Workflow', activity: 'Activity', impact: 'Impact', coordination: 'Coordination', tokens: 'Tokens' };
    const state = {
      agents: {},
      threads: {},
      events: [],
      metrics: { threads: 0, conflicts: 0, resolved: 0, totalTime: 0, totalTokens: 0, auto_resolved: 0, timeout: 0, consensus: 0 },
      seenIds: new Set(),
      threadStartTimes: {},
      verbose: false,
      // Alive-consultations state
      threadsCache: {},         // id → last fetched thread object
      threadActivity: {},       // id → { messageCount, lastMessageAt, lastMessageText, lastMessageType, lastAgentName, tokens }
      threadPrevStatus: {},     // id → last-known status (for flash detection)
      filters: new Set(loadFilters()),
      // Per-agent token accounting, aggregated from token_usage SSE events
      tokens: {},               // agentId → { name, totalCost, totalInput, totalOutput, cacheRead, cacheCreation, byPhase: {phase: {cost, input, output, cacheRead, cacheCreation, turns}}, byModel: {model: cost} }
    };

    function loadFilters() {
      try {
        const raw = localStorage.getItem('dashboard.threadFilters');
        if (raw) return JSON.parse(raw);
      } catch {}
      return FILTER_CATEGORIES;  // default: all on
    }
    function saveFilters() {
      localStorage.setItem('dashboard.threadFilters', JSON.stringify([...state.filters]));
    }

    // ── Thread helpers: time, detection, formatting ─────────────────────
    // Coordinator DB timestamps are "YYYY-MM-DD HH:MM:SS" in UTC but without
    // the Z suffix — append it so Date() parses as UTC.
    function parseDbTimestamp(s) {
      if (!s) return null;
      const withZ = s.includes('T') ? (s.endsWith('Z') ? s : s + 'Z') : (s.replace(' ', 'T') + 'Z');
      const d = new Date(withZ);
      return isNaN(d.getTime()) ? null : d;
    }

    function formatRelativeTime(ms) {
      const diff = Math.max(0, Date.now() - ms);
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ${s % 60}s`;
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }

    function formatCountdown(deadlineMs) {
      const diff = deadlineMs - Date.now();
      const sign = diff < 0 ? '-' : '';
      const absS = Math.floor(Math.abs(diff) / 1000);
      if (absS < 60) return `${sign}${absS}s`;
      const m = Math.floor(absS / 60);
      return `${sign}${m}m ${absS % 60}s`;
    }

    function countdownClass(deadlineMs) {
      const diff = deadlineMs - Date.now();
      if (diff < 0) return 'urgent';
      if (diff < 30_000) return 'urgent';
      if (diff < 60_000) return 'warning';
      return '';
    }

    function parseSeverity(subject) {
      const m = (subject || '').match(/^(critical|major|minor)[:\s]/i);
      return m ? m[1].toLowerCase() : null;
    }

    function displayName(agentId) {
      if (!agentId) return '';
      const a = state.agents[agentId];
      return a?.name || agentId;
    }

    function detectThreadType(t) {
      if (t.status === 'resolving') return 'resolving';
      const respondents = JSON.parse(t.expected_respondents || '[]');
      if (respondents.length > 0) return 'consultation';
      // Work-stealing: either claimed or severity-tagged subject (from raid discoveries)
      if (t.claimed_by || parseSeverity(t.subject)) return 'work_stealing';
      return 'discovery';  // keep_open discovery with no severity prefix
    }

    function getInitiatorProfile(t) {
      const a = state.agents[t.initiator_id];
      return a?.profile || null;
    }

    function formatTokens(n) {
      if (!n) return '0';
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return String(n);
    }

    function toggleVerbose() {
      state.verbose = !state.verbose;
      document.body.classList.toggle('verbose', state.verbose);
      document.getElementById('btn-verbose').classList.toggle('active', state.verbose);
    }

    function addVerboseEvent(text) {
      const events = document.getElementById('events');
      const div = document.createElement('div');
      div.className = 'timeline-event event-verbose';
      div.innerHTML = `<div class="timeline-time">${formatTime()}</div><div class="timeline-content"><span class="event-type">trace</span> ${text}</div>`;
      events.prepend(div);
    }

    function formatTime(ts) {
      return new Date(ts || Date.now()).toLocaleTimeString('fr-CA', { hour12: false });
    }

    function addEvent(type, payload, id) {
      // Deduplicate: skip if already displayed
      if (id && state.seenIds.has(id)) return;
      if (id) state.seenIds.add(id);

      const noEvents = document.getElementById('no-events');
      if (noEvents) noEvents.remove();

      const events = document.getElementById('events');
      const div = document.createElement('div');
      div.className = `timeline-event event-${type}`;

      let label = type.replace(/_/g, ' ');
      let detail = '';
      const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
      // _ts is injected by the server (event.created_at at emit time). When
      // the page is refreshed or SSE backfills past events, this gives us the
      // original timestamp instead of painting every event with "now".
      const eventTs = p._ts ? Date.parse(p._ts.replace(' ', 'T') + (p._ts.endsWith('Z') ? '' : 'Z')) : null;

      const agentName = p.agent_name || p.name || state.agents[p.agent_id]?.name || p.agent_id || '';
      let agent = agentName ? `<span style="color:#60a5fa;font-weight:600;">${agentName}</span> ` : '';

      if (type === 'thread_opened') {
        // New thread → refetch active panel immediately
        updateThreads();
        const modules = (p.target_modules || []).join(', ');
        const respondents = (p.expected_respondents || []);
        const conflictCount = (p.conflicts || []).length;
        const modeLabel = p.mode === 'with_plan'
          ? '<span style="background:#1a3a2e;color:#4ade80;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">AVEC PLAN</span>'
          : '<span style="background:#2a1a3a;color:#c084fc;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">DISCOVERY</span>';
        detail = `<strong>${p.subject || ''}</strong>${modeLabel}`;
        if (p.plan) detail += `<div style="font-size:10px;color:#94a3b8;margin-top:3px;font-style:italic;">Plan: ${p.plan}</div>`;
        detail += `<div style="font-size:10px;color:#8b8fa3;margin-top:3px;">Modules: ${modules}</div>`;
        if (respondents.length) detail += `<div style="font-size:10px;color:#8b8fa3;">En attente: ${respondents.join(', ')}</div>`;
        if (conflictCount) detail += `<div style="font-size:10px;color:#f87171;">⚠ ${conflictCount} conflit(s) détecté(s)</div>`;
        state.metrics.threads++; if (conflictCount) state.metrics.conflicts += conflictCount;
        if (p.thread_id) state.threadStartTimes[p.thread_id] = p.created_at ? new Date(p.created_at.replace(' ', 'T') + 'Z').getTime() : Date.now();

        // Verbose: quorum from server-side impact scoring
        if (respondents.length === 0) {
          addVerboseEvent(`Quorum: <span style="color:#fbbf24;">0 répondant</span> → résolution instantanée`);
        } else {
          addVerboseEvent(`Quorum: <span style="color:#fbbf24;">${respondents.length} répondant(s) attendu(s)</span> — ${respondents.join(', ')}`);
        }
        // Verbose: plan quality assessment
        if (p.plan_quality) {
          const q = p.plan_quality;
          const checks = [
            q.checks.mentions_files ? '✓ fichiers' : '✗ fichiers',
            q.checks.concrete_approach ? '✓ approche concrète' : '✗ approche vague',
            q.checks.sufficient_detail ? '✓ détaillé' : '✗ trop court',
          ].join(', ');
          addVerboseEvent(`Plan quality: ${q.score}/3 (${checks}) → mode ${q.mode}`);
        }
      }
      else if (type === 'message_posted') {
        const roundInfo = p.round ? ` <span style="color:#64748b;font-size:10px;">R${p.round}</span>` : '';
        const fullContent = p.content || '';
        if (fullContent.length > 200) {
          const short = fullContent.substring(0, 200) + '…';
          detail = `[${p.type}]${roundInfo} <span class="msg-short">${short}</span><span class="msg-full">${fullContent}</span>`;
        } else {
          detail = `[${p.type}]${roundInfo} ${fullContent}`;
        }
        if (p.token_estimate) state.metrics.totalTokens = (state.metrics.totalTokens || 0) + p.token_estimate;
        // Update thread activity cache for the live Consultations panel
        if (p.thread_id) {
          const a = state.threadActivity[p.thread_id] || { messageCount: 0, tokens: 0 };
          a.messageCount++;
          a.lastMessageAt = Date.now();
          a.lastMessageText = fullContent;
          a.lastMessageType = p.type;
          a.lastAgentName = p.agent_name || p.agent_id;
          a.tokens = (a.tokens || 0) + (p.token_estimate || 0);
          state.threadActivity[p.thread_id] = a;
          renderThreads();
        }
        addVerboseEvent(`<span style="color:#60a5fa;font-weight:600;">${agentName}</span> a posté dans le thread (type: ${p.type}, round: ${p.round || '?'})`);
      }
      else if (type === 'resolution_proposed') {
        detail = p.summary || '';
        // Instant visual update: status change → refetch threads
        if (p.thread_id) updateThreads();
        addVerboseEvent(`<span style="color:#60a5fa;font-weight:600;">${agentName}</span> propose la résolution — thread passe à "resolving", en attente d'approbation`);
      }
      else if (type === 'thread_resolved') {
        // Cleanup activity cache + refetch panel (thread leaves "active" list)
        if (p.thread_id) {
          delete state.threadActivity[p.thread_id];
          delete state.threadPrevStatus[p.thread_id];
          updateThreads();
        }
        const approver = p.approved_by_name || p.approved_by || '';
        const resType = p.resolution_type || 'unknown';
        detail = p.resolution || '';
        if (approver) detail += `<div style="font-size:10px;color:#4ade80;margin-top:2px;">Approuvé par: ${approver}</div>`;
        if (resType !== 'consensus') detail += `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">Type: ${resType}</div>`;
        agent = '';
        state.metrics.resolved++;

        // Track by resolution type
        if (resType === 'auto_resolved') state.metrics.auto_resolved++;
        else if (resType === 'timeout') state.metrics.timeout++;
        else if (resType === 'consensus') state.metrics.consensus++;

        // Calculate elapsed time only for threads with actual messages
        if (p.thread_id && p.had_messages) {
          let elapsed = 0;
          if (p.created_at && p.resolved_at) {
            elapsed = new Date(p.resolved_at.replace(' ', 'T') + 'Z').getTime() - new Date(p.created_at.replace(' ', 'T') + 'Z').getTime();
          } else if (state.threadStartTimes[p.thread_id]) {
            elapsed = Date.now() - state.threadStartTimes[p.thread_id];
          }
          if (elapsed > 0) {
            state.metrics.totalTime += elapsed;
            addVerboseEvent(`Consensus atteint en ${(elapsed/1000).toFixed(1)}s — tous les répondants ont approuvé`);
          }
        }
        if (resType === 'auto_resolved') {
          addVerboseEvent(`Thread auto-résolu (aucun agent concerné)`);
        } else if (resType === 'timeout') {
          addVerboseEvent(`Thread résolu par timeout — pas de réponse dans le délai`);
        }
      }
      else if (type === 'agent_online') {
        const modules = (p.modules || []).join(', ');
        detail = modules ? `<span style="font-size:10px;color:#64748b;">${modules}</span>` : '';
        state.agents[p.agent_id] = { ...state.agents[p.agent_id], ...p, activity_status: 'idle' };
        addVerboseEvent(`<span style="color:#60a5fa;font-weight:600;">${agentName}</span> enregistré avec modules: [${modules}]`);
      }
      else if (type === 'agent_offline') {
        detail = '';
        if (state.agents[p.agent_id]) state.agents[p.agent_id].activity_status = 'offline';
        addVerboseEvent(`<span style="color:#60a5fa;font-weight:600;">${agentName}</span> déconnecté — retiré des quorums actifs`);
      }
      else if (type === 'agent_activity') {
        if (state.agents[p.agent_id]) {
          state.agents[p.agent_id].activity_status = p.activity_status;
          state.agents[p.agent_id].current_file = p.current_file;
          state.agents[p.agent_id].current_thread = p.current_thread;
        }
        const statusLabel = { working: '💻 au travail', idle: '⏸ en attente', waiting: '⏳ consultation', offline: '🔴 hors ligne' }[p.activity_status] || p.activity_status;
        detail = `${statusLabel}${p.current_file ? ' — ' + p.current_file : ''}`;
      }
      else if (type === 'file_edited') {
        const tool = p.tool_name ? `<span style="color:#64748b;font-size:10px;">[${p.tool_name}]</span> ` : '';
        detail = `${tool}${p.file || ''}`;
      }
      else if (type === 'action_summary') { detail = p.summary || ''; }
      else if (type === 'impact_scored') {
        const category = p.score >= 90 ? '<span style="color:#4ade80;">concerné</span>' : p.score >= 30 ? '<span style="color:#fbbf24;">zone grise</span>' : '<span style="color:#64748b;">passe</span>';
        detail = `score ${p.score} → ${category} (${p.reasons?.join(', ') || 'aucune raison'})`;
      }
      else if (type === 'introspection_requested') {
        detail = `score ${p.score} — introspection demandée (${p.reasons?.join(', ') || ''})`;
      }
      else if (type === 'introspection_completed') {
        const result = p.concerned ? '<span style="color:#4ade80;">CONCERN\u00c9</span>' : '<span style="color:#64748b;">PASSE</span>';
        detail = `introspection: "${p.reason}" \u2192 ${result}`;
      }
      else if (type === 'run_config') {
        renderRunConfig(p);
        return; // don't add to timeline
      }
      else if (type === 'token_usage') {
        trackTokenUsage(p);
        return; // telemetry, not a timeline event
      }
      else if (type === 'quota_update') {
        // Quota refresh event — hidden by default (verbose-only) since the
        // widget in the left panel is the primary surface. One-line digest
        // when Détails is on, so it's easy to trace refresh timing.
        const fh = p.five_hour ? `${(p.five_hour.utilization ?? 0).toFixed(1)}%` : '?';
        const sd = p.seven_day ? `${(p.seven_day.utilization ?? 0).toFixed(1)}%` : '?';
        const resetMin = p.five_hour?.minutesUntilReset ?? 0;
        const resetLabel = resetMin > 60
          ? `${Math.floor(resetMin / 60)}h${resetMin % 60 ? ' ' + (resetMin % 60) + 'min' : ''}`
          : `${resetMin}min`;
        detail = `5h ${fh} · 7j ${sd} · 5h-reset dans ${resetLabel}`;
        agent = '';
      }
      else if (type === 'thread_cancelled') {
        detail = p.reason ? `cancelled: ${p.reason}` : 'cancelled';
        if (p.thread_id) {
          delete state.threadActivity[p.thread_id];
          delete state.threadPrevStatus[p.thread_id];
          updateThreads();
        }
      }
      else { detail = JSON.stringify(p).substring(0, 100); agent = ''; }

      div.innerHTML = `<div class="timeline-time">${formatTime(eventTs)}</div><div class="timeline-content"><span class="event-type">${label}</span> ${agent}${detail}</div>`;
      events.prepend(div);
      updateMetrics();
      updateAgents();
    }

    function updateMetrics() {
      document.getElementById('m-threads').textContent = state.metrics.threads;
      document.getElementById('m-conflicts').textContent = state.metrics.conflicts;

      // Temps moyen = seulement les threads avec messages (vraies consultations)
      const consultationsWithTime = state.metrics.consensus + state.metrics.timeout;
      const avg = consultationsWithTime > 0 && state.metrics.totalTime > 0
        ? `${Math.round(state.metrics.totalTime / consultationsWithTime / 1000)}s`
        : '-';
      document.getElementById('m-time').textContent = avg;

      // Consensus = consensus / total threads non-auto
      const nonAuto = state.metrics.resolved - state.metrics.auto_resolved;
      document.getElementById('m-consensus').textContent = nonAuto > 0
        ? `${state.metrics.consensus}/${nonAuto}`
        : state.metrics.auto_resolved > 0 ? `${state.metrics.auto_resolved} auto` : '-';

      document.getElementById('m-tokens').textContent = state.metrics.totalTokens > 0
        ? (state.metrics.totalTokens > 1000 ? `${(state.metrics.totalTokens / 1000).toFixed(1)}k` : state.metrics.totalTokens)
        : '0';

      document.getElementById('m-auto').textContent = state.metrics.auto_resolved;
      document.getElementById('m-timeout').textContent = state.metrics.timeout;
    }

    // ── Filter toggles ─────────────────────────────────────────────────
    function renderFilterBar() {
      const el = document.getElementById('thread-filters');
      el.innerHTML = FILTER_CATEGORIES.map(cat =>
        `<span class="filter-chip ${state.filters.has(cat) ? 'active' : ''}" data-filter="${cat}">${FILTER_LABELS[cat]}</span>`
      ).join('');
    }
    function toggleFilter(cat) {
      if (state.filters.has(cat)) state.filters.delete(cat);
      else state.filters.add(cat);
      saveFilters();
      renderFilterBar();
      renderThreads();
    }
    // Event delegation: #thread-filters is static (rendered once, in place);
    // its children (.filter-chip) are re-rendered on every toggle, so binding
    // listeners per-chip would leak/detach. One listener on the parent reads
    // the clicked chip's data-filter instead — safe under script-src 'self'
    // (no onclick= in the generated HTML).
    document.getElementById('thread-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      const cat = chip.dataset.filter;
      if (cat) toggleFilter(cat);
    });

    // ── Thread card rendering ──────────────────────────────────────────
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function renderFixedZone(t, type, profile) {
      const created = parseDbTimestamp(t.created_at);
      const ageMs = created ? created.getTime() : Date.now();
      const profileBadge = profile
        ? `<span class="profile-badge ${profile}">${profile}</span>`
        : '';
      return `<div class="thread-zone-fixed">
        <div class="thread-head">
          <div class="thread-head-left">
            <div class="thread-subject">${escapeHtml(t.subject)}</div>
            <div class="thread-initiator">Par: ${escapeHtml(displayName(t.initiator_id))}${profileBadge}</div>
          </div>
          <div class="thread-head-right">
            <span class="status-pill ${t.status}">${t.status}</span>
            <div><span class="rel" data-ms="${ageMs}">${formatRelativeTime(ageMs)}</span></div>
          </div>
        </div>
      </div>`;
    }

    function renderContextualZone(t, type, profile) {
      const rows = [];
      const f = state.filters;
      const activity = state.threadActivity[t.id];

      // ── Workflow: claim status + timeout countdown ──
      if (f.has('workflow')) {
        if (type === 'work_stealing') {
          if (t.claimed_by) {
            const claimedAt = parseDbTimestamp(t.claimed_at);
            const ms = claimedAt ? claimedAt.getTime() : Date.now();
            rows.push(`🔧 Pris par <strong>${escapeHtml(displayName(t.claimed_by))}</strong> <span style="color:#64748b;">(il y a <span class="rel" data-ms="${ms}">${formatRelativeTime(ms)}</span>)</span>`);
          } else {
            rows.push(`🟢 Disponible — attend un agent`);
          }
        } else if (type === 'resolving') {
          rows.push(`🔵 En résolution`);
          if (t.resolution_summary) {
            const preview = t.resolution_summary.slice(0, 80) + (t.resolution_summary.length > 80 ? '…' : '');
            rows.push(`<span class="msg-preview">📝 ${escapeHtml(preview)}</span>`);
          }
        }
        if (t.timeout_seconds && t.created_at) {
          const created = parseDbTimestamp(t.created_at);
          if (created) {
            const deadline = created.getTime() + t.timeout_seconds * (t.round || 1) * 1000;
            rows.push(`⏱ Timeout <span class="countdown ${countdownClass(deadline)}" data-deadline="${deadline}">${formatCountdown(deadline)}</span>`);
          }
        }
      }

      // ── Coordination: rounds, respondents, approvals ──
      if (f.has('coordination')) {
        const respondents = JSON.parse(t.expected_respondents || '[]');
        if (type === 'consultation') {
          rows.push(`Round ${t.round}/${t.max_rounds}`);
          if (respondents.length) {
            const names = respondents.map(displayName).join(', ');
            rows.push(`⏳ En attente: ${escapeHtml(names)}`);
          } else {
            rows.push(`✅ Tous répondus`);
          }
        } else if (t.round > 1) {
          // Non-consultation but contested → show round
          rows.push(`<span style="color:#64748b;">Round ${t.round}/${t.max_rounds}</span>`);
        }
      }

      // ── Impact: severity + target files ──
      if (f.has('impact')) {
        const sev = parseSeverity(t.subject);
        const files = JSON.parse(t.target_files || '[]');
        const chips = [];
        if (sev) chips.push(`<span class="severity-pill ${sev}">${sev}</span>`);
        if (files.length) chips.push(`📁 ${escapeHtml(files.join(', '))}`);
        if (chips.length) rows.push(chips.join(' '));
      }

      // ── Activity: message count + last message preview ──
      if (f.has('activity') && activity && activity.messageCount > 0) {
        const preview = activity.lastMessageText
          ? `"${escapeHtml(activity.lastMessageText.slice(0, 50))}${activity.lastMessageText.length > 50 ? '…' : ''}"`
          : '';
        const ago = activity.lastMessageAt
          ? ` <span style="color:#64748b;">il y a <span class="rel" data-ms="${activity.lastMessageAt}">${formatRelativeTime(activity.lastMessageAt)}</span></span>`
          : '';
        rows.push(`💬 ${activity.messageCount} msg${preview ? ' · <span class="msg-preview">' + preview + '</span>' : ''}${ago}`);
      }

      // ── Tokens ──
      if (f.has('tokens') && activity && activity.tokens > 0) {
        rows.push(`🪙 ~${formatTokens(activity.tokens)} tokens`);
      }

      return rows.length
        ? `<div class="thread-zone-ctx">${rows.map(r => `<div>${r}</div>`).join('')}</div>`
        : '';
    }

    function renderThreadCard(t) {
      const type = detectThreadType(t);
      const profile = getInitiatorProfile(t);
      // Staleness: no activity for > 30s AND not resolving (resolving is expected to be quiet)
      const activity = state.threadActivity[t.id];
      const lastMs = activity?.lastMessageAt
        ?? (parseDbTimestamp(t.created_at)?.getTime() ?? Date.now());
      const stale = t.status !== 'resolving' && (Date.now() - lastMs) > 30_000;
      return `<div class="thread-card ${stale ? 'stale' : ''}" id="thread-${t.id}">
        ${renderFixedZone(t, type, profile)}
        ${renderContextualZone(t, type, profile)}
      </div>`;
    }

    function renderThreads() {
      const threads = Object.values(state.threadsCache);
      const el = document.getElementById('threads-list');
      if (!threads.length) {
        el.innerHTML = '<div style="color:#64748b;font-size:12px;">Aucune</div>';
        return;
      }
      // Sort: resolving first, then open, then by most recent activity
      threads.sort((a, b) => {
        const order = { resolving: 0, open: 1, resolved: 2, cancelled: 3 };
        const oa = order[a.status] ?? 9, ob = order[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        const aAct = state.threadActivity[a.id]?.lastMessageAt ?? 0;
        const bAct = state.threadActivity[b.id]?.lastMessageAt ?? 0;
        return bAct - aAct;
      });
      el.innerHTML = threads.map(renderThreadCard).join('');
    }

    function flashCard(threadId) {
      const el = document.getElementById(`thread-${threadId}`);
      if (!el) return;
      el.classList.remove('flash');
      // Force reflow so the animation restarts
      void el.offsetWidth;
      el.classList.add('flash');
    }

    function updateThreads() {
      fetch(`${COORDINATOR_URL}/api/threads-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then(r => r.json())
        .then(threads => {
          if (!Array.isArray(threads)) return;
          const activeIds = new Set(threads.map(t => t.id));
          // Drop threads that are no longer active
          for (const id of Object.keys(state.threadsCache)) {
            if (!activeIds.has(id)) delete state.threadsCache[id];
          }
          // Update cache + flash on status transition
          const flashQueue = [];
          for (const t of threads) {
            const prev = state.threadPrevStatus[t.id];
            state.threadsCache[t.id] = t;
            if (prev && prev !== t.status) flashQueue.push(t.id);
            state.threadPrevStatus[t.id] = t.status;
          }
          renderThreads();
          for (const id of flashQueue) flashCard(id);
        })
        .catch(() => {});
    }

    // ── Refresh relative times in place without re-rendering the DOM ───
    function tickRelativeTimes() {
      document.querySelectorAll('.rel').forEach(el => {
        const ms = Number(el.dataset.ms);
        if (!isNaN(ms)) el.textContent = formatRelativeTime(ms);
      });
      document.querySelectorAll('.countdown').forEach(el => {
        const ms = Number(el.dataset.deadline);
        if (isNaN(ms)) return;
        el.textContent = formatCountdown(ms);
        el.classList.remove('urgent', 'warning');
        const cls = countdownClass(ms);
        if (cls) el.classList.add(cls);
      });
      // Refresh staleness class without full re-render
      for (const [id, t] of Object.entries(state.threadsCache)) {
        const card = document.getElementById(`thread-${id}`);
        if (!card) continue;
        const activity = state.threadActivity[id];
        const lastMs = activity?.lastMessageAt
          ?? (parseDbTimestamp(t.created_at)?.getTime() ?? Date.now());
        const stale = t.status !== 'resolving' && (Date.now() - lastMs) > 30_000;
        card.classList.toggle('stale', stale);
      }
    }

    // ── Resizable right panel ──────────────────────────────────────────
    (function initRightPanelResizer() {
      const grid = document.querySelector('.grid');
      const handle = document.getElementById('resize-right');
      if (!grid || !handle) return;

      const MIN_WIDTH = 220;
      const MAX_WIDTH = 1000;
      const LEFT_WIDTH = 250;
      const HANDLE_WIDTH = 6;

      function applyRightWidth(px) {
        const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
        grid.style.gridTemplateColumns = `${LEFT_WIDTH}px 1fr ${HANDLE_WIDTH}px ${clamped}px`;
        return clamped;
      }

      // Restore persisted width on load
      const saved = parseInt(localStorage.getItem('dashboard.rightWidth') || '', 10);
      if (!isNaN(saved)) applyRightWidth(saved);

      let dragging = false;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        handle.classList.add('dragging');
        document.body.classList.add('resizing');
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // New width = distance from mouse to right edge of viewport
        const newWidth = window.innerWidth - e.clientX - HANDLE_WIDTH / 2;
        applyRightWidth(newWidth);
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        // Persist current width
        const m = grid.style.gridTemplateColumns.match(/(\d+)px$/);
        if (m) localStorage.setItem('dashboard.rightWidth', m[1]);
      });
      // Double-click to reset to default
      handle.addEventListener('dblclick', () => {
        applyRightWidth(300);
        localStorage.setItem('dashboard.rightWidth', '300');
      });
    })();

    // Poll threads every 2s; tick relative times every 1s
    renderFilterBar();
    updateThreads();
    setInterval(updateThreads, 2000);
    setInterval(tickRelativeTimes, 1000);

    function updateAgents() {
      const list = document.getElementById('agents-list');
      const statusLabels = { working: '💻 Au travail', idle: '⏸ En ligne', waiting: '⏳ En consultation', offline: '🔴 Hors ligne' };
      const statusDotClass = { working: 'working', idle: 'idle', waiting: 'waiting', offline: 'offline' };
      list.innerHTML = Object.values(state.agents).map(a => {
        const actStatus = a.activity_status || 'idle';
        const dotClass = statusDotClass[actStatus] || 'online';
        const label = statusLabels[actStatus] || 'En ligne';
        const fileInfo = a.current_file ? `<div class="agent-activity">📄 ${a.current_file}</div>` : '';
        const threadInfo = a.current_thread ? `<div class="agent-activity">🔗 Thread ${a.current_thread.slice(0, 8)}</div>` : '';
        return `<div class="agent-card">
          <span class="status-dot ${dotClass}"></span>
          <span class="agent-name">${a.name || a.agent_id}</span>
          <span style="font-size:10px;color:#94a3b8;margin-left:8px;">${label}</span>
          <div class="agent-modules">${(a.modules || []).join(', ')}</div>
          ${fileInfo}${threadInfo}
        </div>`;
      }).join('') || '<div style="color:#64748b;font-size:12px;">Aucun agent</div>';
    }

    // SSE Connection
    function connectSSE() {
      const es = new EventSource(`${COORDINATOR_URL}/api/events`);
      const dot = document.getElementById('conn-dot');
      const status = document.getElementById('conn-status');

      es.onopen = () => { dot.className = 'status-dot online'; status.innerHTML = '<span class="status-dot online" id="conn-dot"></span> Connecté'; };
      es.onerror = () => { dot.className = 'status-dot offline'; status.innerHTML = '<span class="status-dot offline" id="conn-dot"></span> Déconnecté'; };

      const eventTypes = ['agent_online','agent_offline','agent_activity','thread_opened','message_posted','resolution_proposed','thread_resolved','thread_cancelled','file_edited','action_summary','impact_scored','introspection_requested','introspection_completed','run_config','token_usage','quota_update'];
      for (const type of eventTypes) {
        es.addEventListener(type, (e) => addEvent(type, e.data, e.lastEventId));
      }
      // Quota is pushed via SSE on refresh; wire it to the widget directly.
      es.addEventListener('quota_update', (e) => {
        try { renderQuotaWidget(JSON.parse(e.data)); } catch { /* ignore malformed payload */ }
      });
    }

    function updateHotFiles() {
      fetch(`${COORDINATOR_URL}/api/hot-files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since_minutes: 60 })
      })
      .then(r => r.json())
      .then(files => {
        const el = document.getElementById('hot-files');
        el.innerHTML = files.map(f =>
          `<div class="hot-file">${f.file_path} <span style="float:right;color:#8b8fa3;font-size:11px;">${f.agent_count} agents</span></div>`
        ).join('') || '<div style="color:#64748b;font-size:12px;">Aucun</div>';
      })
      .catch(() => {});
    }

    // Poll hot files every 5s
    updateHotFiles();
    setInterval(updateHotFiles, 5000);

    // Quota widget — lazy first fetch, then SSE pushes refresh.
    function bucketClass(pct) {
      if (pct >= 90) return 'danger';
      if (pct >= 70) return 'warn';
      return '';
    }
    function formatReset(mins) {
      if (mins <= 0) return 'reset imminent';
      if (mins < 60) return `reset ${mins}min`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `reset ${h}h${m ? ' ' + m + 'min' : ''}`;
    }
    function renderQuotaWidget(data) {
      const el = document.getElementById('quota-widget');
      if (!el) return;
      if (!data || !data.five_hour || !data.seven_day) {
        el.innerHTML = '<div class="quota-unavailable">Quota indisponible</div>';
        return;
      }
      const buckets = [
        { label: '5h',  b: data.five_hour },
        { label: '7j',  b: data.seven_day },
      ];
      if (data.seven_day_sonnet) buckets.push({ label: '7j Sonnet', b: data.seven_day_sonnet });
      el.innerHTML = `<div class="quota-panel">${buckets.map(({label, b}) => {
        const pct = b.utilization || 0;
        const cls = bucketClass(pct);
        const mins = b.minutesUntilReset ?? 0;
        const barWidth = Math.min(100, Math.max(0, pct));
        return `<div class="quota-bucket ${cls}">
          <div class="quota-label">${label}</div>
          <div class="quota-value">${pct.toFixed(1)}%</div>
          <div class="quota-reset">${formatReset(mins)}</div>
          <div class="quota-bar"><div class="quota-bar-fill ${cls}" style="width:${barWidth}%"></div></div>
        </div>`;
      }).join('')}</div>`;
    }
    function render503(body) {
      const reason = body?.reason || 'raison inconnue';
      let extra = '';
      if (body?.cooldown_until) {
        const mins = Math.max(0, Math.ceil((body.cooldown_until - Date.now()) / 60000));
        extra = ` — cool-down ${mins}min avant retry`;
      }
      document.getElementById('quota-widget').innerHTML =
        `<div class="quota-unavailable">Quota indisponible : ${reason}${extra}</div>`;
    }
    function fetchQuotaOnce() {
      fetch(`${COORDINATOR_URL}/api/quota`)
        .then(async r => {
          if (r.status === 503) { render503(await r.json().catch(() => null)); return null; }
          return r.ok ? r.json() : null;
        })
        .then(data => { if (data) renderQuotaWidget(data); })
        .catch(() => { /* silent */ });
    }
    fetchQuotaOnce();

    // One-shot version fetch — the server exposes it via /health so we don't
    // need a dedicated endpoint. Silent on failure (just leaves the placeholder).
    fetch(`${COORDINATOR_URL}/health`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const el = document.getElementById('server-version');
        if (el && data?.version) el.textContent = `v${data.version}`;
        if (data?.version) document.title = `MCP Coordinator v${data.version} — Dashboard`;
      })
      .catch(() => { /* offline — header stays muted */ });

    // Force-refresh button → POST /api/quota/refresh. The server bypasses the
    // cache TTL and also broadcasts the new value via SSE, so we don't need
    // to re-render locally — the onmessage listener handles it. Disables the
    // button during the in-flight call so impatient clicks don't stack.
    function refreshQuota() {
      const btn = document.getElementById('quota-refresh-btn');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '⟳ …';
      btn.style.opacity = '0.6';

      fetch(`${COORDINATOR_URL}/api/quota/refresh`, { method: 'POST' })
        .then(async r => {
          if (r.status === 503) { render503(await r.json().catch(() => null)); return null; }
          return r.ok ? r.json() : null;
        })
        .then(data => { if (data) renderQuotaWidget(data); })
        .catch(() => { /* silent — button still re-enables */ })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = originalText;
          btn.style.opacity = '1';
        });
    }

    function clearTimeline() {
      // UI-only clear — does NOT touch the server. Safe to click while agents
      // are running. (Previously this also POSTed /api/reset which destroyed
      // the agents table and broke any in-flight announce via FK violation.)
      document.getElementById('events').innerHTML = '';
      state.metrics = { threads: 0, conflicts: 0, resolved: 0, totalTime: 0, totalTokens: 0, auto_resolved: 0, timeout: 0, consensus: 0 };
      state.agents = {};
      state.seenIds.clear();
      state.tokens = {};
      updateMetrics();
      updateAgents();
      renderTokenBudget();
    }

    function resetServer() {
      // Destructive: wipes the coordinator DB (agents, threads, events, …).
      // Running agents will fail their next announce with FK violation.
      const activeCount = Object.keys(state.agents || {}).length;
      const msg = activeCount > 0
        ? `⚠️ ${activeCount} agent(s) actif(s) détecté(s) côté UI.\n\nReset Server efface TOUT l'état du coordinator (agents, threads, events). Les agents en cours vont planter à leur prochain announce (SQLITE_CONSTRAINT_FOREIGNKEY).\n\nContinuer quand même ?`
        : 'Reset Server efface TOUT l\'état du coordinator (agents, threads, events). À utiliser uniquement entre deux runs.\n\nContinuer ?';
      if (!confirm(msg)) return;
      fetch(`${COORDINATOR_URL}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(r => {
          if (!r.ok) {
            r.json().then(j => alert(`Reset refusé par le serveur: ${j.error || r.status}`)).catch(() => alert(`Reset refusé: HTTP ${r.status}`));
            return;
          }
          clearTimeline();
        })
        .catch(err => alert(`Reset failed: ${err.message}`));
    }

    // ── Token usage tracking + rendering ──────────────────────────────
    function trackTokenUsage(p) {
      const agentId = p.agent_id;
      if (!agentId) return;
      const agent = state.tokens[agentId] ||= {
        name: p.agent_name || agentId,
        totalCost: 0, totalInput: 0, totalOutput: 0, cacheRead: 0, cacheCreation: 0, turns: 0,
        byPhase: {},
        byModel: {},
      };
      agent.name = p.agent_name || agent.name;
      agent.totalCost += Number(p.cost_usd) || 0;
      agent.totalInput += Number(p.input_tokens) || 0;
      agent.totalOutput += Number(p.output_tokens) || 0;
      agent.cacheRead += Number(p.cache_read_tokens) || 0;
      agent.cacheCreation += Number(p.cache_creation_tokens) || 0;
      agent.turns += 1;

      const phase = p.phase || 'unknown';
      const pb = agent.byPhase[phase] ||= { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 };
      pb.cost += Number(p.cost_usd) || 0;
      pb.input += Number(p.input_tokens) || 0;
      pb.output += Number(p.output_tokens) || 0;
      pb.cacheRead += Number(p.cache_read_tokens) || 0;
      pb.cacheCreation += Number(p.cache_creation_tokens) || 0;
      pb.turns += 1;

      const model = (p.model || 'unknown').toString();
      agent.byModel[model] = (agent.byModel[model] || 0) + (Number(p.cost_usd) || 0);

      renderTokenBudget();
    }

    function fmtTokens(n) {
      if (!n) return '0';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    }
    function fmtCost(n) {
      if (!n) return '$0.00';
      if (n < 0.01) return `$${n.toFixed(4)}`;
      return `$${n.toFixed(2)}`;
    }
    function cacheClass(pct) {
      if (pct >= 70) return 'cache-good';
      if (pct >= 40) return 'cache-meh';
      return 'cache-bad';
    }
    function modelShort(m) {
      if (!m) return '?';
      if (m.includes('haiku')) return 'haiku';
      if (m.includes('sonnet')) return 'sonnet';
      if (m.includes('opus')) return 'opus';
      return m.slice(0, 12);
    }

    function renderTokenBudget() {
      const agents = Object.entries(state.tokens);
      const totalEl = document.getElementById('token-total');
      const agentsEl = document.getElementById('token-agents');

      if (agents.length === 0) {
        totalEl.innerHTML = '<div style="color:#64748b;font-size:12px;">Pas encore de turns LLM</div>';
        agentsEl.innerHTML = '';
        return;
      }

      // Global totals
      const sum = agents.reduce((acc, [, a]) => {
        acc.cost += a.totalCost;
        acc.input += a.totalInput;
        acc.output += a.totalOutput;
        acc.cacheRead += a.cacheRead;
        acc.cacheCreation += a.cacheCreation;
        acc.turns += a.turns;
        return acc;
      }, { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 });
      const totalInputAll = sum.input + sum.cacheRead + sum.cacheCreation;
      const hitPct = totalInputAll > 0 ? Math.round((sum.cacheRead / totalInputAll) * 100) : 0;

      // Bar segments by input token source
      const barTotal = Math.max(1, sum.input + sum.output + sum.cacheRead + sum.cacheCreation);
      const pct = (n) => (n / barTotal) * 100;

      totalEl.innerHTML = `
        <div class="token-total">
          <div class="token-total-row big">
            <span>Total</span><span>${fmtCost(sum.cost)}</span>
          </div>
          <div class="token-total-row"><span>Turns</span><span>${sum.turns}</span></div>
          <div class="token-total-row"><span>Input (fresh)</span><span>${fmtTokens(sum.input)}</span></div>
          <div class="token-total-row"><span>Output</span><span>${fmtTokens(sum.output)}</span></div>
          <div class="token-total-row"><span>Cache read</span><span>${fmtTokens(sum.cacheRead)}</span></div>
          <div class="token-total-row"><span>Cache write</span><span>${fmtTokens(sum.cacheCreation)}</span></div>
          <div class="token-total-row"><span>Cache hit</span><span class="${cacheClass(hitPct)}">${hitPct}%</span></div>
          <div class="token-bar">
            <div class="token-bar-input" style="width:${pct(sum.input)}%" title="fresh input"></div>
            <div class="token-bar-cache-r" style="width:${pct(sum.cacheRead)}%" title="cache read"></div>
            <div class="token-bar-cache-w" style="width:${pct(sum.cacheCreation)}%" title="cache write"></div>
            <div class="token-bar-output" style="width:${pct(sum.output)}%" title="output"></div>
          </div>
        </div>
      `;

      // Sort agents by cost desc
      agents.sort(([, a], [, b]) => b.totalCost - a.totalCost);
      agentsEl.innerHTML = agents.map(([id, a]) => {
        const totalIn = a.totalInput + a.cacheRead + a.cacheCreation;
        const agentHit = totalIn > 0 ? Math.round((a.cacheRead / totalIn) * 100) : 0;
        const phases = Object.entries(a.byPhase).sort(([, x], [, y]) => y.cost - x.cost);
        const phaseChips = phases.map(([ph, p]) =>
          `<span class="token-phase-chip">${ph}<span class="cost">${fmtCost(p.cost)}</span></span>`
        ).join('');
        const models = Object.entries(a.byModel).sort(([, x], [, y]) => y - x);
        const modelChips = models.map(([m, c]) =>
          `<span class="token-phase-chip" style="background:#2a1a3a;">${modelShort(m)}<span class="cost">${fmtCost(c)}</span></span>`
        ).join('');
        return `
          <div class="token-agent">
            <div class="token-agent-name">${a.name} <span style="color:#94a3b8;font-weight:400;font-size:10px;">${fmtCost(a.totalCost)} · ${a.turns} turns</span></div>
            <div class="token-agent-row">
              <span>in ${fmtTokens(a.totalInput)} · out ${fmtTokens(a.totalOutput)}</span>
              <span class="${cacheClass(agentHit)}">cache ${agentHit}%</span>
            </div>
            <div style="margin-top:4px;">${phaseChips}</div>
            <div style="margin-top:2px;">${modelChips}</div>
          </div>
        `;
      }).join('');
    }

    // Initial render — empty state
    renderTokenBudget();

    function renderRunConfig(config) {
      const el = document.getElementById('run-config');
      if (!config || !config.name) {
        el.innerHTML = '<div style="color:#64748b;font-size:12px;">Aucun run actif</div>';
        return;
      }
      const profiles = (config.agents || []).reduce((acc, a) => {
        acc[a.profile] = (acc[a.profile] || 0) + 1;
        return acc;
      }, {});
      const profileStr = Object.entries(profiles).map(([k, v]) => `${v} ${k}`).join(', ');
      const staggerStr = config.stagger ? `${config.stagger.mode}${config.stagger.delay ? ` (${config.stagger.delay[0]}-${config.stagger.delay[1]}s)` : ''}` : '-';

      el.innerHTML = `<div class="config-section">
        <div class="config-title">${config.name}</div>
        <div style="font-size:10px;color:#94a3b8;margin-bottom:8px;">${config.description || ''}</div>
        <div class="config-row"><span class="config-key">Phase</span><span class="config-val">${config.phase || '-'}</span></div>
        <div class="config-row"><span class="config-key">Agents</span><span class="config-val">${(config.agents || []).length} (${profileStr})</span></div>
        <div class="config-row"><span class="config-key">Workspace</span><span class="config-val">${config.workspace?.type || '-'}</span></div>
        <div class="config-row"><span class="config-key">Stagger</span><span class="config-val">${staggerStr}</span></div>
        <div class="config-row"><span class="config-key">Timeout</span><span class="config-val">${config.timeout_minutes || 15} min</span></div>
        <div class="config-row"><span class="config-key">Compare</span><span class="config-val">${config.compare_mode ? 'Oui' : 'Non'}</span></div>
        <div class="config-agents">${(config.agents || []).map(a =>
          `<span class="config-agent-tag">${a.name} <span style="color:#64748b;">(${a.profile})</span></span>`
        ).join('')}</div>
      </div>`;
    }

    // Fetch config on load
    fetch(`${COORDINATOR_URL}/api/run-config`).then(r => r.json()).then(renderRunConfig).catch(() => {});

    async function refreshConflictSignals() {
      try {
        const r = await fetch(`${COORDINATOR_URL}/api/scoring-stats?since=24h`);
        const j = await r.json();
        for (const layer of j.layers) {
          const el = document.querySelector(`[data-layer="${layer.layer}"]`);
          if (el) el.textContent = layer.fire_count;
        }
      } catch {}
    }
    refreshConflictSignals();
    setInterval(refreshConflictSignals, 30000);

    // ── Static button wiring (was inline onclick=, blocked by script-src
    // 'self') ── This <script> tag is the last element in <body>, so the DOM
    // is already parsed here; no DOMContentLoaded wrapper needed. resetServer
    // keeps its exact gating (confirm() inside the function body, untouched)
    // — only the wiring moved.
    document.getElementById('quota-refresh-btn').addEventListener('click', refreshQuota);
    document.getElementById('btn-verbose').addEventListener('click', toggleVerbose);
    document.getElementById('btn-clear-timeline').addEventListener('click', clearTimeline);
    document.getElementById('btn-reset-server').addEventListener('click', resetServer);

    connectSSE();
    updateAgents();
