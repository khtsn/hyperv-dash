const id = (name) => document.getElementById(name);
const el = (tag, attrs = {}, ...children) => {
  const out = document.createElement(tag);
  Object.assign(out, attrs);
  out.append(
    ...children
      .flat()
      .filter((x) => x !== null && x !== undefined)
      .map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))),
  );
  return out;
};
const row = (...kids) => el('div', { className: 'row' }, ...kids);
const small = (text) => el('small', {}, text);
const empty = (text) => el('p', { className: 'empty' }, text);
const button = (label, click, cls = '') => {
  const out = el('button', { type: 'button', className: cls }, label);
  out.onclick = (event) =>
    Promise.resolve()
      .then(() => click(event))
      .catch(showError);
  return out;
};
const option = (value, label = value) => el('option', { value: String(value) }, label);
const input = (attrs = {}) => el('input', attrs);
const select = (items = []) =>
  el(
    'select',
    {},
    items.map((x) => (Array.isArray(x) ? option(...x) : option(x))),
  );
let fieldId = 0;
const field = (text, control, wide = false) => {
  if (!control.id) control.id = 'field-' + ++fieldId;
  if (!control.name) control.name = text.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return el('label', { htmlFor: control.id, className: wide ? 'wide' : '' }, text, control);
};
const facts = (pairs) =>
  el(
    'dl',
    { className: 'facts' },
    pairs.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v ?? '—'))),
  );
const panel = (title, ...kids) => el('section', { className: 'panel' }, el('h2', {}, title), ...kids);
const badge = (v) => {
  const tone = {
    online: 'ok',
    running: 'ok',
    done: 'ok',
    degraded: 'warn',
    interrupted: 'warn',
    unreachable: 'bad',
    failed: 'bad',
  }[String(v).toLowerCase()];
  return el('span', { className: 'badge ' + (tone || '') }, v || 'Unknown');
};
const table = (headers, rows, hint) =>
  rows.length
    ? el(
        'div',
        { className: 'scroll' },
        el(
          'table',
          {},
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              headers.map((h) => el('th', { scope: 'col' }, h)),
            ),
          ),
          el(
            'tbody',
            {},
            rows.map((cells) =>
              el(
                'tr',
                {},
                cells.map((v) => el('td', {}, v ?? '—')),
              ),
            ),
          ),
        ),
      )
    : empty(hint);
const time = (v) => {
  if (!v) return 'Never';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? 'Unknown'
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
};
const measure = (v, unit, div = 1) =>
  v == null || !Number.isFinite(Number(v))
    ? '—'
    : (Number(v) / div).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + unit;
const gib = (v) => measure(v, 'GiB', 1024);
const query = (o) => new URLSearchParams(o).toString();
const desc = {
  fleet: ['Fleet overview', 'Health and available capacity across your hosts.'],
  monitoring: ['Monitoring', 'Metric history and alerts across your fleet.'],
  machines: ['Virtual machines', 'Find a VM to inspect its hardware, open the console, or change its state.'],
  networks: ['Networks & IPs', 'Virtual switches, address assignments, and inbound port mappings.'],
  provision: ['Provision a VM', 'Create a Linux guest and follow its first boot.'],
  library: ['Images & profiles', 'Base images and software applied during first boot.'],
  jobs: ['Jobs', 'Operation status and execution logs.'],
  audit: ['Audit log', 'Administrator and operator activity.'],
};
let user,
  view,
  epoch = 0,
  viewPoll,
  disposeModal,
  modalEpoch = 0,
  activePoll = false;
const canOperate = () => user?.role === 'admin' || user?.role === 'operator';
const admin = () => user?.role === 'admin';
async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = user?.csrf || '';
  }
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {
    location.replace('/login');
    throw Error('Session expired. Sign in again.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Request failed (' + r.status + ').');
  return j;
}
function showError(e) {
  const n = id('notice');
  n.hidden = false;
  n.textContent = e?.message || String(e);
  id('live').textContent = 'Request failed';
  id('live').className = 'offline';
}
function alertBox(e) {
  return el('p', { className: 'error', role: 'alert' }, e?.message || String(e));
}
function closeModal() {
  id('modal').close();
}
function clearModal() {
  ++modalEpoch;
  disposeModal?.();
  disposeModal = null;
  id('sheet').replaceChildren();
}
function dialog(title, child, dispose) {
  clearModal();
  id('modal-title').textContent = title;
  id('sheet').append(child);
  disposeModal = dispose;
  if (!id('modal').open) id('modal').showModal();
  return modalEpoch;
}
function confirmTyped(title, detail, expected, go) {
  const box = el('form', {}),
    name = input({ required: true, autocomplete: 'off' }),
    del = el('button', { type: 'submit', className: 'danger' }, title),
    msg = el('div', { role: 'status' });
  box.append(
    el('p', {}, detail),
    field('Type ' + expected + ' to confirm', name),
    el('div', { className: 'form-actions' }, del, button('Cancel', closeModal)),
    msg,
  );
  box.onsubmit = async (e) => {
    e.preventDefault();
    if (name.value !== expected) {
      msg.replaceChildren(alertBox('The confirmation must match exactly.'));
      return;
    }
    del.disabled = true;
    try {
      const result = await go(name.value);
      if (box.isConnected) closeModal();
      await refreshPage();
      if (result?.job) await jobDetail(result.job);
    } catch (error) {
      msg.replaceChildren(alertBox(error));
    } finally {
      del.disabled = false;
    }
  };
  dialog(title, box);
}
function activeSection() {
  const v = location.hash.slice(1);
  return Object.hasOwn(desc, v) ? v : 'fleet';
}
function ready() {
  id('live').textContent = 'Updated ' + new Date().toLocaleTimeString();
  id('live').className = 'ready';
}
async function tick() {
  if (!viewPoll || activePoll || document.hidden) return;
  const token = epoch;
  activePoll = true;
  try {
    await viewPoll();
    if (token === epoch) {
      ready();
      id('notice').hidden = true;
    }
  } catch (e) {
    if (token === epoch) showError(e);
  } finally {
    activePoll = false;
  }
}
async function refreshPage() {
  const token = ++epoch;
  view = activeSection();
  viewPoll = null;
  const n = id('notice');
  n.hidden = true;
  n.textContent = '';
  id('actions').replaceChildren();
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.hash === '#' + view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const [title, subtitle] = desc[view];
  document.title = title + ' · Hyper-V Dash';
  id('title').textContent = title;
  id('subtitle').textContent = subtitle;
  const area = el('div', { className: 'stack' });
  id('content').replaceChildren(area);
  id('content').setAttribute('aria-busy', 'true');
  try {
    await { fleet, monitoring, machines, networks, provision, library, jobs, audit }[view](area, token);
    if (epoch === token) ready();
  } catch (e) {
    if (epoch === token) {
      area.append(alertBox(e));
      showError(e);
    }
  } finally {
    if (epoch === token) id('content').setAttribute('aria-busy', 'false');
  }
}
function live(token, fn) {
  if (token === epoch) viewPoll = fn;
}
function setActions(...nodes) {
  id('actions').replaceChildren(...nodes.filter(Boolean));
}
const metric = (label, value, extra) =>
  el(
    'div',
    { className: 'metric' },
    el('span', {}, label),
    el('strong', {}, value),
    extra ? small(extra) : null,
  );
