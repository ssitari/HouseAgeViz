// ============================================================
//  app.js  —  Visualization engine
//  Settings live in config.js.
// ============================================================

import {
  AGES_FILE, CONGRESS_FILE, FIELDS as F,
  DEFAULT_CONGRESS, DEFAULT_LINE_MODE, DEFAULT_BASELINE, BASELINE_WINDOW,
  PARTY_LINE_MIN, PARTY_AGE_DOMAIN,
  PARTY_COLORS, RANGE_FILL, MIDDLE_FILL, MEDIAN_COLOR,
  SILHOUETTE_FILL, SILHOUETTE_STROKE, SELECTED_COLOR, CAREER_COLOR,
  DOT_GAP, DOT_MIN, HIST_SHARE, HIST_MIN_HEIGHT,
} from './config.js';

// ============================================================
//  STATE
// ============================================================

const state = {
  congress: null,            // the selected Congress number
  lineMode: DEFAULT_LINE_MODE,
  baseline: DEFAULT_BASELINE,
  view: 'chart',
  hovered: null,             // the member dot under the pointer
};

let congresses = [];         // one entry per Congress, ascending
let congressByN = new Map();
let rowsByCongress = new Map();
let rowsByPerson = new Map();
let tallyByCongress = new Map();  // Congress -> Map(age -> count)
let allTally = new Map();
let allCount = 0;
let allMedian = null;
let ageDomain = [];          // contiguous integer ages spanning the whole file
let peakCount = 1;           // tallest column any Congress can need; fixes the count axis
let partySeries = [];

// ============================================================
//  DOM
// ============================================================

const el = {
  main:      document.getElementById('main'),
  line:      document.getElementById('line'),
  lineSvg:   d3.select('#line-svg'),
  hist:      document.getElementById('hist'),
  histSvg:   d3.select('#hist-svg'),
  tableWrap: document.getElementById('table-wrap'),
  table:     document.getElementById('table'),
  tooltip:   document.getElementById('tooltip'),
  loading:   document.getElementById('loading'),
  partyKey:  document.getElementById('party-key'),
  keyNote:   document.getElementById('key-note'),
  readout:   document.getElementById('readout'),
  notes:     document.getElementById('notes'),
  prev:      document.getElementById('prev'),
  next:      document.getElementById('next'),
};

const fmtInt = d3.format(',');
const fmt1 = d3.format('.1f');
const partyColor = id => (PARTY_COLORS.find(p => p.id === id) ?? PARTY_COLORS[5]).color;
const partyLabel = id => (PARTY_COLORS.find(p => p.id === id) ?? { label: id }).label;
const partyRank = id => { const i = PARTY_COLORS.findIndex(p => p.id === id); return i < 0 ? 99 : i; };

/** The source's own label is shown only when it says more than the family does. */
function partyText(d) {
  const family = partyLabel(d.party);
  return d.partyRaw && d.partyRaw !== d.party && d.partyRaw !== 'Democrat'
    ? `${family} (${d.partyRaw})` : family;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Small DOM builder. Text always goes in through textContent. */
function h(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) {
    if (c == null) continue;
    node.append(c);
  }
  return node;
}
const strong = t => h('b', null, String(t));

// ============================================================
//  DATA
// ============================================================

function shape(ageRows, congressRows) {
  const all = ageRows.map(r => ({
    congress: +r[F.congress],
    id:       r[F.id],
    name:     r[F.name],
    state:    r[F.state],
    district: r[F.district],
    party:    r[F.party],
    partyRaw: r[F.partyRaw],
    age:      +r[F.age],
    exact:    +r[F.ageExact],
    // Dated from a birth year or month rather than a full date, so the age
    // could fall one bin either way. Drawn outlined rather than filled.
    approx:   (r[F.precision] || 'day') !== 'day',
  }));

  congresses = congressRows.map(r => ({
    n:        +r[F.congress],
    year:     +r[F.year],
    convened: r[F.convened],
    members:  +r[F.members],
    missing:  +r[F.missing],
    approx:   +r[F.approx],
    youngest: +r[F.youngest],
    q1:       +r[F.q1],
    median:   +r[F.median],
    q3:       +r[F.q3],
    oldest:   +r[F.oldest],
  })).sort((a, b) => a.n - b.n);

  congressByN = new Map(congresses.map(c => [c.n, c]));
  rowsByCongress = d3.group(all, d => d.congress);
  rowsByPerson = d3.group(all, d => d.id);

  ageDomain = d3.range(d3.min(all, d => d.age), d3.max(all, d => d.age) + 1);

  tallyByCongress = new Map();
  for (const [n, rows] of rowsByCongress) {
    tallyByCongress.set(n, d3.rollup(rows, v => v.length, d => d.age));
  }
  allTally = d3.rollup(all, v => v.length, d => d.age);
  allCount = all.length;
  allMedian = d3.median(all, d => d.exact);

  // Party medians, one line per family. A Congress below the minimum is left
  // as a gap rather than bridged.
  partySeries = PARTY_COLORS.filter(p => p.line).map(p => {
    const points = congresses.map(c => {
      const rows = (rowsByCongress.get(c.n) ?? []).filter(d => d.party === p.id);
      return { n: c.n, count: rows.length,
               median: rows.length >= PARTY_LINE_MIN ? d3.median(rows, d => d.exact) : null };
    });
    return { ...p, points };
  });

  // The count axis is the same for every Congress, so the House is seen growing
  // from 66 members to 450 rather than being rescaled to look the same size.
  for (const c of congresses) {
    const b = comparison(c.n, 'all'), p = comparison(c.n, 'prior');
    const rows = rowsByCongress.get(c.n) ?? [];
    for (const a of ageDomain) {
      peakCount = Math.max(peakCount,
        tallyByCongress.get(c.n)?.get(a) ?? 0,
        (b.shares.get(a) ?? 0) * rows.length,
        (p.shares.get(a) ?? 0) * rows.length);
    }
  }

  state.congress = DEFAULT_CONGRESS === 'last' ? congresses[congresses.length - 1].n : +DEFAULT_CONGRESS;
}

