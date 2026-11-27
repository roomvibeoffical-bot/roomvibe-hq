// RoomVibe HQ – Sales webhook (Google Apps Script web app).
// Owner: roomvibeoffical@gmail.com (the Firebase project owner). Deploy: Web app, Execute as: Me, Who has access: Anyone.
// The sales agent POSTs one JSON message per sale / payment / update and gets "Saved" or the exact error back at once.
// Every call is also written to the "HQ Sales Log (webhook)" sheet as a backup.

// The secret key lives in Project Settings > Script properties > KEY (never in this file, the repo is public).
const PROJECT = 'roomvibe-hq';
const QUOTES_FOLDER = '1RL36IgukoM86FBlxYwD-qFVwkBGslP1O';     // Drive folder "Quotations"
const TZ = 'Asia/Dubai';
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
const AGENT = 'sales-agent';
const SOURCES = ['G1 · Google Ads (website)', 'G2 · Google organic', 'G3 · Google ad WhatsApp', 'M1 · Meta ad', 'S1 · FB/IG visit', 'A1 · AI / ChatGPT', 'W1 · Direct / other', 'Unknown'];
const STAGES = ['New lead', 'Quotation sent', 'Advance paid', 'Delivery scheduled', 'Delivered', 'Lost'];

// ---------- entry points ----------
function doGet() { return out({ ok: true, service: 'RoomVibe HQ sales webhook', time: new Date().toISOString() }); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out({ ok: false, error: 'Body must be JSON.' }); }
  const KEY = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!KEY) return out({ ok: false, error: 'Webhook not set up: Script property KEY is missing.' });
  if (body.key !== KEY) return out({ ok: false, error: 'Wrong key.' });
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  let res;
  try { res = handle(body); } catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
  finally { lock.releaseLock(); }
  try { log(body, res); } catch (err) { res.logWarning = 'Saved, but the backup log failed: ' + err.message; }
  return out(res);
}

// Run this ONCE from the editor (select "setup", press Run) to give permissions and create the log sheet.
function setup() {
  const folder = DriveApp.getFolderById(QUOTES_FOLDER);
  const users = listUsers();
  const id = logSheet().getParent().getId();
  if (!PropertiesService.getScriptProperties().getProperty('KEY')) throw new Error('Add Script property KEY first (Project Settings > Script properties).');
  Logger.log('OK. Quotations folder: ' + folder.getName() + ' | app users: ' + users.length + ' | log sheet: https://docs.google.com/spreadsheets/d/' + id);
}

