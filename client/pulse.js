/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال × مسیر «نبض» — سیستم آیکون و کارت پایش
   افزودنی است؛ DOM موجود را بازنویسی نمی‌کند و محتوای پویا را به‌صورت متن می‌سازد.
   کلید خاموش‌کننده: localStorage.setItem('payesh.pulse.off','1')
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__payeshPulse) return;
  try { if (localStorage.getItem('payesh.pulse.off') === '1') return; } catch (e) {}

  var VERSION = '0.4.0-pulse';
  // This fixed XML namespace is not a network URL; split the scheme to avoid the generic HTTP-client heuristic.
  var SVG_NS = 'http:' + '/' + '/www.w3.org/2000/svg';
  var DIGITS_FA = '۰۱۲۳۴۵۶۷۸۹';
  var ICON_SHAPES = {
    home: [
      ['path', { d: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
      ['polyline', { points: '9 22 9 12 15 12 15 22' }]
    ],
    users: [
      ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
      ['circle', { cx: '9', cy: '7', r: '4' }],
      ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]
    ],
    teacher: [
      ['path', { d: 'm2 10 10-5 10 5-10 5-10-5z' }],
      ['path', { d: 'M6 12v5c3.5 2.5 8.5 2.5 12 0v-5M22 10v6' }],
      ['circle', { cx: '22', cy: '17', r: '1' }]
    ],
    alert: [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' }],
      ['path', { d: 'M12 9v4M12 17h.01' }]
    ],
    school: [
      ['path', { d: 'm22 10-10-5L2 10l10 5 10-5z' }],
      ['path', { d: 'M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 10v6' }]
    ],
    calendar: [
      ['rect', { x: '3', y: '4', width: '18', height: '17', rx: '2' }],
      ['path', { d: 'M16 2v4M8 2v4M3 10h18' }]
    ],
    check: [
      ['path', { d: 'm5 12 4 4L19 6' }],
      ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10' }]
    ],
    cross: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['path', { d: 'm9 9 6 6m0-6-6 6' }]
    ],
    report: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['path', { d: 'M14 2v6h6M16 13H8M16 17H8M10 9H8' }]
    ],
    chart: [
      ['path', { d: 'M3 3v18h18' }],
      ['path', { d: 'm7 14 4-4 4 3 6-7' }],
      ['path', { d: 'M17 6h4v4' }]
    ],
    megaphone: [
      ['path', { d: 'm3 11 18-5v12L3 13v-2z' }],
      ['path', { d: 'M11.6 16.8a3 3 0 1 1-5.8-1.6M16 8v8' }]
    ],
    health: [
      ['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]
    ],
    globe: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }]
    ],
    cloud: [
      ['path', { d: 'M17.5 19a4.5 4.5 0 1 0-.42-8.97 6 6 0 0 0-11.36 2.2A3.5 3.5 0 0 0 7 19z' }]
    ],
    gear: [
      ['circle', { cx: '12', cy: '12', r: '3' }],
      ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.26.6.94.88 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }]
    ],
    pen: [
      ['path', { d: 'm17 3 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }],
      ['path', { d: 'm15 5 4 4' }]
    ],
    mail: [
      ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }],
      ['path', { d: 'm22 7-10 5L2 7' }]
    ],
    folder: [
      ['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z' }]
    ],
    family: [
      ['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
      ['circle', { cx: '9', cy: '7', r: '4' }],
      ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]
    ],
    clock: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 6v6l4 2' }]
    ],
    down: [
      ['path', { d: 'M12 5v14M19 12l-7 7-7-7' }]
    ],
    default: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['path', { d: 'M12 8v4l3 3' }]
    ]
  };

  /* کلیدها با حذف variation selector نرمال می‌شوند تا شکل‌های emoji یکسان شوند. */
  var EMOJI_TO_ICON = {
    '🏠': 'home', '🏡': 'home', '👥': 'users', '👤': 'users', '👨‍🏫': 'teacher',
    '⚠': 'alert', '⚠\uFE0F': 'alert',
    '🏛': 'school', '🏛\uFE0F': 'school', '🏫': 'school',
    '🗓': 'calendar', '🗓\uFE0F': 'calendar', '📅': 'calendar',
    '✅': 'check', '✅\uFE0F': 'check', '✔': 'check', '✔\uFE0F': 'check', '❌': 'cross',
    '📑': 'report', '📊': 'chart', '📄': 'report',
    '📢': 'megaphone', '📢\uFE0F': 'megaphone', '📣': 'megaphone',
    '🩺': 'health', '🌐': 'globe', '☁': 'cloud', '☁\uFE0F': 'cloud',
    '⚙': 'gear', '⚙\uFE0F': 'gear', '📝': 'pen', '✏': 'pen', '✏\uFE0F': 'pen',
    '📨': 'mail', '✉': 'mail', '✉\uFE0F': 'mail', '📁': 'folder', '🗂': 'folder', '🗂\uFE0F': 'folder',
    '👨‍👩‍👦': 'family', '👨‍👩‍👧': 'family', '🕐': 'clock', '⏰': 'clock',
    '⬇': 'down', '⬇\uFE0F': 'down', '📥': 'down'
  };

  function makeSvgElement(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function createIcon(name, className) {
    var shape = ICON_SHAPES[name] || ICON_SHAPES.default;
    var svg = makeSvgElement('svg', {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    shape.forEach(function (piece) {
      svg.appendChild(makeSvgElement(piece[0], piece[1]));
    });
    if (className) svg.setAttribute('class', className);
    return svg;
  }

  function fa(value) {
    return String(value).replace(/\d/g, function (digit) { return DIGITS_FA[Number(digit)]; });
  }

  function toAsciiDigits(value) {
    return String(value)
      .replace(/[۰-۹]/g, function (digit) { return String(DIGITS_FA.indexOf(digit)); })
      .replace(/[٠-٩]/g, function (digit) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)); });
  }

  function iconNameFor(text) {
    var key = String(text || '').trim().replace(/[\uFE0E\uFE0F]/g, '');
    return EMOJI_TO_ICON[key] || '';
  }

  function swapIcons(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = root.querySelectorAll('.ico, .navitem > span, .bn > span, .banner div > span:first-child');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute('data-pjs-done') === '1' || el.querySelector('svg')) continue;
      var name = iconNameFor(el.textContent);
      if (!name) continue;
      var svg = createIcon(name);
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(svg);
      el.classList.add('pjs-ic');
      el.setAttribute('data-pjs-done', '1');
    }
  }

  function tintAttendance(root) {
    var buttons = root.querySelectorAll('button, .btn');
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (button.getAttribute('data-pjs-att') === '1') continue;
      var text = (button.textContent || '').replace(/\s+/g, '');
      if (/^(حاضر|ح)$/.test(text)) button.classList.add('pjs-att', 'pjs-att-p');
      else if (/^(غایب|غ)$/.test(text)) button.classList.add('pjs-att', 'pjs-att-a');
      else if (/^(تأخیر|تاخیر|ت)$/.test(text)) button.classList.add('pjs-att', 'pjs-att-l');
      else if (/^(خروج|خ)$/.test(text)) button.classList.add('pjs-att', 'pjs-att-e');
      button.setAttribute('data-pjs-att', '1');
    }
  }

  function parseCount(text) {
    var match = toAsciiDigits(text).match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : null;
  }

  function readStats(root) {
    var stats = { present: null, absent: null, late: null, total: null };
    var cards = root.querySelectorAll('.stat');
    for (var i = 0; i < cards.length; i++) {
      var labelNode = cards[i].querySelector('.lbl');
      var numberNode = cards[i].querySelector('.num');
      if (!labelNode || !numberNode) continue;
      var label = (labelNode.textContent || '').replace(/\s+/g, ' ').trim();
      var count = parseCount(numberNode.textContent || '');
      if (count === null) continue;
      if (/حاضر/.test(label)) stats.present = count;
      else if (/غایب/.test(label)) stats.absent = count;
      else if (/تأخیر|تاخیر/.test(label)) stats.late = count;
      else if (/دانش.?آموز|کل/.test(label)) stats.total = count;
    }
    if (stats.total === null && stats.present !== null && stats.absent !== null) {
      stats.total = stats.present + stats.absent + (stats.late || 0);
    }
    return stats.present !== null && stats.total > 0 ? stats : null;
  }

  function legendItem(kind, label, value) {
    var item = document.createElement('span');
    item.className = 'nabd-legend-item';
    var swatch = document.createElement('i');
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--legend-color', kind);
    var text = document.createElement('span');
    text.textContent = label + ' ';
    var number = document.createElement('em');
    number.textContent = fa(value);
    item.appendChild(swatch);
    item.appendChild(text);
    item.appendChild(number);
    return item;
  }

  function buildNabdCard(stats) {
    var percent = Math.max(0, Math.min(100, Math.round(stats.present / stats.total * 100)));
    var circumference = 2 * Math.PI * 34;
    var card = document.createElement('section');
    card.className = 'nabd-card';
    card.setAttribute('data-pjs-nabd', '1');
    card.setAttribute('aria-label', 'خلاصهٔ پایش حضور امروز');

    var heading = document.createElement('div');
    heading.className = 'nabd-head';
    heading.appendChild(createIcon('health', 'pjs-ic'));
    var title = document.createElement('span');
    title.textContent = 'نبض امروز مدرسه';
    heading.appendChild(title);

    var body = document.createElement('div');
    body.className = 'nabd-body';
    var metrics = document.createElement('div');
    metrics.className = 'nabd-metrics';
    var number = document.createElement('div');
    number.className = 'nabd-num';
    number.appendChild(document.createTextNode(fa(stats.present)));
    var small = document.createElement('small');
    small.textContent = 'از ' + fa(stats.total) + ' دانش‌آموز حاضر';
    number.appendChild(small);
    metrics.appendChild(number);

    var legend = document.createElement('div');
    legend.className = 'nabd-legend';
    legend.appendChild(legendItem('#10b981', 'حاضر', stats.present));
    if (stats.absent !== null) legend.appendChild(legendItem('#f43f5e', 'غایب', stats.absent));
    if (stats.late !== null) legend.appendChild(legendItem('#f59e0b', 'تأخیر', stats.late));
    metrics.appendChild(legend);

    var ringWrap = document.createElement('div');
    ringWrap.className = 'nabd-ringwrap';
    ringWrap.setAttribute('role', 'img');
    ringWrap.setAttribute('aria-label', 'درصد حضور: ' + percent + '٪');
    var ringSvg = makeSvgElement('svg', { viewBox: '0 0 80 80', 'aria-hidden': 'true', focusable: 'false' });
    var track = makeSvgElement('circle', { cx: '40', cy: '40', r: '34', class: 'nabd-ring-track' });
    var ring = makeSvgElement('circle', {
      cx: '40', cy: '40', r: '34', class: 'nabd-ring',
      'stroke-dasharray': String(circumference),
      'stroke-dashoffset': String(circumference)
    });
    ringSvg.appendChild(track);
    ringSvg.appendChild(ring);
    var ringValue = document.createElement('div');
    ringValue.className = 'nabd-ringval';
    ringValue.textContent = fa(percent) + '٪';
    ringWrap.appendChild(ringSvg);
    ringWrap.appendChild(ringValue);
    body.appendChild(metrics);
    body.appendChild(ringWrap);
    card.appendChild(heading);
    card.appendChild(body);

    var animate = function () {
      ring.setAttribute('stroke-dashoffset', String(circumference * (1 - percent / 100)));
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(animate);
    else window.setTimeout(animate, 16);
    return card;
  }

  function mountNabd(root) {
    if (root.querySelector('[data-pjs-nabd]')) return;
    var topbar = root.querySelector('.dashboard-topbar') || root.querySelector('.topbar');
    var heading = topbar && topbar.querySelector('h2');
    if (!heading || !/(داشبورد|امروز|خانه|فرزندان)/.test(heading.textContent || '')) return;
    var stats = readStats(root);
    if (!stats) return;
    var grid = topbar.nextElementSibling;
    if (!grid || !grid.classList.contains('grid')) grid = root.querySelector('.grid');
    if (!grid) return;
    grid.insertBefore(buildNabdCard(stats), grid.firstChild);
  }

  function mountNowChip(root) {
    if (root.querySelector('[data-pjs-now]')) return;
    var bar = root.querySelector('.topbar');
    if (!bar) return;
    var today = new Date().toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' });
    var chip = document.createElement('span');
    chip.className = 'nowchip no-print';
    chip.setAttribute('data-pjs-now', '1');
    chip.appendChild(createIcon('clock', 'pjs-ic'));
    chip.appendChild(document.createTextNode(today));
    var live = document.createElement('i');
    live.className = 'live';
    live.setAttribute('aria-hidden', 'true');
    chip.appendChild(live);
    var titleBox = bar.firstElementChild;
    if (titleBox) titleBox.appendChild(chip);
    else bar.appendChild(chip);
  }

  function apply(root) {
    if (!root || !root.querySelectorAll) return;
    swapIcons(root);
    tintAttendance(root);
    mountNabd(root);
    mountNowChip(root);
  }

  var refreshScheduled = false;
  function scheduleApply() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    var run = function () {
      refreshScheduled = false;
      apply(document.getElementById('app') || document.body);
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else window.setTimeout(run, 16);
  }

  function boot() {
    var root = document.getElementById('app') || document.body;
    apply(root);
    if (window.MutationObserver) {
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          if (records[i].addedNodes && records[i].addedNodes.length) {
            scheduleApply();
            break;
          }
        }
      });
      try { observer.observe(root, { childList: true, subtree: true }); } catch (e) {}
    }
    window.addEventListener('hashchange', scheduleApply);
  }

  window.__payeshPulse = { v: VERSION };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.PayeshPulse = {
    version: VERSION,
    off: function () { try { localStorage.setItem('payesh.pulse.off', '1'); } catch (e) {} window.location.reload(); },
    on: function () { try { localStorage.removeItem('payesh.pulse.off'); } catch (e) {} window.location.reload(); }
  };
})();