async function fleet(area, token) {
  const draw = async () => {
    const f = await api('/api/fleet');
    if (epoch !== token) return;
    const hosts = f.hosts || [],
      t = f.totals || {},
      open = new Set([...area.querySelectorAll('details[open]')].map((d) => d.dataset.host));
    const alertsFor = (h) => (f.alerts || []).filter(a => a.host === h.name);
    const needsAttention = (h) => h.status !== 'online' || alertsFor(h).length > 0;
    const healthy = hosts.filter((h) => !needsAttention(h)),
      issues = hosts.filter(needsAttention);
    const parts = [
      el(
        'div',
        { className: 'metrics' },
        metric(
          'Hosts online',
          (t.online ?? 0) + ' / ' + (t.hosts ?? hosts.length),
          issues.length ? issues.length + ' need attention' : '',
        ),
        metric(
          'Running VMs',
          String(t.running ?? 0),
          (t.stopped ?? 0) + ' stopped · ' + (t.totalVMs ?? 0) + ' total',
        ),
        metric('Free CPU', measure(t.freeCpuCores, 'vCPU'), 'Estimated logical capacity'),
        metric('Free memory', gib(t.freeMemoryMB)),
        metric('Free storage', measure(t.freeDiskGB, 'GiB')),
      ),
    ];
    if (hosts.length && t.reportingHosts < hosts.length)
      parts.push(
        small(
          'Capacity totals include ' + t.reportingHosts + ' of ' + hosts.length + ' hosts with current data.',
        ),
      );
    if (issues.length)
      parts.push(
        el(
          'section',
          {},
          el(
            'div',
            { className: 'section-head' },
            el('h2', {}, 'Needs attention'),
            badge(issues.length + ' hosts'),
          ),
          issues.map((h) => hostCard(h, true, alertsFor(h))),
        ),
      );
    parts.push(
      el(
        'section',
        {},
        el(
          'div',
          { className: 'section-head' },
          el('h2', {}, 'Healthy hosts'),
          small(healthy.length + ' online'),
        ),
        healthy.length
          ? healthy.map((h) => hostCard(h, open.has(h.name)))
          : empty(
              hosts.length
                ? 'No hosts are reporting healthy.'
                : 'No hosts configured. An administrator can add the first host.',
            ),
      ),
    );
    area.replaceChildren(...parts);
  };
  setActions(
    button('Refresh', draw),
    admin() ? button('Add host', () => hostForm(), 'primary') : document.createTextNode(''),
  );
  await draw();
  live(token, draw);
}
function hostCard(h, opened, alerts = []) {
  const d = el('details', { className: 'host', open: opened });
  d.dataset.host = h.name;
  const capacity = h.capacity || {};
  const body = el('div', { className: 'panel-body' });
  if (h.error || h.suggestion) body.append(alertBox([h.error, h.suggestion].filter(Boolean).join(' ')));
  for (const alert of alerts) body.append(el('p', { className: 'capacity-warning' }, alert.message + ' · Since ' + time(alert.opened)));
  if (alerts.length) body.append(el('a', { href: '#monitoring' }, 'View metric history and alerts'));
  body.append(
    facts([
      ['Address', h.address],
      ['Transport', h.transport],
      ['OS / build', [h.os, h.build].filter(Boolean).join(' · ')],
      ['Hyper-V', h.hyperVVersion],
      ['CPU', h.cpuModel],
      ['Physical cores / threads', [h.cores, h.logicalProcessors].filter((x) => x != null).join(' / ')],
      ['CPU usage', measure(h.cpuPct, '%')],
      ['Allocated vCPU', capacity.allocatedVcpus],
      [
        'Memory used / total',
        gib(h.memTotalMB == null || h.memFreeMB == null ? null : h.memTotalMB - h.memFreeMB) +
          ' / ' +
          gib(h.memTotalMB),
      ],
      ['RAM allocated / physical', gib(capacity.allocatedMemoryMB) + ' / ' + gib(h.memTotalMB)],
      [
        'Disks provisioned / physical',
        measure(capacity.provisionedDiskGB, 'GiB') + ' / ' + measure(capacity.physicalDiskGB, 'GiB'),
      ],
      ['Uptime', elapsed(h.uptimeSec)],
      ['Last boot', time(h.lastBoot)],
      ['Last poll', time(h.sampledAt)],
      ['Last successful contact', time(h.lastSeen)],
    ]),
  );
  body.append(
    table(
      ['Volume', 'Free', 'Total'],
      (h.disks || []).map((v) => [v.name, measure(v.freeGB, 'GiB'), measure(v.sizeGB, 'GiB')]),
      'No volume data available.',
    ),
  );
  if (admin())
    body.append(
      row(
        button('Edit host', async () => {
          const all = await api('/api/hosts');
          hostForm(all.find((x) => x.name === h.name) || h);
        }),
        button(
          'Remove host',
          () =>
            confirmTyped(
              'Remove host',
              'Remove ' + h.name + ' from this dashboard. Its VMs remain on the host.',
              h.name,
              (confirm) => api('/api/hosts/remove', { name: h.name, confirm }),
            ),
          'danger',
        ),
      ),
    );
  d.append(
    el(
      'summary',
      {},
      el('strong', {}, h.displayName || h.name),
      badge(h.status),
      small('Last seen ' + time(h.lastSeen)),
    ),
    body,
  );
  return d;
}
function historyChart(label, unit, history, read) {
  const values = history.points.map(p => p.value == null ? null : read(p.value));
  const observed = values.filter(Number.isFinite);
  const figure = el('figure', { className: 'history-chart' }, el('figcaption', {}, label));
  if (!observed.length) {
    figure.append(empty('No readings in this period.'));
    return figure;
  }
  const ceiling = unit === '%' ? 100 : Math.max(...observed, 1);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 90');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label + ', ' + observed.length + ' readings, latest ' + measure(observed.at(-1), unit));
  let previous = '', lines = '';
  for (const [i, value] of values.entries()) {
    if (!Number.isFinite(value)) { previous = ''; continue; }
    const x = 2 + 396 * i / Math.max(1, values.length - 1), y = 87 - 84 * value / ceiling;
    const position = x.toFixed(1) + ' ' + y.toFixed(1);
    lines += (previous ? ' L' : ' M') + position;
    // A short round-capped segment also makes isolated samples visible.
    if (!previous) lines += ' l0.1 0';
    previous = position;
  }
  const line = document.createElementNS(svg.namespaceURI, 'path');
  line.setAttribute('d', lines);
  svg.append(line);
  figure.append(el('strong', {}, measure(observed.at(-1), unit)), small('Scale 0–' + measure(ceiling, unit)), svg);
  return figure;
}
function thresholdDialog(limits, refresh) {
  const number = value => input({ type: 'number', min: 1, max: 99, step: 1, required: true, value });
  const disk = number(limits.diskFreePct), memory = number(limits.memoryUsedPct);
  const msg = el('div', { role: 'status' });
  const form = el('form', {},
    el('div', { className: 'fields' }, field('Disk free below (%)', disk), field('Memory used above (%)', memory)),
    el('div', { className: 'form-actions' }, el('button', { type: 'submit', className: 'primary' }, 'Save thresholds')), msg);
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/alerts/thresholds', { diskFreePct: disk.valueAsNumber, memoryUsedPct: memory.valueAsNumber });
      closeModal();
      await refresh();
    } catch (error) { msg.replaceChildren(alertBox(error)); }
  };
  dialog('Fleet alert thresholds', form);
}
async function monitoring(area, token) {
  const host = select(), guest = select(), device = select();
  const range = select([['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']]);
  const alerts = el('div', {}), delivery = el('p', { className: 'hint' }), resolved = el('div', {});
  const body = el('div', { className: 'stack' });
  let history, revision = 0, limits;
  const editLimits = admin() ? button('Alert thresholds', () => thresholdDialog(limits, load)) : null;
  if (editLimits) editLimits.disabled = true;
  const filters = el('div', { className: 'toolbar' }, field('Host', host), field('Scope', guest),
    field('Metric group', device), field('Time range', range));
  area.append(panel('Active alerts', alerts, delivery), panel('Metric history', filters, body),
    panel('Recently resolved', resolved));
  function choices(control, items) {
    const value = control.value;
    // Preserve focus/open native selects on a background refresh.
    if (JSON.stringify(items) !== control.dataset.choices) {
      control.replaceChildren(...items.map(pair => option(...pair)));
      control.dataset.choices = JSON.stringify(items);
    }
    if (items.some(([id]) => id === value)) control.value = value;
  }
  const deviceKey = d => JSON.stringify([d.kind, d.id]);
  function draw() {
    if (!history) { body.replaceChildren(empty('Add a host to collect metrics.')); return; }
    const devices = new Map();
    for (const p of history.points) for (const d of p.value?.io || []) devices.set(deviceKey(d), d);
    choices(device, [['', 'Overview'], ...Array.from(devices, ([k, d]) => [k, (d.kind === 'disk' ? 'Disk · ' : 'Network · ') + d.name])]);
    const selected = devices.get(device.value);
    const charts = el('div', { className: 'history-charts' });
    const chart = (label, unit, read) => charts.append(historyChart(label, unit, history, read));
    if (selected) {
      const sample = v => (v.io || []).find(d => deviceKey(d) === device.value);
      for (const [prop, label] of selected.kind === 'nic' ? [['receiveBps', 'Receive'], ['sendBps', 'Send']] :
        [['readBps', 'Read'], ['writeBps', 'Write'], ['latencyMs', 'I/O latency']]) {
        chart(label, prop === 'latencyMs' ? 'ms' : 'KiB/s', v => {
          const n = sample(v)?.[prop];
          return Number.isFinite(n) ? n / (prop === 'latencyMs' ? 1 : 1024) : null;
        });
      }
    } else {
      chart('CPU usage', '%', v => v.cpuPct);
      chart(guest.value ? 'Assigned memory' : 'Used memory', 'GiB', v => {
        if (guest.value) return Number.isFinite(v.memMB) ? v.memMB / 1024 : null;
        return Number.isFinite(v.memTotalMB) && Number.isFinite(v.memFreeMB) ? (v.memTotalMB - v.memFreeMB) / 1024 : null;
      });
      if (!guest.value) chart('Free storage', 'GiB', v => v.freeDiskGB);
    }
    const latest = history.points.findLast(p => p.value);
    body.replaceChildren(charts,
      small(time(history.start) + ' – ' + time(history.end) + ' · Last sample per ' + history.stepMinutes +
        ' min · Latest reading ' + (latest ? time(latest.sampledAt) : 'unavailable')));
    if (latest) {
      body.append(table(['Device', 'Receive / read', 'Send / write', 'I/O latency'],
        (latest.value.io || []).map(d => [
          d.name, measure(d.kind === 'nic' ? d.receiveBps : d.readBps, 'KiB/s', 1024),
          measure(d.kind === 'nic' ? d.sendBps : d.writeBps, 'KiB/s', 1024), measure(d.latencyMs, 'ms'),
        ]), 'No device counters in the latest reading.'));
    }
  }
  async function load() {
    const id = ++revision, current = () => id === revision && token === epoch;
    const [list, status] = await Promise.all([api('/api/hosts'), api('/api/alerts')]);
    if (!current()) return;
    limits = status.thresholds;
    if (editLimits) editLimits.disabled = false;
    const oldHost = host.value;
    choices(host, list.map(h => [h.name, h.displayName || h.name]));
    if (oldHost !== host.value) { guest.value = ''; device.value = ''; }
    const subject = guest.value;
    const records = host.value ? await api('/api/history?' + query({ host: host.value, range: range.value, vm: subject })) : null;
    if (!current()) return;
    history = records;
    const guests = history?.vms.map(v => [v.id, v.name]) || [];
    if (subject && !guests.some(([id]) => id === subject)) guests.push([subject, guest.selectedOptions[0]?.textContent || subject]);
    choices(guest, [['', 'Host'], ...guests]);
    alerts.replaceChildren(table(['Host', 'Condition', 'Opened'],
      status.active.map(a => [a.host, a.message, time(a.opened)]), 'No active alerts.'));
    resolved.replaceChildren(table(['Host', 'Condition', 'Opened', 'Resolved'],
      status.recent.map(a => [a.host, a.message, time(a.opened), time(a.resolved)]), 'No resolved alerts.'));
    delivery.textContent = 'Disk free below ' + limits.diskFreePct + '% · Memory used above ' + limits.memoryUsedPct +
      '% · Delivery: ' + status.delivery + (status.pending ? ' · ' + status.pending + ' queued, ' + status.retrying + ' retrying' : '');
    draw();
  }
  const changed = () => { body.replaceChildren(empty('Loading readings…')); load().catch(showError); };
  host.onchange = () => { guest.value = ''; device.value = ''; changed(); };
  guest.onchange = () => { device.value = ''; changed(); };
  range.onchange = changed;
  device.onchange = draw;
  setActions(button('Refresh', load), editLimits);
  await load();
  live(token, load);
}
function elapsed(v) {
  if (v == null) return '—';
  const secs = Math.max(0, Number(v));
  return secs >= 86400
    ? Math.floor(secs / 86400) + 'd ' + Math.floor((secs % 86400) / 3600) + 'h'
    : secs >= 3600
      ? Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm'
      : Math.floor(secs / 60) + 'm';
}
function hostForm(h) {
  const f = el('form', {}),
    name = input({ required: true, value: h?.name || '', readOnly: Boolean(h) }),
    displayName = input({ value: h?.displayName || '', maxLength: 80, placeholder: 'Defaults to host ID' }),
    clearCredential = input({ type: 'checkbox' }),
    address = input({ required: true, value: h?.address || '', placeholder: 'server01.example.net' }),
    transport = select([
      ['winrm-https', 'WinRM over HTTPS'],
      ['winrm', 'WinRM'],
      ['local', 'Local Hyper-V'],
    ]),
    account = input({ value: h?.credentialUser || '', autocomplete: 'off' }),
    pass = input({ type: 'password', autocomplete: 'new-password' }),
    msg = el('div', { role: 'status' }),
    save = el('button', { type: 'submit', className: 'primary' }, h ? 'Save changes' : 'Add host');
  transport.value = h?.transport || 'winrm-https';
  const body = () => ({
    name: name.value.trim(),
    displayName: displayName.value.trim() || name.value.trim(),
    clearCredential: clearCredential.checked,
    address: address.value.trim(),
    transport: transport.value,
    ...(h ? { originalName: h.name } : {}),
    ...(account.value && !clearCredential.checked ? { user: account.value } : {}),
    ...(pass.value && !clearCredential.checked ? { password: pass.value } : {}),
  });
  clearCredential.onchange = () => {
    account.disabled = pass.disabled = clearCredential.checked;
  };
  const test = button('Test connection', async () => {
    if (!f.reportValidity()) return;
    test.disabled = true;
    msg.textContent = 'Testing host connection…';
    try {
      const r = await api('/api/hosts/test', body());
      msg.replaceChildren(
        el(
          'p',
          { className: 'success' },
          'Connected to ' + (r.computer || name.value) + (r.os ? ' · ' + r.os : ''),
        ),
      );
    } catch (e) {
      msg.replaceChildren(alertBox(e));
    } finally {
      test.disabled = false;
    }
  });
  f.append(
    el(
      'div',
      { className: 'fields' },
      field('Host ID', name),
      field('Display name', displayName),
      field('Transport', transport),
      field('Host address', address),
      field('Connection account', account),
      field(h?.hasCredential ? 'New password (blank keeps saved credential)' : 'Connection password', pass),
      h?.hasCredential
        ? el(
            'label',
            { className: 'check wide' },
            clearCredential,
            'Clear the saved credential and use the service identity',
          )
        : null,
    ),
    el('div', { className: 'form-actions' }, test, save),
    msg,
  );
  f.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    test.disabled = true;
    msg.textContent = 'Testing and saving host…';
    try {
      await api('/api/hosts/save', body());
      closeModal();
      await refreshPage();
    } catch (err) {
      msg.replaceChildren(alertBox(err));
    } finally {
      save.disabled = false;
      test.disabled = false;
    }
  };
  dialog(h ? 'Edit ' + h.name : 'Add host', f);
}
async function machines(area, token) {
  const q = input({ type: 'search', placeholder: 'Name or IP' }),
    host = select([['', 'All hosts']]),
    state = select([['', 'All states']]),
    tag = input({ placeholder: 'Any tag' }),
    sort = select(
      ['name', 'host', 'state', 'vcpu', 'memMB', 'ip'].map((v, i) => [
        v,
        ['VM name', 'Host', 'State', 'vCPU', 'Memory', 'IP'][i],
      ]),
    ),
    direction = select([
      ['asc', 'Ascending'],
      ['desc', 'Descending'],
    ]),
    body = el('div', {});
  let all = [];
  function draw() {
    const text = q.value.trim().toLowerCase(),
      tagQ = tag.value.trim().toLowerCase(),
      col = sort.value;
    const rows = all.filter(
      (v) =>
        (!host.value || v.host === host.value) &&
        (!state.value || v.state === state.value) &&
        (!tagQ || (v.tags || []).some((t) => String(t).toLowerCase().includes(tagQ))) &&
        [v.host, v.name, ...(v.ips || [])].join(' ').toLowerCase().includes(text),
    );
    const val = (v) => (col === 'ip' ? v.ips?.[0] || '' : (v[col] ?? ''));
    rows.sort(
      (a, b) =>
        String(val(a)).localeCompare(String(val(b)), undefined, { numeric: true }) *
        (direction.value === 'asc' ? 1 : -1),
    );
    body.replaceChildren(
      table(
        ['VM', 'Host', 'State', 'vCPU', 'CPU usage', 'Assigned RAM', 'Uptime', 'Addresses', 'Tags'],
        rows.map((v) => [
          button(v.name, () => vmDetail(v), 'link'),
          v.host,
          badge(v.state),
          v.vcpu,
          measure(v.cpuPct, '%'),
          gib(v.memMB),
          elapsed(v.uptimeSec),
          (v.ips || []).join(', '),
          (v.tags || []).join(', ') + (v.protected ? ' · Protected' : ''),
        ]),
        all.length ? 'No matching VMs.' : 'No VM inventory available.',
      ),
    );
  }
  function fill(sel, values, allLabel) {
    const old = sel.value;
    sel.replaceChildren(
      option('', allLabel),
      ...[...new Set(values)]
        .filter(Boolean)
        .sort()
        .map((x) => option(x)),
    );
    sel.value = old;
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  }
  const load = async () => {
    const v = await api('/api/vms');
    if (epoch !== token) return;
    all = v;
    fill(
      host,
      all.map((x) => x.host),
      'All hosts',
    );
    fill(
      state,
      all.map((x) => x.state),
      'All states',
    );
    draw();
  };
  area.append(
    el(
      'div',
      { className: 'panel' },
      el(
        'div',
        { className: 'toolbar' },
        field('Search', q),
        field('Host', host),
        field('State', state),
        field('Tag', tag),
        field('Sort by', sort),
        field('Order', direction),
      ),
      body,
    ),
  );
  [q, host, state, tag, sort, direction].forEach((c) => (c.oninput = draw));
  setActions(
    button('Refresh', load),
    canOperate() ? el('a', { href: '#provision', className: 'btn primary' }, 'Provision a VM') : null,
  );
  await load();
  live(token, load);
}
async function vmDetail(v) {
  const container = el('div', {}, 'Loading VM details…'),
    token = dialog('VM details', container);
  try {
    const { mountVMPanel } = await import('/vm-ui.js');
    if (token !== modalEpoch) return;
    const end = await mountVMPanel(container, {
      host: v.host,
      name: v.name,
      user,
      api,
      refresh: () => tick(),
    });
    if (token === modalEpoch) disposeModal = typeof end === 'function' ? end : null;
    else if (typeof end === 'function') end();
  } catch (e) {
    if (token === modalEpoch) container.replaceChildren(alertBox(e));
  }
}
async function networks(area, token) {
  const [fleet, ledger] = await Promise.all([api('/api/fleet'), api('/api/ledger')]);
  if (epoch !== token) return;
  const hosts = fleet.hosts || [],
    pick = select(hosts.map((h) => [h.name, h.displayName || h.name])),
    netBody = el('div', {}),
    natBody = el('div', {});
  let current = 0;
  const switches = panel('Virtual switches', netBody),
    nat = panel('NAT port forwarding', natBody);
  const show = async () => {
    const host = hosts.find((h) => h.name === pick.value),
      generation = ++current;
    netBody.replaceChildren(
      table(
        ['Switch', 'Type', 'Attached adapters'],
        (host?.networks || []).map((n) => [
          n.name,
          n.type,
          [...(n.physicalAdapters || []), ...(n.adapters || [])]
            .map((a) => (typeof a === 'string' ? a : [a.vm, a.adapter].filter(Boolean).join(' / ')))
            .join(', '),
        ]),
        'No switch inventory on this host.',
      ),
    );
    natBody.replaceChildren(empty(host ? 'Loading NAT mappings…' : 'Select a host.'));
    if (!host) return;
    try {
      const data = await api('/api/nat?' + query({ host: host.name }));
      if (generation !== current || epoch !== token) return;
      const maps = data.mappings || [],
        nets = data.networks || [];
      const remove = (m) =>
        confirmTyped(
          'Remove mapping',
          m.protocol +
            ' ' +
            m.externalIP +
            ':' +
            m.externalPort +
            ' → ' +
            m.internalIP +
            ':' +
            m.internalPort +
            ' will stop forwarding on ' +
            host.name +
            ' / ' +
            m.nat +
            '.',
          m.nat + '/' + m.id,
          (confirm) => api('/api/nat', { ...m, host: host.name, action: 'remove', confirm }),
        );
      natBody.replaceChildren(
        table(
          ['Network', 'Protocol', 'Listen address', 'Guest address', ...(admin() ? ['Action'] : [])],
          maps.map((m) => [
            m.nat,
            m.protocol,
            m.externalIP + ':' + m.externalPort,
            m.internalIP + ':' + m.internalPort,
            ...(admin() ? [button('Remove', () => remove(m), 'danger')] : []),
          ]),
          'No static port forwards.',
        ),
      );
      if (admin() && nets.length)
        natBody.append(button('Add port forward', () => natForm(host, nets), 'primary'));
      if (!nets.length) natBody.append(small('No NAT networks were found on this host.'));
    } catch (e) {
      if (generation === current) natBody.replaceChildren(alertBox(e));
    }
  };
  pick.onchange = show;
  area.append(
    field('Host', pick),
    switches,
    nat,
    panel(
      'IP address ledger',
      table(
        ['Network', 'IP address', 'Host', 'VM', 'Source'],
        ledger.map((l) => [l.network, l.address, l.host, l.vm, l.source]),
        'No recorded allocations.',
      ),
    ),
  );
  setActions(button('Refresh', refreshPage));
  await show();
}
function natForm(host, nets) {
  const f = el('form', {}),
    nat = select(nets.map((n) => [n.name, n.name + (n.prefix ? ' · ' + n.prefix : '')])),
    protocol = select(['TCP', 'UDP']),
    externalIP = input({ required: true, value: '0.0.0.0' }),
    externalPort = input({ type: 'number', required: true, min: 1, max: 65535 }),
    internalIP = input({ required: true, placeholder: '192.168.1.10' }),
    internalPort = input({ type: 'number', required: true, min: 1, max: 65535 }),
    send = el('button', { type: 'submit', className: 'primary' }, 'Create port forward'),
    msg = el('div', { role: 'status' });
  f.append(
    el(
      'div',
      { className: 'fields' },
      field('NAT network', nat),
      field('Protocol', protocol),
      field('External IPv4 address', externalIP),
      field('External port', externalPort),
      field('Guest IPv4 address', internalIP),
      field('Guest port', internalPort),
    ),
    el('div', { className: 'form-actions' }, send),
    msg,
  );
  f.onsubmit = async (e) => {
    e.preventDefault();
    send.disabled = true;
    try {
      const res = await api('/api/nat', {
        host: host.name,
        action: 'add',
        nat: nat.value,
        protocol: protocol.value,
        externalIP: externalIP.value,
        externalPort: Number(externalPort.value),
        internalIP: internalIP.value,
        internalPort: Number(internalPort.value),
      });
      closeModal();
      if (res.job) jobDetail(res.job);
      else await refreshPage();
    } catch (error) {
      msg.replaceChildren(alertBox(error));
    } finally {
      send.disabled = false;
    }
  };
  dialog('Add port forward · ' + host.name, f);
}
async function provision(area, token) {
  if (!canOperate()) {
    area.append(empty('Provisioning requires an operator or administrator account.'));
    return;
  }
  const [fleet, images, profiles] = await Promise.all([
    api('/api/fleet'),
    api('/api/images'),
    api('/api/profiles'),
  ]);
  if (epoch !== token) return;
  const hosts = (fleet.hosts || []).filter(
    (h) => h.status === 'online' || (h.status === 'degraded' && h.fresh !== false),
  );
  if (!hosts.length || !images.length) {
    area.append(
      empty(
        !hosts.length
          ? 'No reachable hosts ready for provisioning. Check the fleet overview.'
          : 'No base images available.',
      ),
    );
    return;
  }
  const f = el('form', { className: 'panel' }),
    host = select(hosts.map((h) => [h.name, h.displayName || h.name])),
    name = input({
      required: true,
      placeholder: 'debian-app-01',
      pattern: '[A-Za-z0-9][A-Za-z0-9\\-]{0,30}',
    }),
    image = select(images.map((i) => [i.id, i.os + ' ' + (i.version || '')])),
    profile = select(profiles.map((p) => [p.id, p.label + (p.isDefault ? ' (default)' : '')])),
    cpu = input({ required: true, type: 'number', min: 1, max: 32, value: 2 }),
    memMB = input({ required: true, type: 'number', min: 512, max: 262144, value: 2048 }),
    diskGB = input({ required: true, type: 'number', min: 4, max: 2000, value: 20 }),
    volume = select(),
    sw = select(),
    userInput = input({ required: true, value: 'debian', pattern: '[a-z_][a-z0-9_\\-]{0,30}' }),
    password = input({ type: 'password', autocomplete: 'new-password' }),
    sshKey = el('textarea', { placeholder: 'ssh-ed25519 …' }),
    mode = select([
      ['dhcp', 'DHCP'],
      ['static', 'Static IPv4'],
    ]),
    ip = input({ placeholder: '192.168.50.10/24' }),
    gateway = input({ placeholder: '192.168.50.1' }),
    dns = input({ value: '1.1.1.1,8.8.8.8' }),
    hint = el('p', { className: 'hint', role: 'status' }),
    capacity = el('p', { className: 'hint' }),
    msg = el('div', { role: 'status' }),
    submit = el('button', { type: 'submit', className: 'primary' }, 'Create VM');
  const inputs = {
    name,
    cpu,
    memMB,
    diskGB,
    volume,
    switch: sw,
    user: userInput,
    password,
    sshKey,
    profile: profile,
    image: image,
  };
  profile.value = profiles.find((p) => p.isDefault)?.id || profiles[0]?.id || 'minimal';
  const pickedHost = () => hosts.find((h) => h.name === host.value);
  const setHost = () => {
    const h = pickedHost();
    volume.replaceChildren(
      ...(h.disks || []).map((d) => option(d.name, d.name + ' · ' + measure(d.freeGB, 'GiB') + ' free')),
    );
    sw.replaceChildren(
      ...(h.switches || []).map((s) => {
        const name = typeof s === 'string' ? s : s.name;
        return option(name, name);
      }),
    );
    capacity.textContent = 'Available memory on ' + h.name + ': ' + gib(h.memFreeMB) + '.';
    submit.disabled = !sw.value || !volume.value;
    hint.textContent = '';
    ip.value = '';
    gateway.value = '';
  };
  host.onchange = setHost;
  sw.onchange = () => {
    ip.value = '';
    gateway.value = '';
    hint.textContent = '';
  };
  const pickIP = button('Suggest a free IP', async () => {
    pickIP.disabled = true;
    hint.textContent = 'Checking switch and saved addresses…';
    const h = host.value,
      s = sw.value;
    try {
      const r = await api('/api/freeip?' + query({ host: h, switch: s }));
      if (host.value !== h || sw.value !== s) return;
      if (r.ip) {
        ip.value = r.ip;
        gateway.value = r.gateway || '';
        hint.textContent = 'Address will be checked again before creating the VM.';
      } else hint.textContent = r.reason || 'No available address found.';
    } catch (e) {
      hint.textContent = e.message;
    } finally {
      pickIP.disabled = false;
    }
  });
  const networkFields = el(
    'div',
    { className: 'fields' },
    field('Static IPv4 / CIDR', ip),
    field('Gateway', gateway),
    field('DNS servers (comma-separated)', dns),
    row(pickIP),
    hint,
  );
  const showIP = () => {
    networkFields.hidden = mode.value !== 'static';
    ip.required = gateway.required = mode.value === 'static';
  };
  mode.onchange = showIP;
  showIP();
  f.append(
    el('h2', {}, 'Guest configuration'),
    el(
      'div',
      { className: 'fields' },
      field('Host', host),
      field('VM name', name),
      field('Base image', image),
      field('Software profile', profile),
      field('vCPU', cpu),
      field('Memory (MiB)', memMB),
      field('Storage volume', volume),
      field('OS disk (GiB)', diskGB),
      field('Virtual switch', sw),
      field('Address assignment', mode),
    ),
    networkFields,
    capacity,
    el('h3', {}, 'Guest login'),
    small('Provide an SSH public key, a password, or both.'),
    el(
      'div',
      { className: 'fields' },
      field('Linux username', userInput),
      field('Password', password),
      field('SSH public key', sshKey, true),
    ),
    el('div', { className: 'form-actions' }, submit),
    msg,
  );
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!sshKey.value.trim() && !password.value) {
      msg.replaceChildren(alertBox('Enter an SSH public key or a password.'));
      return;
    }
    submit.disabled = true;
    msg.textContent = 'Submitting…';
    try {
      const b = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
      b.host = host.value;
      if (mode.value === 'static') Object.assign(b, { ip: ip.value, gateway: gateway.value, dns: dns.value });
      const r = await api('/api/create', b);
      password.value = '';
      msg.replaceChildren(
        row(
          'Provisioning submitted.',
          button('Open job', () => jobDetail(r.job), 'link'),
        ),
      );
      await jobDetail(r.job);
    } catch (error) {
      msg.replaceChildren(alertBox(error));
    } finally {
      submit.disabled = false;
    }
  };
  setHost();
  area.append(f);
}
async function library(area, token) {
  const [images, profiles] = await Promise.all([api('/api/images'), api('/api/profiles')]);
  if (epoch !== token) return;
  const imageRows = images.map((i) => [
    i.os,
    i.version || '—',
    i.sizeBytes ? measure(i.sizeBytes, 'GiB', 2 ** 30) : 'Pending download',
    i.sha256 ? el('code', { className: 'mono' }, i.sha256) : 'Pending verification',
    (i.hosts || []).join(', ') || 'No verified copies',
  ]);
  area.append(
    panel(
      'Base images',
      table(
        ['Operating system', 'Version', 'Size', 'SHA-256', 'Hosts with a copy'],
        imageRows,
        'Image library is empty.',
      ),
    ),
  );
  const profileRows = profiles.map((p) => [
    p.label,
    p.description || '—',
    (p.packages || []).join(', ') || '—',
    p.isDefault ? badge('Default') : '—',
    admin() ? button('Edit', () => profileForm(p), 'link') : '—',
  ]);
  area.append(
    panel(
      'Software profiles',
      table(
        ['Profile', 'Description', 'Packages', 'Provisioning default', 'Action'],
        profileRows,
        'No profiles found.',
      ),
    ),
  );
  if (admin()) setActions(button('New profile', () => profileForm(), 'primary'));
}
function profileForm(profile) {
  const p = profile || {},
    f = el('form', {}),
    key = input({
      value: p.id || '',
      required: true,
      readOnly: !!p.id,
      pattern: '[a-z0-9][a-z0-9\\-]{0,30}',
    }),
    label = input({ value: p.label || '', required: true, readOnly: !!p.builtin }),
    description = input({ value: p.description || '', readOnly: !!p.builtin }),
    timezone = input({ value: p.timezone || '', placeholder: 'Etc/UTC', readOnly: !!p.builtin }),
    packages = el('textarea', { value: (p.packages || []).join('\n'), readOnly: !!p.builtin }),
    runcmd = el('textarea', { value: (p.runcmd || []).join('\n'), readOnly: !!p.builtin }),
    def = input({ type: 'checkbox', checked: !!p.isDefault }),
    fileArea = el('div', {}),
    msg = el('div', { role: 'status' }),
    save = el('button', { type: 'submit', className: 'primary' }, 'Save profile');
  const files = [];
  function fileRow(raw) {
    const path = input({ value: raw.path || '', required: true, placeholder: '/etc/example.conf' }),
      mode = input({ value: raw.permissions || '0644', required: true, pattern: '0[0-7]{3}' }),
      content = el('textarea', { value: raw.content || '', spellcheck: false }),
      rec = { path, mode, content };
    const r = el(
      'div',
      { className: 'file-row' },
      el(
        'div',
        { className: 'fields' },
        field('Guest file path', path),
        field('Permissions', mode),
        field('File content', content, true),
      ),
      row(
        button('Remove file', () => {
          files.splice(files.indexOf(rec), 1);
          r.remove();
        }),
      ),
    );
    files.push(rec);
    fileArea.append(r);
  }
  if (!p.builtin) (p.files || []).forEach(fileRow);
  f.append(
    el(
      'div',
      { className: 'fields' },
      field('Profile ID', key),
      field('Label', label),
      field('Description', description),
      field('Timezone', timezone),
      field('Packages (one per line)', packages),
      field('First-boot commands (one per line)', runcmd),
    ),
    el('label', { className: 'check' }, def, 'Default for new VMs'),
  );
  if (!p.builtin)
    f.append(
      el('h3', {}, 'Guest files'),
      fileArea,
      button('Add file', () => fileRow({})),
    );
  const actions = el('div', { className: 'form-actions' }, save);
  if (p.id && !p.builtin)
    actions.append(
      button(
        'Delete profile',
        () =>
          confirmTyped(
            'Delete profile',
            'Delete ' +
              p.label +
              ' from the software library. Existing guests keep their installed configuration.',
            p.id,
            (confirm) => api('/api/profile/delete', { id: p.id, confirm }),
          ),
        'danger',
      ),
    );
  f.append(actions, msg);
  f.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api('/api/profile', {
        id: key.value,
        label: label.value,
        description: description.value,
        timezone: timezone.value,
        packages: packages.value.split(/[\s,]+/).filter(Boolean),
        runcmd: runcmd.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        files: files.map((x) => ({
          path: x.path.value,
          permissions: x.mode.value,
          content: x.content.value,
        })),
        isDefault: def.checked,
      });
      closeModal();
      await refreshPage();
    } catch (err) {
      msg.replaceChildren(alertBox(err));
    } finally {
      save.disabled = false;
    }
  };
  dialog(p.id ? 'Edit ' + p.label : 'New software profile', f);
}
function pager(offset, count, limit, change) {
  if (offset === 0 && count < limit) return [];
  const prev = button('Previous', () => change(Math.max(0, offset - limit)));
  const next = button('Next', () => change(offset + limit));
  prev.disabled = offset === 0;
  next.disabled = count < limit;
  return [prev, small(count ? offset + 1 + '?' + (offset + count) : 'No more entries'), next];
}
async function jobs(area, token) {
  const body = panel('Operation history'),
    pages = el('div', { className: 'row' });
  area.append(body, pages);
  let offset = 0;
  const load = async () => {
    const list = await api('/api/jobs?' + query({ offset }));
    if (epoch !== token) return;
    body.replaceChildren(
      el('h2', {}, 'Operation history'),
      table(
        ['Operation', 'Host / VM', 'Status', 'Started by', 'Started', 'Finished'],
        list.map((j) => [
          button(j.op, () => jobDetail(j.id), 'link'),
          [j.host, j.name].filter(Boolean).join(' / '),
          badge(j.status),
          j.actor,
          time(j.started),
          j.ended ? time(j.ended) : '—',
        ]),
        'No jobs on this page.',
      ),
    );
    pages.replaceChildren(
      ...pager(offset, list.length, 100, (next) => {
        offset = next;
        return load();
      }),
    );
  };
  setActions(button('Refresh', load));
  await load();
  live(token, load);
}
async function jobDetail(jobId) {
  if (!jobId) throw Error('No job identifier was returned.');
  const body = el('div', { className: 'stack' });
  let timer;
  const token = dialog('Job details', body, () => clearTimeout(timer));
  async function load() {
    try {
      const j = await api('/api/job?' + query({ id: jobId }));
      if (token !== modalEpoch) return;
      body.replaceChildren(
        row(el('strong', {}, j.op), badge(j.status)),
        facts([
          ['Host', j.host],
          ['VM / target', j.name],
          ['Submitted by', j.actor],
          ['Started', time(j.started)],
          ['Finished', j.ended ? time(j.ended) : '—'],
        ]),
        el('h3', {}, 'Execution log'),
        el('pre', {}, (j.log || []).join('\n') || 'Waiting for progress…'),
      );
      if (j.status === 'running') timer = setTimeout(load, 1500);
    } catch (e) {
      if (token === modalEpoch) body.replaceChildren(alertBox(e), button('Retry', load));
    }
  }
  await load();
}
async function audit(area, token) {
  const q = input({ type: 'search', placeholder: 'Actor, action, target or outcome' }),
    csv = el('a', { className: 'btn', href: '/api/audit.csv', download: 'hvdash-audit.csv' }, 'Export CSV'),
    body = el('div', {}),
    bar = el(
      'form',
      { className: 'toolbar' },
      field('Search audit log', q),
      el('button', { type: 'submit' }, 'Search'),
      csv,
    );
  let gen = 0,
    offset = 0;
  const pages = el('div', { className: 'row' });
  const load = async () => {
    const n = ++gen,
      s = query({ q: q.value.trim() });
    csv.href = '/api/audit.csv?' + s;
    const list = await api('/api/audit?' + s + '&offset=' + offset);
    if (epoch !== token || n !== gen) return;
    body.replaceChildren(
      table(
        ['Time', 'Account', 'Action', 'Target', 'Result'],
        list.map((a) => [time(a.at), a.actor, a.action, a.target, a.outcome]),
        'No matching activity.',
      ),
    );
    pages.replaceChildren(
      ...pager(offset, list.length, 200, (next) => {
        offset = next;
        return load();
      }),
    );
  };
  bar.onsubmit = (e) => {
    e.preventDefault();
    offset = 0;
    load().catch(showError);
  };
  area.append(el('div', { className: 'panel' }, bar, body, pages));
  setActions(button('Refresh', load));
  await load();
}
id('dismiss').onclick = closeModal;
id('modal').addEventListener('close', clearModal);
id('change-password').onclick = () => {
  const current = input({type:'password', name:'currentPassword', autocomplete:'current-password', required:true, maxLength:256});
  const next = input({type:'password', name:'newPassword', autocomplete:'new-password', required:true, minLength:14, maxLength:256});
  const confirm = input({type:'password', name:'confirmPassword', autocomplete:'new-password', required:true, minLength:14, maxLength:256});
  const save = el('button', {type:'submit', className:'primary'}, 'Change password');
  const message = el('p', {role:'alert'});
  const form = el('form', {}, field('Current password',current), field('New password (14–256 characters)',next),
    field('Confirm new password',confirm), el('p', {}, 'Changing your password signs you out on all devices.'), message, save);
  form.onsubmit = async event => {
    event.preventDefault();
    if(next.value !== confirm.value){message.textContent='The new passwords do not match.';confirm.focus();return;}
    save.disabled=true;
    try {
      await api('/api/change-password',{currentPassword:current.value,newPassword:next.value});
      form.reset();
      location.replace('/login?changed=1');
    } catch(error){message.textContent=error.message;}
    finally{save.disabled=false;}
  };
  dialog('Change password',form);
  current.focus();
};
id('logout').onclick = async () => {
  try {
    await api('/api/logout', {});
    location.replace('/login');
  } catch (e) {
    showError(e);
  }
};
window.addEventListener('hashchange', () => {
  if (id('modal').open) closeModal();
  refreshPage().catch(showError);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});
async function boot() {
  user = await api('/api/session');
  id('change-password').hidden = !admin();
  id('identity').textContent = user.name;
  id('role').textContent =
    { viewer: 'Read-only', operator: 'Operator', admin: 'Administrator' }[user.role] || user.role;
  if (!canOperate()) document.querySelector('nav a[href="#provision"]').hidden = true;
  if (!admin()) document.querySelector('nav a[href="#audit"]').hidden = true;
  await refreshPage();
  setInterval(tick, 10000);
}
boot().catch((e) => {
  id('content').replaceChildren();
  id('content').setAttribute('aria-busy', 'false');
  showError(e);
});