// ---------- main ----------
function handle(b) {
  const f = read(b);
  const now = new Date(), today = day(now), tomorrow = day(new Date(now.getTime() + 864e5)), hour = Number(Utilities.formatDate(now, TZ, 'H'));
  const users = listUsers();
  const seller = f.seller ? users.find(u => u.active && low(u.email) === low(f.seller)) : null;
  if (f.seller && !seller) throw new Error('Sales person ' + f.seller + ' is not an active app user. Leave it empty or use the Gmail used in the app.');
  const supervisor = users.find(u => u.active && u.role === 'supervisor');
  const bosses = users.filter(u => u.active && (u.role === 'owner' || u.role === 'admin'));
  const quoteUrl = quotation(b, f);
  const found = findOne('deals', [eq('quoteNo', f.quoteNo)]);
  const stamp = { updatedAt: iso(), updatedBy: AGENT };
  const payNote = f.paid != null && f.method ? 'Payment ' + f.paid + ' AED via ' + f.method + ' (' + today + ')' : '';

  if (f.action === 'DELETE TEST') {
    if (!/^RV-Q-TEST/.test(f.quoteNo)) throw new Error('DELETE TEST only works on Quote No starting with RV-Q-TEST.');
    if (!found) return { ok: true, action: f.action, quoteNo: f.quoteNo, message: 'Nothing to delete.' };
    findAll('tasks', [eq('dealId', found.id)]).forEach(t => fs('delete', '/tasks/' + t.id));
    try { fs('delete', '/dealMoney/' + found.id); } catch (err) {}
    fs('delete', '/deals/' + found.id);
    return { ok: true, action: f.action, quoteNo: f.quoteNo, dealId: found.id, message: 'Test deal, money and delivery deleted.' };
  }

  if (!found) {
    if (f.action === 'PAYMENT' || f.action === 'UPDATE') throw new Error('No deal with Quote No ' + f.quoteNo + '. Send it first as NEW SALE.');
    if (!f.customer) throw new Error('Customer is required for a NEW SALE.');
    const stage = f.stage || (f.deliveryDate ? 'Delivery scheduled' : (f.paid ? 'Advance paid' : 'Quotation sent'));
    const closeDate = (stage === 'Quotation sent' || stage === 'New lead') ? '' : (f.orderDate || today);
    const owner = seller ? seller.uid : '';
    const deal = Object.assign({
      customer: f.customer, phone: f.phone, area: f.area, location: f.location, package: f.package, source: f.source || 'Unknown',
      items: f.items || [], quoteUrl: quoteUrl, quoteNo: f.quoteNo, stage: stage, ownerUid: owner, date: f.orderDate || today, closeDate: closeDate,
      deliveryDate: f.deliveryDate, notes: ['Quote ' + f.quoteNo, payNote, f.notes].filter(Boolean).join('\n'), createdAt: iso(), createdBy: AGENT
    }, stamp);
    const dealId = fs('post', '/deals', { fields: encFields(deal) }).name.split('/').pop();
    if (f.value != null || f.paid != null) fs('patch', '/dealMoney/' + dealId, { fields: encFields({ value: f.value || 0, paid: f.paid || 0, ownerUid: owner, updatedAt: stamp.updatedAt }) });
    let taskId = '';
    if (f.deliveryDate) taskId = addDelivery(dealId, Object.assign({}, deal, { time: f.time }), supervisor, today, tomorrow, hour);
    const msg = 'Saved in HQ app: ' + f.customer + (f.value != null ? ', AED ' + f.value : '') + (f.paid != null ? ', paid ' + f.paid : '') +
      (f.deliveryDate ? ', delivery ' + f.deliveryDate + (f.time ? ' ' + f.time : '') + (supervisor ? ' (' + (supervisor.name || supervisor.email) + ')' : ' (no supervisor in the app yet)') : '') + '. Stage: ' + stage + '.';
    pushTo(bosses, 'New sale: ' + f.customer, [f.package, f.value != null ? 'AED ' + f.value : '', f.paid ? 'paid ' + f.paid : '', f.deliveryDate ? 'delivery ' + f.deliveryDate : ''].filter(Boolean).join(' · '), './#deals', 'deal-' + dealId);
    return { ok: true, action: 'NEW SALE', quoteNo: f.quoteNo, dealId: dealId, stage: stage, quoteUrl: quoteUrl, deliveryTaskId: taskId, message: msg };
  }

  // ---- existing deal: PAYMENT / UPDATE (a repeated NEW SALE also updates) ----
  const d = found.data, dealId = found.id, upd = Object.assign({}, stamp);
  ['customer', 'phone', 'area', 'location', 'package'].forEach(k => { if (f[k]) upd[k] = f[k]; });
  if (quoteUrl) upd.quoteUrl = quoteUrl;
  if (f.items) upd.items = f.items;
  if (f.source) upd.source = f.source;
  if (seller) upd.ownerUid = seller.uid;
  if (f.orderDate) upd.date = f.orderDate;
  if (f.stage) upd.stage = f.stage;
  else if (f.deliveryDate && ['Delivered', 'Lost'].indexOf(d.stage) < 0) upd.stage = 'Delivery scheduled';
  else if (f.paid && ['New lead', 'Quotation sent', '', undefined].indexOf(d.stage) >= 0) upd.stage = 'Advance paid';
  if (f.deliveryDate) upd.deliveryDate = f.deliveryDate;
  if (upd.stage && ['New lead', 'Quotation sent', 'Lost'].indexOf(upd.stage) < 0 && !d.closeDate) upd.closeDate = f.orderDate || today;
  const extra = [payNote, f.notes].filter(Boolean).join('\n');
  if (extra) upd.notes = [d.notes, extra].filter(Boolean).join('\n');
  const keys = Object.keys(upd);
  fs('patch', '/deals/' + dealId + '?' + mask(keys), { fields: encFields(upd) });

  if (f.value != null || f.paid != null) {
    let m = {}; try { m = decFields(fs('get', '/dealMoney/' + dealId).fields || {}); } catch (err) {}
    const value = f.value != null ? f.value : (m.value || 0), paid = f.paid != null ? f.paid : (m.paid || 0);
    if (paid > value && value > 0) throw new Error('Paid (' + paid + ') is more than Total (' + value + '). Deal details were updated, money was not.');
    fs('patch', '/dealMoney/' + dealId, { fields: encFields({ value: value, paid: paid, ownerUid: upd.ownerUid || d.ownerUid || '', updatedAt: stamp.updatedAt }) });
  }

  // delivery task: create, or update date / time / details
  const merged = Object.assign({}, d, upd);
  const task = findOne('tasks', [eq('dealId', dealId), eq('type', 'Delivery')]);
  let taskNote = '';
  if (task) {
    const tu = { updatedAt: iso(), updatedBy: AGENT };
    if (f.deliveryDate) tu.due = f.deliveryDate;
    if (f.time) tu.time = f.time;
    ['customer', 'phone', 'area', 'location'].forEach(k => { if (f[k]) tu[k] = f[k]; });
    if (f.items) tu.items = f.items;
    if (quoteUrl) tu.quoteUrl = quoteUrl;
    if (f.stage === 'Lost') tu.status = 'Cancelled';
    const moved = (f.deliveryDate && f.deliveryDate !== task.data.due) || (f.time && f.time !== task.data.time);
    if (moved && task.data.assigneeUid) {
      const sup = users.find(u => u.uid === task.data.assigneeUid);
      if (sup) pushTo([sup], 'Delivery changed: ' + merged.customer, [tu.due || task.data.due, tu.time || task.data.time, merged.area].filter(Boolean).join(' · '), './#tasks', task.id);
      Object.assign(tu, { notified: true, remindEve: (tu.due || task.data.due) === tomorrow && hour >= 18, remindDay: (tu.due || task.data.due) === today && hour >= 8 });
    }
    fs('patch', '/tasks/' + task.id + '?' + mask(Object.keys(tu)), { fields: encFields(tu) });
    taskNote = moved ? ', delivery moved to ' + (tu.due || task.data.due) + (tu.time ? ' ' + tu.time : '') : '';
  } else if (f.deliveryDate) {
    addDelivery(dealId, Object.assign({}, merged, { time: f.time }), supervisor, today, tomorrow, hour);
    taskNote = ', delivery ' + f.deliveryDate + (f.time ? ' ' + f.time : '') + ' added';
  }
  const label = f.action === 'PAYMENT' ? 'Payment' : 'Deal updated';
  const msg = 'Saved in HQ app (' + label + '): ' + merged.customer + (f.paid != null ? ', paid now AED ' + f.paid : '') + taskNote + (upd.stage ? '. Stage: ' + upd.stage : '') + '.';
  pushTo(bosses, label + ': ' + merged.customer, msg, './#deals', 'deal-' + dealId);
  return { ok: true, action: f.action, quoteNo: f.quoteNo, dealId: dealId, stage: upd.stage || d.stage, quoteUrl: quoteUrl || d.quoteUrl || '', message: msg };
}

