(function () {
  'use strict';

  const refreshBtn = document.getElementById('refresh-btn');
  const refreshingIndicator = document.getElementById('refreshing-indicator');
  const lastUpdatedEl = document.getElementById('last-updated');
  const healthContent = document.getElementById('health-content');
  const instancesContent = document.getElementById('instances-content');
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

  function statusBadge(status, label) {
    var span = document.createElement('span');
    span.className = 'status-badge status-' + (status || 'unknown');
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
      var card = el('article', { className: 'instance-card status-card-' + status });

      var top = el('div', { className: 'instance-top' });
      var titleGroup = el('div', { className: 'instance-title-group' });
      titleGroup.appendChild(el('h3', null, inst.display_name || inst.agent));
      titleGroup.appendChild(el('p', { className: 'instance-subtitle' }, inst.container_name || '-'));
      top.appendChild(titleGroup);

      var badgeGroup = el('div', { className: 'badge-group' });
      badgeGroup.appendChild(statusBadge(status));
      badgeGroup.appendChild(statusBadge(health, health === 'none' ? 'no healthcheck' : health));
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
      actions.appendChild(actionLink(inst.links ? inst.links.logs : '#', 'View logs', 'primary'));
      actions.appendChild(actionLink('/api/tasks', 'View tasks', 'secondary'));
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
    lastUpdatedEl.textContent = 'Updated: ' + now.toLocaleTimeString();
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

  setLoading(healthContent, 'Loading health...');
  setLoading(instancesContent, 'Loading instances...');
  fetchAll();
  startAutoRefresh();
})();