const members = () => rowsByCongress.get(state.congress) ?? [];
const current = () => congressByN.get(state.congress);

/**
 * The comparison population, as shares by integer age plus its median.
 *
 * 'all'   — every Congress. One fixed shape, only rescaled.
 * 'prior' — the Congresses just before the selected one, which asks the more
 *           local question: was this House old for its moment?
 */
function comparison(n, mode) {
  if (mode === 'all' || n === congresses[0].n) {
    return { shares: new Map(ageDomain.map(a => [a, (allTally.get(a) ?? 0) / allCount])),
             median: allMedian, label: 'all Congresses', fallback: mode !== 'all' };
  }
  const from = Math.max(congresses[0].n, n - BASELINE_WINDOW);
  const pool = d3.range(from, n).flatMap(m => rowsByCongress.get(m) ?? []);
  const tally = d3.rollup(pool, v => v.length, d => d.age);
  return { shares: new Map(ageDomain.map(a => [a, (tally.get(a) ?? 0) / pool.length])),
           median: d3.median(pool, d => d.exact),
           label: `the ${n - from} before`, fallback: false };
}

// ============================================================
//  LINE CHART
// ============================================================

const LINE_M = { top: 14, right: 104, bottom: 22, left: 50 };
let lineX = n => 0, lineY = a => 0;
let lineOverlay = null;      // the g that selection, crosshair and career repaint into
let dragging = false;        // a drag owns the hit rect, so nothing may redraw it mid-drag
let renderDeferred = false;