function addDelivery(dealId, x, supervisor, today, tomorrow, hour) {
  const title = ('Delivery: ' + (x.package || (x.items && x.items[0] && x.items[0].name) || 'order') + ' — ' + x.customer).slice(0, 120);
  const task = {
    title: title, type: 'Delivery', assigneeUid: supervisor ? supervisor.uid : '', due: x.deliveryDate, time: x.time || '', dealId: dealId,
    customer: x.customer || '', phone: x.phone || '', area: x.area || '', location: x.location || '', items: x.items || [], quoteUrl: x.quoteUrl || '', notes: '',
    status: 'Open', report: '', doneAt: '', notified: !!supervisor, remindEve: x.deliveryDate === tomorrow && hour >= 18, remindDay: x.deliveryDate === today && hour >= 8,
    createdAt: iso(), createdBy: AGENT, updatedAt: iso(), updatedBy: AGENT
  };
  const id = fs('post', '/tasks', { fields: encFields(task) }).name.split('/').pop();
  if (supervisor) pushTo([supervisor], 'New delivery: ' + title.replace(/^Delivery: /, ''), [x.deliveryDate, x.time, x.area].filter(Boolean).join(' · '), './#tasks', id);
  return id;
}

// ---------- input ----------
function read(b) {
  const action = up(b.action || 'NEW SALE').replace(/[_-]/g, ' ');
  if (['NEW SALE', 'PAYMENT', 'UPDATE', 'DELETE TEST'].indexOf(action) < 0) throw new Error('action must be NEW SALE, PAYMENT or UPDATE.');
  const f = {
    action: action, quoteNo: up(b.quoteNo), customer: str(b.customer), phone: phone(b.phone), area: str(b.area), location: str(b.location || b.mapsLink),
    package: str(b.package), items: items(b.items), value: money(b.total, 'total'), paid: money(b.paid, 'paid'), method: str(b.method), orderDate: str(b.orderDate),
    deliveryDate: str(b.deliveryDate), time: str(b.deliveryTime || b.time), source: source(b.refCode || b.source), seller: str(b.salesEmail || b.seller), notes: str(b.notes),
    stage: str(b.stage)
  };
  if (!f.quoteNo) throw new Error('quoteNo is required (e.g. RV-Q-100648).');
  if (f.orderDate && !isDate(f.orderDate)) throw new Error('orderDate must be YYYY-MM-DD.');
  if (f.deliveryDate && !isDate(f.deliveryDate)) throw new Error('deliveryDate must be YYYY-MM-DD.');
  if (f.time && !/^\d{1,2}:\d{2}$/.test(f.time)) throw new Error('deliveryTime must be HH:MM (24h), or leave it empty.');
  if (f.stage && STAGES.indexOf(f.stage) < 0) throw new Error('stage must be one of: ' + STAGES.join(', '));
  if (f.value != null && f.paid != null && f.paid > f.value) throw new Error('paid is more than total.');
  return f;
}
function quotation(b, f) {
  const folder = DriveApp.getFolderById(QUOTES_FOLDER);
  if (str(b.quoteFileId)) {
    const file = DriveApp.getFileById(str(b.quoteFileId));
    let inFolder = false; const ps = file.getParents(); while (ps.hasNext()) if (ps.next().getId() === QUOTES_FOLDER) inFolder = true;
    if (!inFolder) file.moveTo(folder);
    return file.getUrl();
  }
  if (str(b.quotePdfBase64)) {
    const name = str(b.quoteFileName) || (f.quoteNo + (f.customer ? ' - ' + f.customer : '') + '.pdf');
    return folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.quotePdfBase64), 'application/pdf', name)).getUrl();
  }
  const u = str(b.quoteUrl);
  if (u && !/^https:\/\//.test(u)) throw new Error('quoteUrl must start with https://');
  return u;
}
function items(v) {
  if (v == null || v === '') return null;
  const list = Array.isArray(v) ? v : String(v).split(/\r?\n|;/);
  const out = list.map(x => {
    if (x && typeof x === 'object') return { name: str(x.name).slice(0, 120), qty: Number(x.qty) || 1, note: str(x.note).slice(0, 160) };
    const l = str(x); if (!l) return null;
    const m = /^(\d+)\s*[x×*]\s*(.+)$/i.exec(l); let qty = 1, rest = l;
    if (m) { qty = Number(m[1]) || 1; rest = m[2]; }
    const parts = rest.split(/\s+[—–-]\s+/);
    return { name: parts[0].trim().slice(0, 120), qty: qty, note: parts.slice(1).join(' - ').trim().slice(0, 160) };
  }).filter(i => i && i.name).slice(0, 60);
  return out.length ? out : null;
}
function phone(v) {
  let p = str(v).replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.indexOf('00') === 0) p = '+' + p.slice(2);
  else if (p.indexOf('971') === 0) p = '+' + p;
  else if (/^05\d{8}$/.test(p)) p = '+971' + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = '+971' + p;
  return p;
}
function money(v, name) {
  if (v === undefined || v === null || str(v) === '') return null;
  const n = Number(str(v).replace(/aed|dhs?\.?|,|\s/gi, ''));
  if (!isFinite(n) || n < 0) throw new Error(name + ' must be a number (AED).');
  return Math.round(n * 100) / 100;
}
function source(v) { const c = up(v).split(/[\s·]/)[0]; return c ? (SOURCES.find(x => x.indexOf(c + ' ') === 0) || 'Unknown') : ''; }
const str = v => (v === undefined || v === null) ? '' : String(v).trim();
const up = v => str(v).toUpperCase();
const low = v => str(v).toLowerCase();
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
const iso = () => new Date().toISOString();
const day = d => Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

