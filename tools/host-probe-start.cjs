/* ردیف ۱۱۵ — فایل شروع برای پنل‌هایی که «Application startup file» را با require
   بار می‌کنند (مثل Passenger در cPanel/DirectAdmin). همان پروب را در حالت serve
   بالا می‌آورد. فایل host-probe.mjs باید کنار همین فایل باشد. */
'use strict';
import('./host-probe.mjs').then(m => m.main(['--serve'])).catch(e => { console.error(String(e && e.stack || e)); process.exitCode = 2; });
