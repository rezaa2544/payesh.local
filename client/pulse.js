/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال × مسیر «نبض» — لایهٔ هوشمند — نسخهٔ ۰٫۴٫۰-pulse
   کاملاً افزودنی است؛ هیچ تابع/متغیر موجودی بازنویسی نمی‌شود.
   کلید خاموش‌کننده: localStorage.setItem('payesh.pulse.off','1')
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__payeshPulse) return;
  try { if (localStorage.getItem('payesh.pulse.off') === '1') return; } catch (e) {}
  window.__payeshPulse = { v: '0.4.0-pulse' };
  /* نقشهٔ ایموجی ← SVG */
  var P = {
    home:   '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    users:  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    alert:  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    school: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
    cal:    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    check:  '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    mega:   '<path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    health: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    globe:  '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    cloud:  '<path d="M17.5 19a4.5 4.5 0 1 0-.42-8.97 6 6 0 0 0-11.36 2.2A3.5 3.5 0 0 0 7 19Z"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.26.6.94.88 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    pen:    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    mail:   '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    family: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    clock:  '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    down:   '<path d="M12 5v14M19 12l-7 7-7-7"/>'
  };
  var EMOJI = {
    '🏠':'home','🏡':'home','👥':'users','👤':'users','⚠️':'alert','⚠':'alert','🏛️':'school','🏛':'school','🏫':'school',
    '🗓️':'cal','🗓':'cal','📅':'cal','✅':'check','✔️':'check','📑':'report','📊':'report','📄':'report',
    '📢':'mega','📣':'mega','🩺':'health','🌐':'globe','☁️':'cloud','☁':'cloud','⚙️':'gear','⚙':'gear',
    '📝':'pen','✏️':'pen','📨':'mail','✉️':'mail','📁':'folder','🗂️':'folder','👨‍👩‍👦':'family','👨‍👩‍👧':'family',
    '🕐':'clock','⏰':'clock','⬇️':'down','⬇':'down','📥':'down'
  };
  function svgOf(name){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }
  function swapIcons(root){
    try {
      var spans = root.querySelectorAll('span.ico, .navitem > span, .bn > span, .banner div > span:first-child');
      for (var i = 0; i < spans.length; i++) {
        var el = spans[i];
        if (el.dataset.pjsDone) continue;
        var t = (el.textContent || '').trim();
        var name = EMOJI[t];
        if (!name) { el.dataset.pjsDone = '1'; continue; }
        el.innerHTML = svgOf(name);
        el.classList.add('pjs-ic');
        el.dataset.pjsDone = '1';
      }
    } catch (e) {}
  }
  function tintAttendance(root){
    try {
      var btns = root.querySelectorAll('button, .btn');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.dataset.pjsAtt) continue;
        var t = (b.textContent || '').replace(/\s+/g, '');
        if (!t) continue;
        if (/^(حاضر|ح)$/.test(t))       { b.classList.add('pjs-att','pjs-att-p'); }
        else if (/^(غایب|غ)$/.test(t))  { b.classList.add('pjs-att','pjs-att-a'); }
        else if (/^تأخیر|^تاخیر|^ت$/.test(t)) { b.classList.add('pjs-att','pjs-att-l'); }
        else if (/^خروج|^خ$/.test(t))   { b.classList.add('pjs-att','pjs-att-e'); }
        b.dataset.pjsAtt = '1';
      }
    } catch (e) {}
  }
  var FA_D = '۰۱۲۳۴۵۶۷۸۹';
  function fa(n){ return String(n).replace(/\d/g, function(d){ return FA_D[d]; }); }
  function readStats(root){
    var out = { present:null, absent:null, late:null, total:null };
    var stats = root.querySelectorAll('.stat');
    for (var i = 0; i < stats.length; i++) {
      var lbl = (stats[i].querySelector('.lbl') || {}).textContent || '';
      var num = ((stats[i].querySelector('.num') || {}).textContent || '').replace(/[۰-۹]/g, function(c){ return FA_D.indexOf(c); }).replace(/[^\d]/g,'');
      if (!num) continue;
      var v = parseInt(num, 10);
      if (/حاضر/.test(lbl)) out.present = v;
      else if (/غایب/.test(lbl)) out.absent = v;
      else if (/تأخیر|تاخیر/.test(lbl)) out.late = v;
      else if (/دانش‌آموز|کل/.test(lbl)) out.total = v;
    }
    if (out.present == null) return null;
    if (out.total == null && out.absent != null) out.total = out.present + out.absent + (out.late || 0);
    return (out.total && out.total > 0) ? out : null;
  }
  function nabdCard(st){
    var pct = Math.max(0, Math.min(100, Math.round(st.present / st.total * 100)));
    var C = 2 * Math.PI * 30;
    var legend = '<span><i style="background:#10b981"></i>حاضر <em>' + fa(st.present) + '</em></span>';
    if (st.absent != null) legend += '<span><i style="background:#f43f5e"></i>غایب <em>' + fa(st.absent) + '</em></span>';
    if (st.late != null)   legend += '<span><i style="background:#f59e0b"></i>تأخیر <em>' + fa(st.late) + '</em></span>';
    return '<div class="nabd-card" data-pjs-nabd>' +
      '<div class="nabd-head">' + svgOf('health') + ' نبض امروز مدرسه</div>' +
      '<div class="nabd-body">' +
        '<div><div class="nabd-num">' + fa(st.present) + ' <small>از ' + fa(st.total) + ' حاضر</small></div>' +
        '<div class="nabd-legend">' + legend + '</div></div>' +
        '<div class="nabd-ringwrap"><svg viewBox="0 0 74 74">' +
          '<circle cx="37" cy="37" r="30" fill="none" stroke="var(--line)" stroke-width="8"/>' +
          '<circle class="nabd-ring" cx="37" cy="37" r="30" fill="none" stroke="var(--primary)" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + C.toFixed(1) + '"/>' +
        '</svg><div class="nabd-ringval">' + fa(pct) + '٪</div></div>' +
      '</div>' +
    '</div>';
  }
  function mountNabd(root){
    try {
      if (root.querySelector('[data-pjs-nabd]')) return;
      var main = root.querySelector('.main') || root;
      var h2 = main.querySelector('.topbar h2');
      if (!h2 || !/داشبورد|امروز|خانه|فرزندان/.test(h2.textContent || '')) return;
      var st = readStats(main);
      if (!st) return;
      var firstCard = main.querySelector('.card');
      var host = document.createElement('div');
      host.innerHTML = nabdCard(st);
      var node = host.firstChild;
      if (firstCard) firstCard.parentNode.insertBefore(node, firstCard);
      else main.appendChild(node);
      requestAnimationFrame(function(){ requestAnimationFrame(function(){
        var ring = node.querySelector('.nabd-ring');
        if (ring) {
          var pct = Math.round(st.present / st.total * 100);
          ring.style.strokeDashoffset = (2 * Math.PI * 30 * (1 - pct / 100)).toFixed(1);
        }
      }); });
    } catch (e) {}
  }
  function mountNowChip(root){
    try {
      if (root.querySelector('[data-pjs-now]')) return;
      var bar = root.querySelector('.topbar');
      if (!bar) return;
      var today = new Date().toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' });
      var chip = document.createElement('span');
      chip.className = 'nowchip no-print';
      chip.dataset.pjsNow = '1';
      chip.innerHTML = svgOf('clock') + ' ' + today + ' <i class="live"></i>';
      var titleBox = bar.firstElementChild;
      if (titleBox) titleBox.appendChild(chip);
    } catch (e) {}
  }
  function apply(root){ swapIcons(root); tintAttendance(root); mountNabd(root); mountNowChip(root); }
  function boot(){
    var app = document.getElementById('app') || document.body;
    apply(app);
    var mo = new MutationObserver(function(muts){
      var dirty = false;
      for (var i = 0; i < muts.length; i++) if (muts[i].addedNodes && muts[i].addedNodes.length) { dirty = true; break; }
      if (dirty) apply(app);
    });
    try { mo.observe(app, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function(){ setTimeout(function(){ apply(app); }, 60); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.PayeshPulse = {
    version: '0.4.0-pulse',
    off: function(){ try { localStorage.setItem('payesh.pulse.off','1'); } catch(e){} location.reload(); },
    on:  function(){ try { localStorage.removeItem('payesh.pulse.off'); } catch(e){} location.reload(); }
  };
})();
