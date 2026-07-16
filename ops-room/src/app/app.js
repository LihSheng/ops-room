(function () {
  'use strict';

  const refreshBtn = document.getElementById('refresh-btn');
  const refreshingIndicator = document.getElementById('refreshing-indicator');
  const lastUpdatedEl = document.getElementById('last-updated');
  const summaryContent = document.getElementById('summary-content');
  const instancesContent = document.getElementById('instances-content');
  const tasksContent = document.getElementById('tasks-content');
  const attentionContent = document.getElementById('attention-content');
  const healthContent = document.getElementById('health-content');
  const fleetCount = document.getElementById('fleet-count');
  const attentionCount = document.getElementById('attention-count');
  const toast = document.getElementById('toast');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle = document.getElementById('modal-title');
  const modalSubtitle = document.getElementById('modal-subtitle');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');

  const ACTIVE_TASK_STATES = new Set(['QUEUED', 'PENDING', 'CLAIMED', 'RUNNING', 'IN_PROGRESS', 'FIX_QUEUED', 'FIXING']);
  const ATTENTION_TASK_STATES = new Set(['NEEDS_HUMAN', 'CHANGES_REQUESTED', 'ERROR', 'FAILED', 'BLOCKED', 'AMBIGUOUS']);
  const SUCCESS_STATES = new Set(['RUNNING', 'HEALTHY', 'PASSED', 'COMPLETED', 'DONE', 'FIX_PUSHED']);
  const AGENT_ROLES = {
    professor: 'Implementation lead',
    berlin: 'Code review specialist',
    tokyo: 'Research and validation',
    gemini: 'General operations assistant',
  };

  let refreshInterval = null;
  let toastTimer = null;
  let taskFilter = 'all';
  let state = { health: null, instances: [], tasks: [], docker: null };

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'className') node.className = attrs[key];
        else if (key === 'dataset') Object.keys(attrs.dataset).forEach(function (dataKey) { node.dataset[dataKey] = attrs.dataset[dataKey]; });
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function svgIcon(paths) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (pathData) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
    });
    return svg;
  }

  function clear(node) { node.textContent = ''; }

  function humanize(value) {
    return String(value || 'unknown').replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function normalizeState(value) { return String(value || 'UNKNOWN').trim().toUpperCase().replace(/[\s-]+/g, '_'); }

  function taskState(task) { return normalizeState(task && (task.status || task.state || task.task_state)); }

  function taskTimestamp(task) {
    return task && (task.updated_at || task.completed_at || task.started_at || task.received_at || task.created_at || task.claimed_at) || '';
  }

  function taskTitle(task) {
    return task && (task.issue_title || task.title || task.task_text || task.task || task.id || task.task_id) || 'Untitled task';
  }

  function taskAgent(task) { return task && (task.agent || task.assignee || task.worker) || 'Unassigned'; }

  function taskRepository(task) { return task && (task.repository || task.repo) || 'Local operation'; }

  function isActiveTask(task) { return ACTIVE_TASK_STATES.has(taskState(task)); }

  function isAttentionTask(task) { return ATTENTION_TASK_STATES.has(taskState(task)); }

  function statusTone(value) {
    var normalized = normalizeState(value);
    if (SUCCESS_STATES.has(normalized)) return 'success';
    if (ATTENTION_TASK_STATES.has(normalized) || normalized === 'UNHEALTHY' || normalized === 'OOM_KILLED') return 'danger';
    if (normalized === 'WARNING' || normalized === 'DEGRADED' || normalized === 'RESTARTING' || normalized === 'MISSING') return 'warning';
    return 'neutral';
  }

  function statusPill(value, label) {
    return el('span', { className: 'status-pill status-pill--' + statusTone(value) }, label || humanize(value));
  }

  function formatDateTime(value) {
    if (!value) return 'Unknown';
    var date = new Date(value);
    if (String(date) === 'Invalid Date') return String(value);
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function formatRelativeTime(value) {
    if (!value) return 'No timestamp';
    var date = new Date(value);
    if (String(date) === 'Invalid Date') return String(value);
    var seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (Math.abs(seconds) < 60) return 'Just now';
    var minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return Math.abs(minutes) + 'm ' + (minutes >= 0 ? 'ago' : 'from now');
    var hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return Math.abs(hours) + 'h ' + (hours >= 0 ? 'ago' : 'from now');
    var days = Math.round(hours / 24);
    return Math.abs(days) + 'd ' + (days >= 0 ? 'ago' : 'from now');
  }

  function formatDuration(seconds) {
    var total = Number(seconds || 0);
    if (!Number.isFinite(total) || total < 0) return 'Unknown';
    var days = Math.floor(total / 86400);
    var hours = Math.floor((total % 86400) / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + minutes + 'm';
    return Math.max(1, minutes) + 'm';
  }

  function truncate(value, length) {
    var text = String(value || '');
    return text.length > length ? text.slice(0, length - 1) + '…' : text;
  }

  function fetchJson(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('Request failed: ' + response.status);
      return response.json();
    });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.add('hidden'); }, 2600);
  }

  function setLoading(target, message) {
    clear(target);
    target.appendChild(el('div', { className: 'loading-state' }, message));
  }

  function setError(target, message) {
    clear(target);
    target.appendChild(el('div', { className: 'error-state' }, message));
  }

  function sortedTasks(tasks) {
    return (tasks || []).slice().sort(function (a, b) { return String(taskTimestamp(b)).localeCompare(String(taskTimestamp(a))); });
  }

  function getCurrentTask(agent) {
    return sortedTasks(state.tasks).find(function (task) {
      return String(taskAgent(task)).toLowerCase() === String(agent || '').toLowerCase() && isActiveTask(task);
    }) || null;
  }

  function summaryCard(label, value, trend, iconPaths) {
    var card = el('article', { className: 'summary-card' });
    var header = el('div', { className: 'summary-card-header' });
    var icon = el('span', { className: 'summary-icon' });
    icon.appendChild(svgIcon(iconPaths));
    header.appendChild(icon);
    header.appendChild(el('span', { className: 'summary-trend' }, trend));
    card.appendChild(header);
    card.appendChild(el('div', { className: 'summary-value' }, String(value)));
    card.appendChild(el('div', { className: 'summary-label' }, label));
    return card;
  }

  function renderSummary() {
    clear(summaryContent);
    var running = state.instances.filter(function (instance) { return normalizeState(instance.runtime && instance.runtime.status) === 'RUNNING'; }).length;
    var active = state.tasks.filter(isActiveTask).length;
    var attention = state.tasks.filter(isAttentionTask).length;
    var uptime = state.health ? formatDuration(state.health.uptime_seconds || state.health.uptime) : 'Unknown';

    summaryContent.appendChild(summaryCard('Agents online', running + ' / ' + state.instances.length, running === state.instances.length && running > 0 ? 'Fleet healthy' : 'Check fleet', ['M5 19a7 7 0 0 1 14 0', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8']));
    summaryContent.appendChild(summaryCard('Tasks in progress', active, active ? 'Live workload' : 'Queue clear', ['M5 5h14v14H5z', 'M8 9h8M8 13h5']));
    summaryContent.appendChild(summaryCard('Needs attention', attention, attention ? 'Human review' : 'No blockers', ['M12 3 2 20h20L12 3Z', 'M12 9v4M12 17h.01']));
    summaryContent.appendChild(summaryCard('Harness uptime', uptime, state.health && state.health.version ? 'v' + state.health.version : 'Ops Room', ['M12 8v4l3 2', 'M12 3a9 9 0 1 0 9 9']));
  }

  function actionLink(label, type, agent, href) {
    var link = el('a', { className: 'action-link', href: href || '#' }, label);
    link.dataset.modal = type;
    link.dataset.agent = agent || '';
    return link;
  }

  function renderInstances() {
    clear(instancesContent);
    fleetCount.textContent = String(state.instances.length);

    if (!state.instances.length) {
      instancesContent.appendChild(el('div', { className: 'empty-state' }, 'No agents are currently registered.'));
      return;
    }

    state.instances.forEach(function (instance) {
      var runtime = instance.runtime || {};
      var currentTask = getCurrentTask(instance.agent);
      var row = el('article', { className: 'agent-row' });

      var identity = el('div', { className: 'agent-identity' });
      identity.appendChild(el('span', { className: 'agent-avatar' }, String(instance.display_name || instance.agent || '?').slice(0, 2).toUpperCase()));
      var identityCopy = el('div');
      identityCopy.appendChild(el('div', { className: 'agent-name' }, instance.display_name || humanize(instance.agent)));
      identityCopy.appendChild(el('div', { className: 'agent-role' }, AGENT_ROLES[String(instance.agent || '').toLowerCase()] || humanize(instance.backend) + ' agent'));
      identity.appendChild(identityCopy);
      row.appendChild(identity);

      var runtimeCell = el('div', { className: 'agent-runtime' });
      runtimeCell.appendChild(statusPill(runtime.status || 'unknown'));
      runtimeCell.appendChild(el('div', { className: 'agent-runtime-detail' }, (instance.backend || 'unknown') + ' · ' + (runtime.health === 'none' ? 'No healthcheck' : humanize(runtime.health || 'unknown'))));
      row.appendChild(runtimeCell);

      var assignment = el('div', { className: 'agent-assignment' });
      assignment.appendChild(el('div', { className: 'assignment-label' }, 'Current assignment'));
      assignment.appendChild(el('div', { className: 'assignment-title' }, currentTask ? truncate(taskTitle(currentTask), 58) : 'Available for work'));
      row.appendChild(assignment);

      var actions = el('div', { className: 'agent-actions' });
      actions.appendChild(actionLink('Logs', 'logs', instance.agent, instance.links && instance.links.logs));
      actions.appendChild(actionLink('Tasks', 'tasks', instance.agent, '/api/tasks'));
      row.appendChild(actions);

      instancesContent.appendChild(row);
    });
  }

  function renderAttention() {
    clear(attentionContent);
    var items = sortedTasks(state.tasks).filter(isAttentionTask).slice(0, 5);
    attentionCount.textContent = String(items.length);

    if (!items.length) {
      var empty = el('div', { className: 'attention-empty' });
      var icon = el('div', { className: 'attention-empty-icon' });
      icon.appendChild(svgIcon(['m6 12 4 4 8-8']));
      empty.appendChild(icon);
      empty.appendChild(el('strong', null, 'Nothing is blocked'));
      empty.appendChild(el('p', null, 'The active queue does not require human input.'));
      attentionContent.appendChild(empty);
      return;
    }

    items.forEach(function (task) {
      var item = el('article', { className: 'attention-item' });
      var top = el('div', { className: 'attention-top' });
      top.appendChild(el('div', { className: 'attention-title' }, truncate(taskTitle(task), 94)));
      top.appendChild(statusPill(taskState(task)));
      item.appendChild(top);
      item.appendChild(el('div', { className: 'attention-meta' }, taskAgent(task) + ' · ' + taskRepository(task) + ' · ' + formatRelativeTime(taskTimestamp(task))));
      attentionContent.appendChild(item);
    });
  }

  function filteredTasks() {
    var tasks = sortedTasks(state.tasks);
    if (taskFilter === 'active') return tasks.filter(isActiveTask);
    if (taskFilter === 'attention') return tasks.filter(isAttentionTask);
    return tasks;
  }

  function renderTasks() {
    clear(tasksContent);
    var tasks = filteredTasks().slice(0, 8);
    if (!tasks.length) {
      tasksContent.appendChild(el('div', { className: 'empty-state' }, taskFilter === 'all' ? 'No tasks have entered the queue yet.' : 'No tasks match this filter.'));
      return;
    }

    tasks.forEach(function (task) {
      var row = el('article', { className: 'task-row' });
      var copy = el('div');
      copy.appendChild(el('div', { className: 'task-title' }, truncate(taskTitle(task), 94)));
      copy.appendChild(el('div', { className: 'task-meta' }, taskRepository(task) + (task.issue_number != null ? ' · #' + task.issue_number : '') + (task.task_type ? ' · ' + humanize(task.task_type) : '')));
      row.appendChild(copy);
      var agent = el('div', { className: 'task-agent' });
      agent.appendChild(el('div', null, humanize(taskAgent(task))));
      agent.appendChild(statusPill(taskState(task)));
      row.appendChild(agent);
      row.appendChild(el('div', { className: 'task-time' }, formatRelativeTime(taskTimestamp(task))));
      tasksContent.appendChild(row);
    });
  }

  function healthRow(label, value, tone) {
    var row = el('div', { className: 'health-row' });
    row.appendChild(el('span', { className: 'health-label' }, label));
    row.appendChild(el('span', { className: 'health-value' + (tone ? ' health-value--' + tone : '') }, value));
    return row;
  }

  function renderHealth() {
    clear(healthContent);
    if (!state.health) {
      healthContent.appendChild(el('div', { className: 'error-state' }, 'Health data is unavailable.'));
      return;
    }

    var availableCommands = 0;
    var totalCommands = 0;
    if (state.health.commands) {
      Object.keys(state.health.commands).forEach(function (command) {
        totalCommands += 1;
        if (state.health.commands[command]) availableCommands += 1;
      });
    }
    var pollers = state.instances.filter(function (instance) { return instance.github_polling_enabled; }).length;
    var healthStatus = state.health.status || 'unknown';

    healthContent.appendChild(healthRow('Harness', humanize(healthStatus), statusTone(healthStatus)));
    healthContent.appendChild(healthRow('Docker runtime', state.docker && state.docker.available ? 'Available' : 'Unavailable', state.docker && state.docker.available ? 'success' : 'warning'));
    healthContent.appendChild(healthRow('GitHub pollers', pollers + ' enabled', pollers ? 'success' : 'warning'));
    healthContent.appendChild(healthRow('CLI dependencies', totalCommands ? availableCommands + ' / ' + totalCommands : 'Not reported', totalCommands && availableCommands === totalCommands ? 'success' : 'warning'));
    healthContent.appendChild(healthRow('Version', state.health.version || 'Not reported'));
    healthContent.appendChild(healthRow('Task storage', state.health.paths && state.health.paths.tasks_dir ? state.health.paths.tasks_dir : 'Not reported'));
  }

  function openModal(title, subtitle) {
    modalTitle.textContent = title || 'Details';
    modalSubtitle.textContent = subtitle || '';
    modalSubtitle.style.display = subtitle ? '' : 'none';
    clear(modalBody);
    modalBackdrop.classList.remove('hidden');
    modalBackdrop.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }

  function closeModal() {
    modalBackdrop.classList.add('hidden');
    modalBackdrop.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    clear(modalBody);
  }

  function buildKeyValueGrid(items) {
    var grid = el('div', { className: 'modal-kv-grid' });
    items.forEach(function (entry) {
      var row = el('div', { className: 'modal-kv-row' });
      row.appendChild(el('span', { className: 'modal-kv-label' }, entry.label));
      row.appendChild(el('span', { className: 'modal-kv-value' }, entry.value));
      grid.appendChild(row);
    });
    return grid;
  }

  function buildTaskCard(task) {
    var article = el('article', { className: 'modal-task-card' });
    var header = el('div', { className: 'modal-task-header' });
    header.appendChild(el('h3', { className: 'modal-task-title' }, taskTitle(task)));
    header.appendChild(statusPill(taskState(task)));
    article.appendChild(header);
    article.appendChild(buildKeyValueGrid([
      { label: 'Agent', value: taskAgent(task) },
      { label: 'Repository', value: taskRepository(task) },
      { label: 'Issue', value: task.issue_number != null ? '#' + task.issue_number : '—' },
      { label: 'Updated', value: formatDateTime(taskTimestamp(task)) },
      { label: 'Trigger', value: task.trigger || '—' },
      { label: 'Task type', value: task.task_type || task.taskType || '—' },
    ]));
    if (task.task || task.task_text) {
      var summary = el('div', { className: 'modal-task-summary' });
      summary.appendChild(el('div', { className: 'modal-task-summary-label' }, 'Task brief'));
      summary.appendChild(el('p', { className: 'modal-task-summary-text' }, task.task || task.task_text));
      article.appendChild(summary);
    }
    var detail = el('details', { className: 'modal-task-detail' });
    detail.appendChild(el('summary', { className: 'modal-task-detail-summary' }, 'View raw payload'));
    var pre = el('pre', { className: 'modal-code' });
    pre.textContent = JSON.stringify(task, null, 2);
    detail.appendChild(pre);
    article.appendChild(detail);
    return article;
  }

  function showLogsModal(agent, href) {
    openModal('Agent logs', humanize(agent) + ' · latest output');
    modalBody.appendChild(el('div', { className: 'modal-loading' }, 'Loading logs…'));
    fetchJson(href || '/api/logs?agent=' + encodeURIComponent(agent)).then(function (data) {
      clear(modalBody);
      var logs = data && data.logs ? data.logs : [];
      if (!logs.length) {
        modalBody.appendChild(el('div', { className: 'modal-empty' }, 'No log files are available for this agent yet.'));
        return;
      }
      logs.forEach(function (log) {
        var section = el('section', { className: 'modal-section' });
        section.appendChild(el('h3', { className: 'modal-section-title' }, log.file || 'Log file'));
        var pre = el('pre', { className: 'modal-code' });
        pre.textContent = (log.lines || []).join('\n');
        section.appendChild(pre);
        modalBody.appendChild(section);
      });
    }).catch(function () {
      clear(modalBody);
      modalBody.appendChild(el('div', { className: 'modal-error' }, 'Failed to load logs.'));
    });
  }

  function showTasksModal(agent) {
    openModal('Agent tasks', humanize(agent) + ' · queue and history');
    var filtered = sortedTasks(state.tasks).filter(function (task) { return String(taskAgent(task)).toLowerCase() === String(agent).toLowerCase(); });
    if (!filtered.length) {
      modalBody.appendChild(el('div', { className: 'modal-empty' }, 'No tasks are currently stored for this agent.'));
      return;
    }
    filtered.forEach(function (task) { modalBody.appendChild(buildTaskCard(task)); });
  }

  function renderAll() {
    renderSummary();
    renderInstances();
    renderAttention();
    renderTasks();
    renderHealth();
  }

  function updateLastUpdated() {
    lastUpdatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function showRefreshing(show) {
    refreshingIndicator.classList.toggle('hidden', !show);
    refreshBtn.disabled = show;
  }

  function fetchAll() {
    showRefreshing(true);
    Promise.all([
      fetchJson('/api/health').catch(function () { return null; }),
      fetchJson('/api/openab/instances').catch(function () { return null; }),
      fetchJson('/api/tasks').catch(function () { return { tasks: [] }; }),
    ]).then(function (results) {
      state.health = results[0];
      state.instances = results[1] && results[1].instances ? results[1].instances : [];
      state.docker = results[1] && results[1].docker ? results[1].docker : null;
      state.tasks = results[2] && results[2].tasks ? results[2].tasks : [];
      renderAll();
      updateLastUpdated();
    }).catch(function () {
      setError(instancesContent, 'Unable to load the Ops Room dashboard.');
      setError(tasksContent, 'Unable to load tasks.');
      setError(healthContent, 'Unable to load system health.');
    }).finally(function () {
      showRefreshing(false);
    });
  }

  function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(fetchAll, 10000);
  }

  refreshBtn.addEventListener('click', fetchAll);
  modalClose.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', function (event) { if (event.target === modalBackdrop) closeModal(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !modalBackdrop.classList.contains('hidden')) closeModal(); });

  document.addEventListener('click', function (event) {
    var modalLink = event.target.closest('.action-link[data-modal]');
    if (modalLink) {
      event.preventDefault();
      var modalType = modalLink.dataset.modal;
      var agent = modalLink.dataset.agent || '';
      if (modalType === 'logs') showLogsModal(agent, modalLink.href);
      if (modalType === 'tasks') showTasksModal(agent);
      return;
    }

    var filterButton = event.target.closest('[data-task-filter]');
    if (filterButton) {
      taskFilter = filterButton.dataset.taskFilter;
      document.querySelectorAll('[data-task-filter]').forEach(function (button) { button.classList.toggle('is-active', button === filterButton); });
      renderTasks();
      return;
    }

    var scrollButton = event.target.closest('[data-scroll-to], [data-target]');
    if (scrollButton) {
      var targetId = scrollButton.dataset.scrollTo || scrollButton.dataset.target;
      var target = document.getElementById(targetId);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    var comingSoon = event.target.closest('[data-coming-soon]');
    if (comingSoon) showToast(comingSoon.dataset.comingSoon + ' is planned for the next Ops Room product phase.');
  });

  setLoading(instancesContent, 'Loading agent fleet…');
  setLoading(tasksContent, 'Loading task history…');
  setLoading(attentionContent, 'Checking the queue…');
  setLoading(healthContent, 'Loading system health…');
  fetchAll();
  startAutoRefresh();
})();