function renderLine() {
  const width = el.line.clientWidth, height = el.line.clientHeight;
  if (!width || !height) return;
  const innerW = width - LINE_M.left - LINE_M.right;
  const innerH = height - LINE_M.top - LINE_M.bottom;
  if (innerW <= 0 || innerH <= 0) return;

  const first = congresses[0].n, last = congresses[congresses.length - 1].n;
  const xScale = d3.scaleLinear().domain([first, last]).range([LINE_M.left, LINE_M.left + innerW]);
  // The whole-House axis holds every age anyone reached, so the range band is
  // never clipped. Party medians span far less, and on that axis a real gap
  // between the parties would look like nothing, so that view reads closer in.
  const domain = state.lineMode === 'party' ? PARTY_AGE_DOMAIN
    : [Math.floor(ageDomain[0] / 10) * 10, Math.ceil(ageDomain[ageDomain.length - 1] / 10) * 10];
  const yScale = d3.scaleLinear().domain(domain).range([LINE_M.top + innerH, LINE_M.top]);
  lineX = xScale; lineY = yScale;

  const svg = el.lineSvg.attr('width', width).attr('height', height);
  svg.selectAll('*').remove();

  // A career can leave the closer party axis; it is cut at the plot's edge.
  svg.append('clipPath').attr('id', 'line-clip').append('rect')
    .attr('x', LINE_M.left - 6).attr('y', LINE_M.top)
    .attr('width', innerW + 12).attr('height', innerH);

  // ── Grid ──
  const ticks = yScale.ticks(innerH < 240 ? 5 : 8);
  svg.append('g').selectAll('line').data(ticks).join('line')
    .attr('class', 'rule')
    .attr('x1', LINE_M.left).attr('x2', LINE_M.left + innerW)
    .attr('y1', t => Math.round(yScale(t)) + 0.5).attr('y2', t => Math.round(yScale(t)) + 0.5);
  svg.append('g').selectAll('text').data(ticks).join('text')
    .attr('class', 'tick-label')
    .attr('x', LINE_M.left - 8).attr('y', t => yScale(t))
    .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
    .text(t => t);
  svg.append('text')
    .attr('class', 'axis-title')
    .attr('transform', `translate(16,${LINE_M.top + innerH / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle')
    .text('Age when the Congress convened');

  // ── Year axis ──
  const base = LINE_M.top + innerH;
  svg.append('line').attr('class', 'axis-line')
    .attr('x1', LINE_M.left).attr('x2', LINE_M.left + innerW)
    .attr('y1', Math.round(base) + 0.5).attr('y2', Math.round(base) + 0.5);
  const stride = innerW < 520 ? 40 : 20;
  const labelled = congresses.filter(c => (c.year - 1) % stride === 0);
  svg.append('g').selectAll('text').data(labelled).join('text')
    .attr('class', 'tick-label')
    .attr('x', c => xScale(c.n)).attr('y', base + 15)
    .attr('text-anchor', 'middle')
    .text(c => c.year);
  svg.append('g').selectAll('line').data(labelled).join('line')
    .attr('class', 'tick-mark')
    .attr('x1', c => Math.round(xScale(c.n)) + 0.5).attr('x2', c => Math.round(xScale(c.n)) + 0.5)
    .attr('y1', base).attr('y2', base + 4);

  if (state.lineMode === 'party') drawPartyLines(svg);
  else drawChamberBands(svg);

  // ── Everything that changes without a full redraw ──
  lineOverlay = svg.append('g').attr('class', 'line-overlay').style('pointer-events', 'none');
  paintLineOverlay();

  // ── Hit area: the pointer only has to find an x ──
  const nearest = event => {
    const [mx] = d3.pointer(event, svg.node());
    const n = Math.round(xScale.invert(mx));
    return Math.max(first, Math.min(last, n));
  };
  svg.append('rect')
    .attr('x', LINE_M.left - 6).attr('y', LINE_M.top)
    .attr('width', innerW + 12).attr('height', innerH)
    .attr('fill', 'transparent')
    .style('cursor', 'ew-resize')
    .on('pointerdown', function (event) {
      dragging = true;
      this.setPointerCapture(event.pointerId);
      select(nearest(event));
    })
    .on('pointermove', event => {
      const n = nearest(event);
      if (dragging) select(n);
      paintCrosshair(n);
      showCongressTip(event, n);
    })
    .on('pointerup pointercancel', () => {
      dragging = false;
      if (renderDeferred) { renderDeferred = false; renderAll(); }
    })
    .on('pointerleave', () => { paintCrosshair(null); hideTip(); });
}

function drawChamberBands(svg) {
  const area = (lo, hi) => d3.area()
    .x(c => lineX(c.n)).y0(c => lineY(c[lo])).y1(c => lineY(c[hi]))(congresses);

  svg.append('path').attr('d', area('youngest', 'oldest')).attr('fill', RANGE_FILL);
  svg.append('path').attr('d', area('q1', 'q3')).attr('fill', MIDDLE_FILL);
  svg.append('path')
    .attr('d', d3.line().x(c => lineX(c.n)).y(c => lineY(c.median))(congresses))
    .attr('fill', 'none').attr('stroke', MEDIAN_COLOR).attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round');

  // One series and its bands, so the labels sit on them rather than in a legend.
  const end = congresses[congresses.length - 1];
  const x = lineX(end.n) + 8;
  const labels = [
    { y: lineY(end.oldest), text: 'oldest' },
    { y: lineY((end.q3 + end.median) / 2) - 10, text: 'middle half' },
    { y: lineY(end.median) + 2, text: `median ${fmt1(end.median)}`, strong: true },
    { y: lineY(end.youngest), text: 'youngest' },
  ];
  svg.append('g').selectAll('text').data(labels).join('text')
    .attr('class', d => d.strong ? 'band-label strong' : 'band-label')
    .attr('x', x).attr('y', d => d.y)
    .attr('dominant-baseline', 'middle')
    .text(d => d.text);
}

function drawPartyLines(svg) {
  // The whole House stays as a quiet reference line, so the parties are read
  // against something and not only against each other.
  svg.append('path')
    .attr('d', d3.line().x(c => lineX(c.n)).y(c => lineY(c.median))(congresses))
    .attr('fill', 'none').attr('stroke', '#a8a59d').attr('stroke-width', 1.25);

  const line = d3.line()
    .defined(p => p.median != null)
    .x(p => lineX(p.n)).y(p => lineY(p.median));

  const labels = [];
  for (const s of partySeries) {
    svg.append('path')
      .attr('d', line(s.points))
      .attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2)
      .attr('stroke-linejoin', 'round');
    // A lone Congress between gaps has no segment to draw, so give it a mark.
    const lone = s.points.filter((p, i) => p.median != null &&
      s.points[i - 1]?.median == null && s.points[i + 1]?.median == null);
    svg.append('g').selectAll('circle').data(lone).join('circle')
      .attr('cx', p => lineX(p.n)).attr('cy', p => lineY(p.median))
      .attr('r', 2.5).attr('fill', s.color);
    const defined = s.points.filter(p => p.median != null);
    const lastPoint = defined[defined.length - 1];
    if (lastPoint) labels.push({ s, p: lastPoint, x: lineX(lastPoint.n), y: lineY(lastPoint.median) });
  }

  // Ended parties are labelled above where they stop. The two still running
  // share the right margin, so push them apart if they would collide.
  const lastN = congresses[congresses.length - 1].n;
  const live = labels.filter(l => l.p.n === lastN).sort((a, b) => a.y - b.y);
  for (let i = 1; i < live.length; i++) live[i].y = Math.max(live[i].y, live[i - 1].y + 13);

  // Ended parties can stop close together, as the first two do around 1820. The
  // later one drops below its line instead.
  const ended = labels.filter(l => l.p.n !== lastN).sort((a, b) => a.x - b.x);
  ended.forEach((l, i) => {
    l.dy = -12;
    const prev = ended[i - 1];
    if (prev && l.x - prev.x < 130 && Math.abs(l.y - prev.y) < 26) l.dy = 14;
  });

  svg.append('g').selectAll('text').data(labels).join('text')
    .attr('class', 'annot')
    .attr('x', d => d.p.n === lastN ? d.x + 8 : d.x)
    .attr('y', d => d.p.n === lastN ? d.y : d.y + d.dy)
    .attr('text-anchor', d => d.p.n === lastN ? 'start' : 'middle')
    .attr('dominant-baseline', 'middle')
    .text(d => d.s.label);

  svg.append('text')
    .attr('class', 'tick-label')
    .attr('x', LINE_M.left + 6).attr('y', LINE_M.top + 10)
    .text('Grey line: the whole House');
}

/** Selection rule, and the hovered member's career if there is one. */
function paintLineOverlay() {
  if (!lineOverlay) return;
  lineOverlay.selectAll('*').remove();
  const c = current();
  const top = LINE_M.top, base = lineY.range()[0];
  const x = lineX(c.n);

  lineOverlay.append('line')
    .attr('x1', x).attr('x2', x).attr('y1', top).attr('y2', base)
    .attr('stroke', SELECTED_COLOR).attr('stroke-width', 1);

  // The Congress tag stays inside the plot at both ends of the axis.
  const nearRight = x > lineX.range()[1] - 90;
  lineOverlay.append('text')
    .attr('class', 'annot strong')
    .attr('x', x + (nearRight ? -6 : 6)).attr('y', top + 9)
    .attr('text-anchor', nearRight ? 'end' : 'start')
    .text(`${ordinal(c.n)}, ${c.year}`);

  const yValue = state.hovered ? null : c.median;
  if (yValue != null) {
    lineOverlay.append('circle')
      .attr('cx', x).attr('cy', lineY(yValue)).attr('r', 4.5)
      .attr('fill', '#fff').attr('stroke', SELECTED_COLOR).attr('stroke-width', 2);
  }

  lineOverlay.append('g').attr('class', 'crosshair');
  if (state.hovered) paintCareer(state.hovered);
}

/**
 * A member's age in each Congress they served in, drawn on the same age axis.
 * Breaks where they left and later returned, so a gap reads as a gap.
 */
function paintCareer(d) {
  const rows = (rowsByPerson.get(d.id) ?? []).slice().sort((a, b) => a.congress - b.congress);
  if (!rows.length) return;
  const series = [];
  for (let n = rows[0].congress; n <= rows[rows.length - 1].congress; n++) {
    series.push(rows.find(r => r.congress === n) ?? { congress: n, gap: true });
  }
  const g = lineOverlay.append('g').attr('clip-path', 'url(#line-clip)');
  g.append('path')
    .attr('d', d3.line().defined(r => !r.gap)
      .x(r => lineX(r.congress)).y(r => lineY(r.exact))(series))
    .attr('fill', 'none').attr('stroke', '#fff').attr('stroke-width', 5);
  g.append('path')
    .attr('d', d3.line().defined(r => !r.gap)
      .x(r => lineX(r.congress)).y(r => lineY(r.exact))(series))
    .attr('fill', 'none').attr('stroke', CAREER_COLOR).attr('stroke-width', 2);
  g.selectAll('circle').data(rows).join('circle')
    .attr('cx', r => lineX(r.congress)).attr('cy', r => lineY(r.exact))
    .attr('r', r => r.congress === state.congress ? 4.5 : 2.5)
    .attr('fill', r => r.congress === state.congress ? '#fff' : CAREER_COLOR)
    .attr('stroke', CAREER_COLOR)
    .attr('stroke-width', r => r.congress === state.congress ? 2 : 0);

  const tail = rows[rows.length - 1];
  const tx = lineX(tail.congress), flip = tx > lineX.range()[1] - 220;
  const [yBottom, yTop] = lineY.range();
  lineOverlay.append('text')
    .attr('class', 'annot strong')
    .attr('x', tx + (flip ? -8 : 8))
    .attr('y', Math.max(yTop + 22, Math.min(yBottom - 6, lineY(tail.exact) - 8)))
    .attr('text-anchor', flip ? 'end' : 'start')
    .text(d.name);
}

function paintCrosshair(n) {
  if (!lineOverlay) return;
  const g = lineOverlay.select('.crosshair');
  g.selectAll('*').remove();
  if (n == null || n === state.congress) return;
  const x = lineX(n);
  g.append('line')
    .attr('x1', x).attr('x2', x)
    .attr('y1', LINE_M.top).attr('y2', lineY.range()[0])
    .attr('stroke', '#8a8880').attr('stroke-width', 1);
}

// ============================================================
//  HISTOGRAM
// ============================================================

const HIST_M = { top: 30, right: 24, bottom: 42, left: 50 };

/**
 * The dot grid. It depends on the panel's size and the fixed count axis, never
 * on the Congress, so nothing shifts while scrubbing through time.
 *
 * Each age bin holds k dots per row. One dot per row needs a very tall panel for
 * a column of thirty, so this picks the k that gives the largest dots.
 */
function histLayout(width, maxPlotH) {
  const innerW = width - HIST_M.left - HIST_M.right;
  const stepX = innerW / ageDomain.length;
  let best = null;
  for (let k = 1; k <= 8; k++) {
    const rows = Math.ceil(peakCount / k);
    const cellW = stepX / k;
    const pitch = Math.min(cellW, maxPlotH / rows);
    if (!best || pitch > best.pitch + 1e-6) best = { k, cellW, pitch, rows };
  }
  return { ...best, innerW, stepX, plotH: best.rows * best.pitch };
}

function sizeHist() {
  const available = el.main.clientHeight;
  const width = el.hist.clientWidth || el.main.clientWidth;
  const ceiling = Math.max(HIST_MIN_HEIGHT, available * HIST_SHARE);
  const layout = histLayout(width, ceiling - HIST_M.top - HIST_M.bottom);
  const needed = Math.ceil(layout.plotH + HIST_M.top + HIST_M.bottom);
  el.hist.style.height = `${needed}px`;
  el.tableWrap.style.height = `${needed - 6}px`;
  return layout;
}

let histPaint = () => {};

function renderHist() {
  if (state.view !== 'chart') return;
  const width = el.hist.clientWidth;
  if (!width) return;
  const L = sizeHist();
  const baseline = HIST_M.top + L.plotH;
  const height = baseline + HIST_M.bottom;

  const left = HIST_M.left;
  const binLeft = a => left + (a - ageDomain[0]) * L.stepX;
  // A continuous axis: the bin labelled a runs from exactly a up to a + 1, so the
  // ticks, the dots and the median lines all agree on where an age falls.
  const xExact = v => left + (v - ageDomain[0]) * L.stepX;
  const unitY = L.pitch / L.k;     // pixels per member
  const yOf = v => baseline - v * unitY;

  const svg = el.histSvg.attr('width', width).attr('height', height);
  svg.selectAll('*').remove();

  const rows = members();
  const base = comparison(state.congress, state.baseline);

  // ── Count rules ──
  const ticks = d3.ticks(0, peakCount, Math.max(2, Math.min(4, Math.floor(L.plotH / 34)))).filter(t => t > 0);
  svg.append('g').selectAll('line').data(ticks).join('line')
    .attr('class', 'rule')
    .attr('x1', left).attr('x2', left + L.innerW)
    .attr('y1', t => Math.round(yOf(t)) + 0.5).attr('y2', t => Math.round(yOf(t)) + 0.5);
  svg.append('g').selectAll('text').data(ticks).join('text')
    .attr('class', 'tick-label')
    .attr('x', left - 8).attr('y', t => yOf(t))
    .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
    .text(t => t);

  // ── Silhouette: the same number of members, aged as the comparison was ──
  const pts = [];
  for (const a of ageDomain) {
    const y = yOf((base.shares.get(a) ?? 0) * rows.length);
    pts.push([binLeft(a), y], [binLeft(a) + L.stepX, y]);
  }
  svg.append('path')
    .attr('d', d3.line()(pts) + `L${left + L.innerW},${baseline}L${left},${baseline}Z`)
    .attr('fill', SILHOUETTE_FILL)
    .attr('stroke', SILHOUETTE_STROKE)
    .attr('stroke-linejoin', 'round');

  // ── Axes ──
  svg.append('line').attr('class', 'axis-line')
    .attr('x1', left).attr('x2', left + L.innerW)
    .attr('y1', Math.round(baseline) + 0.5).attr('y2', Math.round(baseline) + 0.5);
  const stride = L.stepX < 8 ? 10 : 5;
  const labelled = ageDomain.filter(a => a % stride === 0);
  svg.append('g').selectAll('line').data(labelled).join('line')
    .attr('class', 'tick-mark')
    .attr('x1', a => Math.round(binLeft(a)) + 0.5)
    .attr('x2', a => Math.round(binLeft(a)) + 0.5)
    .attr('y1', baseline).attr('y2', baseline + 5);
  svg.append('g').selectAll('text').data(labelled).join('text')
    .attr('class', 'tick-label')
    .attr('x', a => binLeft(a)).attr('y', baseline + 17)
    .attr('text-anchor', 'middle')
    .text(a => a);
  svg.append('text').attr('class', 'axis-title')
    .attr('x', left + L.innerW / 2).attr('y', baseline + 34)
    .attr('text-anchor', 'middle')
    .text('Age in years when the Congress convened');
  svg.append('text').attr('class', 'axis-title')
    .attr('transform', `translate(16,${baseline - L.plotH / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle')
    .text('Members');

  // ── Dots: party-blocked within each column, then by exact age ──
  const dots = [];
  for (const [age, group] of d3.group(rows, d => d.age)) {
    group.slice().sort((a, b) => partyRank(a.party) - partyRank(b.party) || a.exact - b.exact)
      .forEach((d, i) => dots.push({ d, age, slot: i }));
  }
  const size = Math.max(Math.min(L.pitch, L.cellW) - DOT_GAP, DOT_MIN);
  const r = size / 2;
  const ringW = Math.min(1.6, Math.max(0.8, r * 0.34));
  const cx = o => binLeft(o.age) + ((o.slot % L.k) + 0.5) * L.cellW;
  const cy = o => baseline - (Math.floor(o.slot / L.k) + 0.5) * L.pitch;

  const dotSel = svg.append('g').selectAll('circle').data(dots).join('circle')
    .attr('cx', cx).attr('cy', cy)
    .attr('r', o => o.d.approx ? Math.max(0.5, r - ringW / 2) : r)
    .attr('fill', o => o.d.approx ? 'none' : partyColor(o.d.party))
    .attr('stroke', o => o.d.approx ? partyColor(o.d.party) : 'none')
    .attr('stroke-width', o => o.d.approx ? ringW : 0);

  // ── Medians, this Congress and its comparison ──
  const med = current().median;
  const near = Math.abs(med - base.median) * L.stepX < 150;
  const medianLine = (value, label, dash, row, leftward) => {
    const px = xExact(value);
    svg.append('line')
      .attr('x1', px).attr('x2', px)
      .attr('y1', baseline).attr('y2', HIST_M.top - (row === 0 ? 2 : -10))
      .attr('stroke', dash ? '#8a8880' : '#333')
      .attr('stroke-width', dash ? 1.25 : 1.75)
      .attr('stroke-dasharray', dash ? '3 3' : null);
    svg.append('text')
      .attr('class', dash ? 'annot' : 'annot strong')
      .attr('x', px + (leftward ? -5 : 5))
      .attr('y', HIST_M.top - 8 + row * 14)
      .attr('text-anchor', leftward ? 'end' : 'start')
      .text(label);
  };
  medianLine(base.median, `${base.label}, median ${fmt1(base.median)}`, true, near ? 1 : 0,
    near && base.median <= med);
  medianLine(med, `${ordinal(state.congress)} Congress, median ${fmt1(med)}`, false, 0,
    med <= base.median && near);

  // ── Picking: dots sit on a grid, so the one under the pointer is computed ──
  const bySlot = new Map(dots.map(o => [`${o.age}|${o.slot}`, o]));
  const at = (mx, my) => {
    const age = ageDomain[0] + Math.floor((mx - left) / L.stepX);
    if (age < ageDomain[0] || age > ageDomain[ageDomain.length - 1]) return null;
    const col = Math.floor((mx - binLeft(age)) / L.cellW);
    const row = Math.floor((baseline - my) / L.pitch);
    if (col < 0 || col >= L.k || row < 0) return null;
    return bySlot.get(`${age}|${row * L.k + col}`) ?? null;
  };

  const ring = svg.append('circle').attr('class', 'dot-ring')
    .attr('r', Math.max(r + 1.5, 5)).attr('stroke', SELECTED_COLOR)
    .style('pointer-events', 'none').style('display', 'none');

  histPaint = () => {
    const hov = state.hovered;
    const hit = hov ? dots.find(o => o.d.id === hov.id) : null;
    ring.style('display', hit ? null : 'none');
    if (hit) ring.attr('cx', cx(hit)).attr('cy', cy(hit));
    dotSel.attr('opacity', o => !hov || o.d.id === hov.id ? 1 : 0.5);
  };

  svg.append('rect')
    .attr('x', left).attr('y', HIST_M.top)
    .attr('width', L.innerW).attr('height', L.plotH)
    .attr('fill', 'transparent')
    .style('cursor', 'crosshair')
    .on('pointerdown pointermove', event => {   // a tap has no move, so take both
      const [mx, my] = d3.pointer(event, svg.node());
      const o = at(mx, my);
      setHover(o ? o.d : null);
      if (o) showMemberTip(event, o.d); else hideTip();
    })
    .on('pointerleave', () => { setHover(null); hideTip(); });

  histPaint();
}

// ============================================================
//  TABLE
// ============================================================

function renderTable() {
  const rows = members().slice().sort((a, b) => b.exact - a.exact || d3.ascending(a.name, b.name));
  const thead = h('thead');
  const headRow = h('tr');
  for (const [label, num] of [['Member'], ['State'], ['District'], ['Party'], ['Age', true]]) {
    headRow.append(h('th', num ? 'num' : null, label));
  }
  thead.append(headRow);

  const tbody = h('tbody');
  for (const d of rows) {
    const swatch = h('span', 'swatch');
    swatch.style.background = partyColor(d.party);
    const tr = h('tr');
    tr.append(
      h('td', null, swatch, d.name),
      h('td', null, d.state),
      h('td', null, d.district === '0' ? 'at large' : d.district === '-1' ? '' : d.district),
      h('td', null, partyText(d)),
      h('td', 'num', d.approx ? `about ${d.age}` : String(d.age)),
    );
    tbody.append(tr);
  }
  el.table.replaceChildren(thead, tbody);
}

// ============================================================
//  TOOLTIPS / HOVER
// ============================================================

function setHover(d) {
  if ((state.hovered?.id ?? null) === (d?.id ?? null)) return;
  state.hovered = d;
  histPaint();
  paintLineOverlay();
}

function showCongressTip(event, n) {
  const c = congressByN.get(n);
  const rows = rowsByCongress.get(n) ?? [];
  const oldest = d3.greatest(rows, d => d.exact);
  const youngest = d3.least(rows, d => d.exact);
  const stat = (value, label) => h('div', 'tt-stat', strong(value), ` ${label}`);

  const body = [
    h('div', 'tt-name', `${ordinal(c.n)} Congress, ${c.year}`),
    h('div', 'tt-sub', `${fmtInt(c.members)} members served`),
  ];
  if (state.lineMode === 'party') {
    body.push(stat(fmt1(c.median), 'whole House median'));
    for (const s of partySeries) {
      const p = s.points.find(q => q.n === n);
      if (p?.median != null) body.push(stat(fmt1(p.median), `${s.label} (${p.count})`));
    }
  } else {
    body.push(
      stat(fmt1(c.median), 'median age'),
      stat(`${fmt1(c.q1)}–${fmt1(c.q3)}`, 'middle half'),
      stat(fmt1(c.oldest), `oldest, ${oldest.name}`),
      stat(fmt1(c.youngest), `youngest, ${youngest.name}`),
    );
  }
  if (n !== state.congress) body.push(h('div', 'tt-meta', 'Click to see its members below'));
  placeTip(event, body);
}

function showMemberTip(event, d) {
  const c = current();
  const career = rowsByPerson.get(d.id) ?? [];
  const swatch = h('span', 'swatch');
  swatch.style.background = partyColor(d.party);
  const place = d.district === '0' ? `${d.state} at large` : d.district && d.district !== '-1' ? `${d.state}-${d.district}` : d.state;

  const body = [
    h('div', 'tt-name', swatch, d.name),
    h('div', 'tt-sub', `${partyText(d)} · ${place}`),
    h('div', 'tt-stat', d.approx ? 'About ' : 'Age ', strong(d.age), ` when the ${ordinal(d.congress)} convened`),
  ];
  if (career.length > 1) {
    const ages = d3.extent(career, r => r.age);
    body.push(h('div', 'tt-stat', 'Served in ', strong(career.length),
      ` Congresses, ages ${ages[0]}–${ages[1]}`));
  }
  body.push(h('div', 'tt-meta', d.approx
    ? 'Birth year or month known, full date not, so this age may be a year off.'
    : `Convened ${c.convened}. Career drawn on the line chart.`));
  placeTip(event, body);
}

function placeTip(event, children) {
  const tip = el.tooltip;
  tip.replaceChildren(...children);
  tip.style.display = 'block';
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  let x = event.clientX + 14, y = event.clientY + 14;
  if (x + w > window.innerWidth - 8) x = event.clientX - w - 14;
  if (y + ht > window.innerHeight - 8) y = event.clientY - ht - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

const hideTip = () => { el.tooltip.style.display = 'none'; };

// ============================================================
//  READOUT / NOTES / KEY
// ============================================================

function renderReadout() {
  const c = current();
  const rows = members();
  const oldest = d3.greatest(rows, d => d.exact);
  const youngest = d3.least(rows, d => d.exact);
  el.readout.replaceChildren(
    strong(`${ordinal(c.n)} Congress`), ` (${c.year}) · `,
    strong(fmtInt(c.members)), ' members served · median age ', strong(fmt1(c.median)),
    ` · youngest ${youngest.name}, ${youngest.age} · oldest ${oldest.name}, ${oldest.age}`,
  );
  el.prev.disabled = c.n === congresses[0].n;
  el.next.disabled = c.n === congresses[congresses.length - 1].n;
}

/** Caveats for the selected Congress, and only when they apply. */
function renderNotes() {
  const c = current();
  const out = [];
  if (c.missing) {
    out.push(h('p', 'note warn',
      `${c.missing} of ${fmtInt(c.members)} members have no known birth date, so they cannot be placed on an age axis and are not drawn.`));
  }
  if (c.approx && state.view === 'chart') {
    out.push(h('p', 'note',
      `${c.approx} are outlined: their ages come from a birth year or month, not a full date, and may be a year off.`));
  }
  const base = comparison(state.congress, state.baseline);
  if (base.fallback) {
    out.push(h('p', 'note', 'Nothing comes before the 1st Congress, so it is compared with all Congresses.'));
  }
  el.notes.replaceChildren(...out);
}

function renderKey() {
  const present = new Set(members().map(d => d.party));
  const items = PARTY_COLORS.map(p => {
    const swatch = h('span', 'swatch');
    swatch.style.background = p.color;
    return h('div', present.has(p.id) ? 'key-item' : 'key-item is-out', swatch, p.label);
  });
  el.partyKey.replaceChildren(...items);
  el.keyNote.textContent = state.view === 'chart'
    ? 'Grey shape: this many members, aged as the comparison was.' : '';
}

// ============================================================
//  WIRING
// ============================================================

function select(n) {
  if (n === state.congress) return;
  state.congress = n;
  state.hovered = null;
  redrawSelection();
}

/** Everything that depends on the selected Congress. The line chart keeps its bands. */
function redrawSelection() {
  renderReadout();
  renderNotes();
  renderKey();
  renderHist();
  if (state.view === 'table') renderTable();
  paintLineOverlay();
}

function setView(v) {
  state.view = v;
  document.body.classList.toggle('table-view', v === 'table');
  el.hist.style.display = v === 'chart' ? '' : 'none';
  el.tableWrap.style.display = v === 'table' ? 'block' : 'none';
  redrawSelection();
  renderLine();
}

function step(delta) {
  const first = congresses[0].n, last = congresses[congresses.length - 1].n;
  select(Math.max(first, Math.min(last, state.congress + delta)));
}

function wire() {
  d3.select('#line-mode').property('value', state.lineMode).on('change', function () {
    hideTip(); state.lineMode = this.value; renderLine();
  });
  d3.select('#baseline').property('value', state.baseline).on('change', function () {
    hideTip(); state.baseline = this.value; redrawSelection();
  });
  d3.select('#view').property('value', state.view).on('change', function () {
    hideTip(); setView(this.value);
  });

  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));
  el.line.addEventListener('keydown', event => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves)) return;
    event.preventDefault();
    step(moves[event.key]);
  });

  // Watch the line panel too: a readout that wraps on a phone changes its height
  // without changing the height of the whole page.
  let pending;
  const observer = new ResizeObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(renderAll, 80);
  });
  observer.observe(el.main);
  observer.observe(el.line);
}

function renderAll() {
  // Redrawing would remove the rect holding the pointer capture and end the drag.
  if (dragging) { renderDeferred = true; return; }
  // Size the histogram first: the line chart takes whatever height is left.
  sizeHist();
  renderHist();
  renderLine();
}

// ============================================================
//  BOOT
// ============================================================

Promise.all([d3.csv(AGES_FILE), d3.csv(CONGRESS_FILE)])
  .then(([ageRows, congressRows]) => {
    shape(ageRows, congressRows);
    el.loading.style.display = 'none';
    wire();
    renderReadout();
    renderNotes();
    renderKey();
    renderAll();
  })
  .catch(err => {
    console.error(err);
    el.loading.className = 'err';
    el.loading.textContent =
      `Could not load ${AGES_FILE}. This page uses ES modules and fetch, so it has to be ` +
      `served over HTTP: run "python3 -m http.server 8000" in this folder and open ` +
      `http://localhost:8000. Run build_house_ages.py first if the CSVs are missing.`;
  });
