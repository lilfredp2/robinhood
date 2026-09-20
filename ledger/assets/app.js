/* Ledger — static portfolio dashboard.
   Reads data/portfolio.json and renders the tiles, charts and holdings table. */

const SVG_NS = 'http://www.w3.org/2000/svg';

const fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtMoney2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

const pct = (v, digits = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* Round a range out to a "nice" step (1, 2, 2.5 or 5 x 10^n) so tick labels are evenly spaced. */
function niceTicks(min, max, target = 5) {
  const span = max - min || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(m => raw <= m * mag) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, step, ticks };
}

/* ── Theme ─────────────────────────────────────────────────────────────── */
const THEMES = ['auto', 'light', 'dark'];
const LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

function readStoredTheme() {
  try { return localStorage.getItem('ledger-theme'); } catch { return null; }
}
function storeTheme(value) {
  try { localStorage.setItem('ledger-theme', value); } catch { /* private mode, blocked storage */ }
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('theme-label');
  if (label) label.textContent = LABELS[theme];
  document.dispatchEvent(new CustomEvent('themechange'));
}

function initTheme() {
  const stored = readStoredTheme();
  let current = THEMES.includes(stored) ? stored : 'auto';
  applyTheme(current);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    current = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    storeTheme(current);
    applyTheme(current);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current === 'auto') document.dispatchEvent(new CustomEvent('themechange'));
  });
}