// ---------- Firestore (REST, as the project owner) ----------
function fs(method, path, payload) {
  const opt = { method: method, muteHttpExceptions: true, contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': PROJECT } };
  if (payload) opt.payload = JSON.stringify(payload);
  const r = UrlFetchApp.fetch(BASE + path, opt), code = r.getResponseCode(), txt = r.getContentText();
  if (code >= 300) throw new Error('Database ' + code + ': ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : {};
}
const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: enc(value) } });
function query(coll, filters, limit) {
  const where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } };
  const q = { from: [{ collectionId: coll }], where: where }; if (limit) q.limit = limit;
  return fs('post', ':runQuery', { structuredQuery: q }).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), data: decFields(x.document.fields || {}) }));
}
const findOne = (coll, filters) => query(coll, filters, 1)[0] || null;
const findAll = (coll, filters) => query(coll, filters, 0);
function listUsers() {
  const r = fs('get', '/users?pageSize=300');
  return (r.documents || []).map(d => Object.assign({ uid: d.name.split('/').pop() }, decFields(d.fields || {})));
}
const mask = keys => keys.map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: encFields(v) } };
  return { stringValue: String(v) };
}
function encFields(o) { const f = {}; Object.keys(o).forEach(k => { if (o[k] !== undefined) f[k] = enc(o[k]); }); return f; }
function dec(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  if ('timestampValue' in v) return v.timestampValue;
  return null;
}
function decFields(f) { const o = {}; Object.keys(f).forEach(k => o[k] = dec(f[k])); return o; }

