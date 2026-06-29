(function () {
  'use strict';

  const refreshBtn = document.getElementById('refresh-btn');
  const refreshingIndicator = document.getElementById('refreshing-indicator');
  const lastUpdatedEl = document.getElementById('last-updated');
  const healthContent = document.getElementById('health-content');
  const instancesContent = document.getElementById('instances-content');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle = document.getElementById('modal-title');
  const modalSubtitle = document.getElementById('modal-subtitle');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');
  let refreshInterval = null;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) { e[k] = attrs[k]; }
    }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function clear(node) {
    node.textContent = '';
  }

  function setAttr(node, name, value) {
    if (value == null || value === '') return;
    node.setAttribute(name, value);
  }

  function badgeKind(status) {
    var value = String(status || 'unknown').toLowerCase();
    if (value === 'running') return 'running';
    if (value === 'healthy') return 'healthy';
    if (value === 'stopped' || value === 'exited' || value === 'missing' || value === 'unknown') return 'neutral';
    if (value === 'warning' || value === 'degraded' || value === 'unhealthy' || value === 'restarting') return 'warning';
    return 'neutral';
  }

  function statusBadge(status, label) {
    var span = document.createElement('span');
    var kind = badgeKind(status);
    span.className = 'status-badge status-badge--' + kind;
    span.textContent = label || status || 'unknown';
    return span;
  }

  function actionLink(href, label, variant) {
    var a = el('a', { className: 'action-link action-' + (variant || 'default') });
    a.href = href;
    a.textContent = label;
    return a;
  }

  function metric(label, value) {
    var item = el('div', { className: 'metric' });
    item.appendChild(el('span', { className: 'metric-label' }, label));
    item.appendChild(el('span', { className: 'metric-value' }, value || '-'));
    return item;
  }

  function formatDateTime(value) {
    if (!value) return '-';
    var date = new Date(value);
    if (String(date) === 'Invalid Date') return String(value);
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function truncateText(value, maxLength) {
    var text = String(value || '');
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
  }

  function fetchJson(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('Request failed');
      return response.json();
    });
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

  function buildEmptyState(message) {
    return el('p', { className: 'modal-empty' }, message);
  }

  function buildLoadingState(message) {
    return el('p', { className: 'loading modal-loading' }, message || 'Loading...');
  }

  function buildErrorState(message) {
    return el('p', { className: 'error modal-error' }, message || 'Unable to load data');
  }

  function buildKeyValueGrid(items) {
    var grid = el('div', { className: 'modal-kv-grid' });
    for (var i = 0; i < items.length; i++) {
      var entry = items[i];
      var row = el('div', { className: 'modal-kv-row' });
      row.appendChild(el('span', { className: 'modal-kv-label' }, entry.label));
      row.appendChild(el('span', { className: 'modal-kv-value' }, entry.value));
      grid.appendChild(row);
    }
    return grid;
  }

  function buildLogBlock(log) {
    var section = el('section', { className: 'modal-section' });
    section.appendChild(el('h3', { className: 'modal-section-title' }, log.file || 'Log file'));
    var pre = el('pre', { className: 'modal-code' });
    pre.textContent = (log.lines || []).join('\n');
    section.appendChild(pre);
    return section;
  }

  function buildTaskCard(task) {
    var article = el('article', { className: 'modal-task-card' });
    var header = el('div', { className: 'modal-task-header' });
    header.appendChild(el('h3', { className: 'modal-task-title' }, task.issue_title || task.task || task.id || 'Task'));
    header.appendChild(statusBadge(task.status || 'pending', String(task.status || 'pending')));
    article.appendChild(header);

    article.appendChild(buildKeyValueGrid([
      { label: 'Agent', value: task.agent || '-' },
      { label: 'Issue', value: task.issue_number != null ? '#' + task.issue_number : '-' },
      { label: 'Repository', value: task.repository || '-' },
      { label: 'Received', value: formatDateTime(task.received_at) },
      { label: 'Trigger', value: task.trigger || '-' },
      { label: 'Task type', value: task.task_type || '-' },
    ]));

    if (task.task) {
      var summary = el('div', { className: 'modal-task-summary' });
      summary.appendChild(el('div', { className: 'modal-task-summary-label' }, 'Task'));
      summary.appendChild(el('p', { className: 'modal-task-summary-text' }, task.task));
      article.appendChild(summary);
    }

    var detail = el('details', { className: 'modal-task-detail' });
    detail.appendChild(el('summary', { className: 'modal-task-detail-summary' }, 'Raw payload'));
    var pre = el('pre', { className: 'modal-code' });
    pre.textContent = JSON.stringify(task, null, 2);
    detail.appendChild(pre);
    article.appendChild(detail);

    return article;
  }

  function showLogsModal(agent, href) {
    openModal('Logs', (agent || 'agent') + ' log tail');
    modalBody.appendChild(buildLoadingState('Loading logs...'));

    fetchJson(href).then(function (data) {
      clear(modalBody);
      var logs = data && data.logs ? data.logs : [];
      if (!logs.length) {
        modalBody.appendChild(buildEmptyState('No log files available for this agent yet.'));
        return;
      }
      for (var i = 0; i < logs.length; i++) {
        modalBody.appendChild(buildLogBlock(logs[i]));
      }
    }).catch(function () {
      clear(modalBody);
      modalBody.appendChild(buildErrorState('Failed to load logs.'));
    });
  }

  function showTasksModal(agent) {
    openModal('Tasks', agent ? agent + ' tasks' : 'All tasks');
    modalBody.appendChild(buildLoadingState('Loading tasks...'));

    fetchJson('/api/tasks').then(function (data) {
      clear(modalBody);
      var tasks = data && data.tasks ? data.tasks : [];
      var filtered = tasks.filter(function (task) {
        if (!agent) return true;
        return String(task.agent || '').toLowerCase() === String(agent).toLowerCase();
      });

      if (!filtered.length) {
        modalBody.appendChild(buildEmptyState(agent ? 'No queued tasks for this agent.' : 'No queued tasks right now.'));
        return;
      }

      filtered.sort(function (a, b) {
        return String(b.received_at || '').localeCompare(String(a.received_at || ''));
      });

      for (var i = 0; i < filtered.length; i++) {
        modalBody.appendChild(buildTaskCard(filtered[i]));
      }
    }).catch(function () {
      clear(modalBody);
      modalBody.appendChild(buildErrorState('Failed to load tasks.'));
    });
  }

  function boolBadge(val) {
    if (val === true) return statusBadge('running', 'Yes');
    return statusBadge('exited', 'No');
  }

  function renderHealth(data) {
    clear(healthContent);

    if (!data) {
      healthContent.appendChild(el('p', { className: 'error' }, 'Health data unavailable'));
      return;
    }

    var grid = el('div', { className: 'health-grid' });

    function addItem(label, value) {
      var item = el('div', { className: 'health-item' });
      item.appendChild(el('div', { className: 'label' }, label));
      item.appendChild(el('div', { className: 'value' }, String(value)));
      grid.appendChild(item);
    }

    addItem('Status', data.status || 'unknown');
    addItem('Uptime', (data.uptime_seconds || 0) + 's');
    addItem('Version', data.version || '-');

    if (data.paths) {
      addItem('Tasks Dir', data.paths.tasks_dir || '-');
    }

    if (data.commands) {
      for (var cmd in data.commands) {
        var available = data.commands[cmd];
        addItem(cmd, available ? 'Yes' : 'No');
      }
    }

    healthContent.appendChild(grid);
  }

  function renderInstances(data) {
    clear(instancesContent);

    var instances = data && data.instances ? data.instances : [];
    var docker = data && data.docker ? data.docker : { available: false, error: null };

    if (instances.length === 0) {
      instancesContent.appendChild(el('p', { className: 'error' }, 'No instances configured'));
      return;
    }

    var grid = el('div', { className: 'instance-grid' });

    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i];
      var runtime = inst.runtime || {};
      var status = runtime.status || 'unknown';
      var health = runtime.health || 'unknown';
      var card = el('article', { className: 'instance-card instance-card--' + badgeKind(status) });

      var top = el('div', { className: 'instance-top' });
      var titleGroup = el('div', { className: 'instance-title-group' });
      titleGroup.appendChild(el('h3', null, inst.display_name || inst.agent));
      titleGroup.appendChild(el('p', { className: 'instance-subtitle' }, inst.container_name || '-'));
      top.appendChild(titleGroup);

      var badgeGroup = el('div', { className: 'badge-group' });
      badgeGroup.appendChild(statusBadge(status, String(status || 'unknown')));
      badgeGroup.appendChild(statusBadge(health, health === 'none' ? 'no healthcheck' : String(health || 'unknown')));
      top.appendChild(badgeGroup);
      card.appendChild(top);

      var meta = el('div', { className: 'instance-meta' });
      meta.appendChild(metric('Backend', inst.backend || '-'));
      meta.appendChild(metric('Service', inst.service || '-'));
      meta.appendChild(metric('GitHub polling', inst.github_polling_enabled ? 'Enabled' : 'Disabled'));
      if (runtime.restart_count != null) {
        meta.appendChild(metric('Restarts', String(runtime.restart_count)));
      }
      card.appendChild(meta);

      var paths = el('div', { className: 'instance-paths' });
      paths.appendChild(metric('Config', inst.config_path || '-'));
      paths.appendChild(metric('Data', inst.data_dir || '-'));
      card.appendChild(paths);

      var actions = el('div', { className: 'instance-actions' });
      var logsVariant = status === 'running' || health === 'healthy' ? 'primary' : 'outlined';
      var logsLink = actionLink(inst.links ? inst.links.logs : '#', 'View logs', logsVariant);
      setAttr(logsLink, 'data-modal', 'logs');
      setAttr(logsLink, 'data-agent', inst.agent || '');
      actions.appendChild(logsLink);

      var tasksLink = actionLink('/api/tasks', 'View tasks', 'secondary');
      setAttr(tasksLink, 'data-modal', 'tasks');
      setAttr(tasksLink, 'data-agent', inst.agent || '');
      actions.appendChild(tasksLink);
      card.appendChild(actions);

      grid.appendChild(card);
    }

    instancesContent.appendChild(grid);

    var dockerPara = el('p', { className: 'docker-info' });
    dockerPara.appendChild(document.createTextNode('Docker: '));
    var dockerSpan = el('span', { className: docker.available ? 'available' : 'unavailable' }, docker.available ? 'available' : 'unavailable');
    dockerPara.appendChild(dockerSpan);
    if (docker.error) {
      dockerPara.appendChild(document.createTextNode(': ' + docker.error));
    }
    instancesContent.appendChild(dockerPara);
  }

  function setLoading(target, msg) {
    clear(target);
    target.appendChild(el('p', { className: 'loading' }, msg || 'Loading...'));
  }

  function setError(target, msg) {
    clear(target);
    target.appendChild(el('p', { className: 'error' }, msg || 'Error loading data'));
  }

  function updateLastUpdated() {
    var now = new Date();
    lastUpdatedEl.textContent = 'Updated ' + now.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function showRefreshing(show) {
    if (show) {
      refreshingIndicator.classList.remove('hidden');
    } else {
      refreshingIndicator.classList.add('hidden');
    }
  }

  function fetchAll() {
    showRefreshing(true);
    var healthPromise = fetch('/api/health').then(function (r) {
      if (!r.ok) throw new Error('Health fetch failed');
      return r.json();
    }).catch(function () {
      return null;
    });

    var instancesPromise = fetch('/api/openab/instances').then(function (r) {
      if (!r.ok) throw new Error('Instances fetch failed');
      return r.json();
    }).catch(function () {
      return null;
    });

    Promise.all([healthPromise, instancesPromise]).then(function (results) {
      var healthData = results[0];
      var instancesData = results[1];

      if (healthData) {
        renderHealth(healthData);
      } else {
        setError(healthContent, 'Failed to load health data');
      }

      if (instancesData) {
        renderInstances(instancesData);
      } else {
        setError(instancesContent, 'Failed to load instances data');
      }

      updateLastUpdated();
      showRefreshing(false);
    });
  }

  function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(fetchAll, 10000);
  }

  refreshBtn.addEventListener('click', function () {
    fetchAll();
  });

  modalClose.addEventListener('click', closeModal);

  modalBackdrop.addEventListener('click', function (event) {
    if (event.target === modalBackdrop) closeModal();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modalBackdrop.classList.contains('hidden')) {
      closeModal();
    }
  });

  document.addEventListener('click', function (event) {
    var link = event.target.closest('.action-link[data-modal]');
    if (!link) return;

    event.preventDefault();
    var modalType = link.getAttribute('data-modal');
    var agent = link.getAttribute('data-agent') || '';

    if (modalType === 'logs') {
      showLogsModal(agent, link.href);
      return;
    }

    if (modalType === 'tasks') {
      showTasksModal(agent);
    }
  });

  setLoading(healthContent, 'Loading health...');
  setLoading(instancesContent, 'Loading instances...');
  fetchAll();
  startAutoRefresh();
})();