/* ── Tooltip ───────────────────────────────────────────────────────────── */
function makeTooltip(host) {
  const tip = el('div', { class: 'tooltip', role: 'status', 'aria-live': 'polite' });
  host.appendChild(tip);
  return {
    node: tip,
    show(html, x, y) {
      tip.innerHTML = html;
      tip.setAttribute('data-show', 'true');
      const w = tip.offsetWidth;
      const left = Math.min(Math.max(x - w / 2, 4), host.clientWidth - w - 4);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(y - tip.offsetHeight - 14, 0)}px`;
    },
    hide() { tip.setAttribute('data-show', 'false'); }
  };
}

/* ── Hero + tiles ──────────────────────────────────────────────────────── */
function renderSummary(data) {
  const { account, history } = data;
  const first = history[0];
  const last = history[history.length - 1];
  const prev = history[history.length - 2] ?? first;

  const periodPct = (last.value / first.value - 1) * 100;
  const dayGain = last.value - prev.value;
  const dayPct = (last.value / prev.value - 1) * 100;

  document.getElementById('hero-value').textContent = fmtMoney2.format(account.total);
  const delta = document.getElementById('hero-delta');
  delta.className = `hero-delta delta ${periodPct >= 0 ? 'up' : 'down'}`;
  delta.innerHTML = `<span class="arrow" aria-hidden="true">${periodPct >= 0 ? '▲' : '▼'}</span>${pct(periodPct)} over the period shown`;
  document.getElementById('hero-foot').textContent =
    `${history.length} trading days through ${fmtDate.format(new Date(`${last.date}T00:00:00Z`))}`;

  const tiles = [
    { label: 'Equity', value: fmtMoney.format(account.equity), note: `${data.holdings.length} positions` },
    { label: 'Cash', value: fmtMoney.format(account.cash), note: `${fmtMoney.format(account.buyingPower)} buying power` },
    {
      label: "Today's change", value: fmtMoney.format(dayGain),
      note: `${dayPct >= 0 ? '▲' : '▼'} ${pct(dayPct)}`,
      noteClass: dayPct >= 0 ? 'up' : 'down'
    },
    {
      label: 'Unrealized gain', value: fmtMoney.format(data.holdings.reduce((s, h) => s + h.gain, 0)),
      note: `${pct((data.holdings.reduce((s, h) => s + h.gain, 0) / data.holdings.reduce((s, h) => s + h.costBasis, 0)) * 100)} on cost`,
      noteClass: 'up'
    }
  ];

  const host = document.getElementById('tiles');
  host.replaceChildren(...tiles.map(t => {
    const tile = el('div', { class: 'tile' });
    tile.append(
      el('p', { class: 'tile-label' }, t.label),
      el('p', { class: 'tile-value' }, t.value),
      el('p', { class: `tile-note ${t.noteClass ? `delta ${t.noteClass}` : ''}` }, t.note)
    );
    return tile;
  }));

  document.getElementById('disclaimer').textContent = data.disclaimer;
}

/* ── Performance chart ─────────────────────────────────────────────────── */
const SERIES = [
  { key: 'value', name: 'Portfolio', color: '--series-1' },
  { key: 'benchmark', name: 'Benchmark (S&P 500)', color: '--series-2' }
];

function renderLegend(host) {
  host.replaceChildren(...SERIES.map(s => {
    const item = el('span', { class: 'legend-item' });
    const sw = el('span', { class: 'legend-swatch' });
    sw.style.background = css(s.color);
    item.append(sw, document.createTextNode(s.name));
    return item;
  }));
}

function drawPerformance(history, host, tip) {
  const W = host.clientWidth || 800;
  const H = W < 560 ? 250 : 330;
  const pad = { top: 18, right: W < 560 ? 46 : 78, bottom: 30, left: 46 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  // Index both series to 100 at the start of the range so one y-axis serves both.
  const base = { value: history[0].value, benchmark: history[0].benchmark };
  const pts = history.map(d => ({
    date: d.date,
    raw: d.value,
    value: (d.value / base.value) * 100,
    benchmark: (d.benchmark / base.benchmark) * 100
  }));

  const all = pts.flatMap(p => [p.value, p.benchmark]);
  const dataLo = Math.min(...all), dataHi = Math.max(...all);
  const padY = (dataHi - dataLo) * 0.1 || 1;
  const scaleY = niceTicks(dataLo - padY, dataHi + padY);
  const yMin = scaleY.lo, yMax = scaleY.hi;

  const x = i => pad.left + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = v => pad.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img',
    'aria-label': `Line chart comparing portfolio value against the benchmark over ${pts.length} trading days, both indexed to 100 at the start.`
  });

  // Gridlines + y labels
  for (const v of scaleY.ticks) {
    const yy = y(v);
    svg.append(
      svgEl('line', { class: 'grid-line', x1: pad.left, x2: pad.left + iw, y1: yy, y2: yy }),
      svgEl('text', { class: 'axis-text', x: pad.left - 9, y: yy + 4, 'text-anchor': 'end' }, fmtNum.format(v))
    );
  }

  // X labels: first of each month
  let lastMonth = null;
  pts.forEach((p, i) => {
    const month = p.date.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      if (i > 2 && i < pts.length - 2) {
        svg.append(svgEl('text', {
          class: 'axis-text', x: x(i), y: pad.top + ih + 19, 'text-anchor': 'middle'
        }, fmtMonth.format(new Date(`${p.date}T00:00:00Z`))));
      }
    }
  });
  svg.append(svgEl('line', { class: 'axis-line', x1: pad.left, x2: pad.left + iw, y1: pad.top + ih, y2: pad.top + ih }));

  // Area under the portfolio line, then both lines
  const path = key => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ');
  const area = `${path('value')} L${x(pts.length - 1).toFixed(2)},${(pad.top + ih).toFixed(2)} L${x(0).toFixed(2)},${(pad.top + ih).toFixed(2)} Z`;
  svg.append(svgEl('path', { class: 'series-area', d: area, fill: css('--series-1-soft') }));
  for (const s of [...SERIES].reverse()) {
    svg.append(svgEl('path', { class: 'series-line', d: path(s.key), stroke: css(s.color) }));
  }

  // Direct end labels (two series — labeled rather than legend-only)
  if (pad.right > 60) {
    for (const s of SERIES) {
      const v = pts[pts.length - 1][s.key];
      svg.append(svgEl('text', {
        class: 'point-label', x: pad.left + iw + 9, y: y(v) + 4, fill: css(s.color)
      }, fmtNum.format(Math.round(v))));
    }
  }

  // Hover layer
  const cross = svgEl('line', { class: 'crosshair', y1: pad.top, y2: pad.top + ih, opacity: 0 });
  const dots = SERIES.map(s => svgEl('circle', { class: 'hover-dot', r: 5, fill: css(s.color), opacity: 0 }));
  svg.append(cross, ...dots);

  const overlay = svgEl('rect', {
    x: pad.left, y: pad.top, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair'
  });
  svg.append(overlay);

  const at = (clientX) => {
    const box = svg.getBoundingClientRect();
    const rel = ((clientX - box.left) / box.width) * W;
    const i = Math.round(((rel - pad.left) / iw) * (pts.length - 1));
    return Math.min(Math.max(i, 0), pts.length - 1);
  };

  const move = ev => {
    const i = at(ev.clientX);
    const p = pts[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
    SERIES.forEach((s, n) => {
      dots[n].setAttribute('cx', x(i)); dots[n].setAttribute('cy', y(p[s.key])); dots[n].setAttribute('opacity', 1);
    });
    const rows = SERIES.map(s => `
      <div class="tt-row">
        <span class="tt-key"><span class="legend-swatch" style="background:${css(s.color)}"></span>${s.name}</span>
        <span class="tt-val">${fmtNum.format(p[s.key].toFixed(1))}</span>
      </div>`).join('');
    const scale = host.clientWidth / W;
    tip.show(
      `<div class="tt-title">${fmtDate.format(new Date(`${p.date}T00:00:00Z`))}</div>${rows}
       <div class="tt-row"><span class="tt-key">Value</span><span class="tt-val">${fmtMoney.format(p.raw)}</span></div>`,
      x(i) * scale, y(Math.max(p.value, p.benchmark)) * scale
    );
  };
  const leave = () => {
    cross.setAttribute('opacity', 0);
    dots.forEach(d => d.setAttribute('opacity', 0));
    tip.hide();
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerleave', leave);

  host.querySelector('svg')?.remove();
  host.prepend(svg);

  document.getElementById('perf-cap').textContent =
    `${pts.length} trading days, ${fmtDate.format(new Date(`${pts[0].date}T00:00:00Z`))} to ${fmtDate.format(new Date(`${pts[pts.length - 1].date}T00:00:00Z`))}. Hover the plot for a day's values.`;

  return pts;
}

function renderPerfTable(pts) {
  const table = document.getElementById('perf-table');
  const head = el('thead');
  const hr = el('tr');
  hr.append(el('th', { scope: 'col' }, 'Month'), el('th', { scope: 'col' }, 'Portfolio'), el('th', { scope: 'col' }, 'Benchmark'));
  head.append(hr);

  const body = el('tbody');
  let lastMonth = null;
  for (const p of pts) {
    const m = p.date.slice(0, 7);
    if (m === lastMonth) continue;
    lastMonth = m;
    const tr = el('tr');
    tr.append(
      el('th', { scope: 'row' }, fmtMonth.format(new Date(`${p.date}T00:00:00Z`))),
      el('td', {}, fmtNum.format(p.value.toFixed(1))),
      el('td', {}, fmtNum.format(p.benchmark.toFixed(1)))
    );
    body.append(tr);
  }
  const caption = table.querySelector('caption');
  table.replaceChildren(...(caption ? [caption] : []), head, body);
}

/* ── Allocation chart ──────────────────────────────────────────────────── */
function drawAllocation(holdings, host, tip) {
  const bySector = new Map();
  for (const h of holdings) bySector.set(h.sector, (bySector.get(h.sector) ?? 0) + h.marketValue);
  const rows = [...bySector.entries()]
    .map(([sector, value]) => ({ sector, value }))
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);

  const W = host.clientWidth || 800;
  const labelW = W < 560 ? 92 : 128;
  const rowH = 34, gap = 10;
  const H = rows.length * (rowH + gap) + 12;
  const trackW = W - labelW - 66;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Bar chart of equity allocation by sector: ${rows.map(r => `${r.sector} ${((r.value / total) * 100).toFixed(1)} percent`).join(', ')}.`
  });

  const max = rows[0].value;
  // Single hue: the bars encode one measure, identity comes from the row label.
  const fill = css('--seq-450');

  rows.forEach((r, i) => {
    const yTop = i * (rowH + gap) + 6;
    const w = Math.max((r.value / max) * trackW, 3);
    const share = (r.value / total) * 100;

    svg.append(svgEl('text', {
      class: 'bar-name', x: labelW - 12, y: yTop + rowH / 2 + 4, 'text-anchor': 'end'
    }, r.sector));

    const hit = svgEl('rect', {
      class: 'bar-hit', x: labelW, y: yTop, width: Math.max(w, 24), height: rowH,
      fill: 'transparent', tabindex: '0', role: 'img',
      'aria-label': `${r.sector}: ${fmtMoney.format(r.value)}, ${share.toFixed(1)} percent of equity`
    });
    const bar = svgEl('rect', {
      class: 'bar-rect', x: labelW, y: yTop + 5, width: w, height: rowH - 10,
      rx: 4, fill, 'pointer-events': 'none'
    });
    svg.append(hit, bar);

    svg.append(svgEl('text', {
      class: 'bar-label', x: labelW + w + 10, y: yTop + rowH / 2 + 4
    }, `${share.toFixed(1)}%`));

    const scale = host.clientWidth / W;
    const show = () => tip.show(
      `<div class="tt-title">${r.sector}</div>
       <div class="tt-row"><span class="tt-key">Market value</span><span class="tt-val">${fmtMoney.format(r.value)}</span></div>
       <div class="tt-row"><span class="tt-key">Share</span><span class="tt-val">${share.toFixed(1)}%</span></div>`,
      (labelW + w / 2) * scale, (yTop + 4) * scale
    );
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => tip.hide());
    hit.addEventListener('blur', () => tip.hide());
  });

  host.querySelector('svg')?.remove();
  host.prepend(svg);
}

/* ── Holdings table ────────────────────────────────────────────────────── */
const COLUMNS = [
  { key: 'symbol', label: 'Position', type: 'text' },
  { key: 'sector', label: 'Sector', type: 'text' },
  { key: 'shares', label: 'Shares', type: 'num', fmt: v => fmtNum.format(v) },
  { key: 'price', label: 'Price', type: 'num', fmt: v => fmtMoney2.format(v) },
  { key: 'dayPct', label: 'Day', type: 'num', delta: true },
  { key: 'marketValue', label: 'Market value', type: 'num', fmt: v => fmtMoney.format(v) },
  { key: 'gain', label: 'Unrealized', type: 'num', fmt: v => fmtMoney.format(v), signed: true },
  { key: 'gainPct', label: 'Return', type: 'num', delta: true }
];

function renderHoldings(holdings, sortKey = 'marketValue', dir = -1) {
  const table = document.getElementById('holdings-table');
  const col = COLUMNS.find(c => c.key === sortKey);
  const rows = [...holdings].sort((a, b) =>
    col.type === 'num' ? (a[sortKey] - b[sortKey]) * dir : String(a[sortKey]).localeCompare(String(b[sortKey])) * dir
  );

  const head = el('thead');
  const hr = el('tr');
  for (const c of COLUMNS) {
    const th = el('th', { scope: 'col', class: 'sortable', tabindex: '0', role: 'columnheader' });
    th.append(document.createTextNode(c.label));
    if (c.key === sortKey) {
      th.setAttribute('aria-sort', dir === -1 ? 'descending' : 'ascending');
      th.append(el('span', { class: 'sort-caret', 'aria-hidden': 'true' }, dir === -1 ? '▼' : '▲'));
    }
    const resort = () => renderHoldings(holdings, c.key, c.key === sortKey ? -dir : (c.type === 'num' ? -1 : 1));
    th.addEventListener('click', resort);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resort(); } });
    hr.append(th);
  }
  head.append(hr);

  const body = el('tbody');
  for (const h of rows) {
    const tr = el('tr');
    for (const c of COLUMNS) {
      if (c.key === 'symbol') {
        const th = el('th', { scope: 'row' });
        const sym = el('span', { class: 'sym' }, h.symbol);
        sym.append(el('span', { class: 'sym-name' }, h.name));
        th.append(sym);
        tr.append(th);
        continue;
      }
      const td = el('td');
      const v = h[c.key];
      if (c.delta) {
        td.className = `delta ${v >= 0 ? 'up' : 'down'}`;
        td.append(el('span', { class: 'arrow', 'aria-hidden': 'true' }, v >= 0 ? '▲' : '▼'), document.createTextNode(pct(v)));
      } else if (c.signed) {
        td.className = `delta ${v >= 0 ? 'up' : 'down'}`;
        td.textContent = `${v >= 0 ? '+' : '−'}${c.fmt(Math.abs(v))}`;
      } else {
        td.textContent = c.fmt ? c.fmt(v) : v;
      }
      tr.append(td);
    }
    body.append(tr);
  }

  const caption = table.querySelector('caption');
  table.replaceChildren(...(caption ? [caption] : []), head, body);
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
async function main() {
  initTheme();

  let data;
  try {
    const res = await fetch('data/portfolio.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    document.getElementById('dashboard').insertAdjacentHTML('afterbegin',
      `<div class="wrap"><div class="card"><p><strong>Could not load portfolio data.</strong> ${String(err.message)}. Serve this page over HTTP (for example <code>python3 -m http.server</code>) rather than opening the file directly.</p></div></div>`);
    return;
  }

  renderSummary(data);
  renderHoldings(data.holdings);

  const perfHost = document.getElementById('perf-chart');
  const allocHost = document.getElementById('alloc-chart');
  const perfTip = makeTooltip(perfHost);
  const allocTip = makeTooltip(allocHost);

  let range = 0; // 0 = all
  const slice = () => (range ? data.history.slice(-range) : data.history);

  const draw = () => {
    renderLegend(document.getElementById('perf-legend'));
    const pts = drawPerformance(slice(), perfHost, perfTip);
    renderPerfTable(pts);
    drawAllocation(data.holdings, allocHost, allocTip);
  };
  draw();

  for (const btn of document.querySelectorAll('.filters button')) {
    btn.addEventListener('click', () => {
      range = Number(btn.dataset.range);
      for (const b of document.querySelectorAll('.filters button')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      draw();
    });
  }

  document.addEventListener('themechange', draw);

  let frame;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }).observe(perfHost);
}

main();