// ---------- phone notifications (FCM, same format as the app's notifier) ----------
function pushTo(people, title, body, url, tag) {
  const tokens = []; people.forEach(p => (p.fcmTokens || []).forEach(t => tokens.push(t)));
  tokens.forEach(t => {
    try {
      UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT + '/messages:send', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': PROJECT },
        payload: JSON.stringify({ message: { token: t, data: { title: String(title).slice(0, 90), body: String(body).slice(0, 180), url: url, tag: String(tag) }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
      });
    } catch (err) {}
  });
}

// ---------- backup log sheet (phone and all cells stored as plain text) ----------
function logSheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('LOG_ID'), ss;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('HQ Sales Log (webhook)');
    props.setProperty('LOG_ID', ss.getId());
    const sh = ss.getSheets()[0]; sh.setName('Log');
    sh.getRange('A:Z').setNumberFormat('@');
    sh.appendRow(['Time (Dubai)', 'Result', 'Action', 'Quote No', 'Customer', 'Phone', 'Area', 'Location', 'Package', 'Items', 'Total', 'Paid', 'Method', 'Order date', 'Delivery date', 'Delivery time', 'Ref code', 'Sales email', 'Quotation link', 'Notes', 'Deal ID', 'Message']);
    sh.setFrozenRows(1);
  }
  return ss.getSheetByName('Log');
}
function log(b, res) {
  const sh = logSheet();
  const itemsText = Array.isArray(b.items) ? b.items.map(i => (i.qty || 1) + ' x ' + i.name + (i.note ? ' — ' + i.note : '')).join('\n') : str(b.items);
  const row = [Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'), res.ok ? 'SAVED' : 'ERROR', str(b.action), up(b.quoteNo), str(b.customer), phone(b.phone), str(b.area), str(b.location || b.mapsLink),
    str(b.package), itemsText, str(b.total), str(b.paid), str(b.method), str(b.orderDate), str(b.deliveryDate), str(b.deliveryTime || b.time), str(b.refCode || b.source),
    str(b.salesEmail || b.seller), res.quoteUrl || str(b.quoteUrl), str(b.notes), res.dealId || '', res.ok ? res.message : res.error].map(String);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}
