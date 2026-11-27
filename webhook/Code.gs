// RoomVibe HQ – Sales webhook (Google Apps Script web app).
// Owner: roomvibeoffical@gmail.com (the Firebase project owner). Deploy: Web app, Execute as: Me, Who has access: Anyone.
// The sales agent POSTs one JSON message per sale / payment / update and gets "Saved" or the exact error back at once.
// Actions: NEW SALE, PAYMENT, UPDATE (deals) · APPOINTMENT, APPOINTMENT UPDATE, APPOINTMENT CANCEL (specialist visits) · DELETE TEST
// · full access: FIND, LIST DEALS, LIST TASKS, SUMMARY, LIST SUPPLIERS, LIST SUPPLIER PAYMENTS, LIST EXPENSES, LIST TEAM,
//   TASK ADD, TASK UPDATE, SUPPLIER ADD, SUPPLIER UPDATE, SUPPLIER PAYMENT, EXPENSE ADD, ROLE (see admin()).
// App requests (no KEY, signed-in Firebase user): QUOTE PDF (see quotePdf() at the end).
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
  if (body.idToken) return out(appRequest(body));   // the HQ app itself (signed-in user), see "app requests" below
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
  const act = up(b.action).replace(/[_-]/g, ' ');
  if (act.indexOf('APPOINTMENT') === 0) return appointment(b, act);
  if (ADMIN_ACTIONS.indexOf(act) >= 0) return admin(b, act);
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
      items: f.items || [], quoteUrl: quoteUrl, quoteFileId: fileIdOf(quoteUrl), quoteNo: f.quoteNo, stage: stage, ownerUid: owner, date: f.orderDate || today, closeDate: closeDate,
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
  if (quoteUrl) { upd.quoteUrl = quoteUrl; upd.quoteFileId = fileIdOf(quoteUrl); }
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
    if (quoteUrl) { tu.quoteUrl = quoteUrl; tu.quoteFileId = fileIdOf(quoteUrl); }
    if (!task.data.quoteNo) tu.quoteNo = f.quoteNo;
    if (task.data.notes && noPay(task.data.notes) !== task.data.notes) tu.notes = noPay(task.data.notes);
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
    title: title, type: 'Delivery', assigneeUid: supervisor ? supervisor.uid : '', due: x.deliveryDate, time: x.time || '', dealId: dealId, quoteNo: x.quoteNo || '', quoteFileId: fileIdOf(x.quoteUrl),
    customer: x.customer || '', phone: x.phone || '', area: x.area || '', location: x.location || '', items: x.items || [], quoteUrl: x.quoteUrl || '', notes: '',
    status: 'Open', report: '', doneAt: '', notified: !!supervisor, remindEve: x.deliveryDate === tomorrow && hour >= 18, remindDay: x.deliveryDate === today && hour >= 8,
    createdAt: iso(), createdBy: AGENT, updatedAt: iso(), updatedBy: AGENT
  };
  const id = fs('post', '/tasks', { fields: encFields(task) }).name.split('/').pop();
  if (supervisor) pushTo([supervisor], 'New delivery: ' + title.replace(/^Delivery: /, ''), [x.deliveryDate, x.time, x.area].filter(Boolean).join(' · '), './#tasks', id);
  return id;
}

// ---------- appointments (specialist visits: measurement, curtains, fabric samples) ----------
const APPT_TYPES = ['Measurement', 'Curtains', 'Fabric samples', 'Other'];
function appointment(b, act) {
  if (['APPOINTMENT', 'APPOINTMENT UPDATE', 'APPOINTMENT CANCEL'].indexOf(act) < 0) throw new Error('action must be APPOINTMENT, APPOINTMENT UPDATE or APPOINTMENT CANCEL.');
  const now = new Date(), today = day(now), tomorrow = day(new Date(now.getTime() + 864e5)), hour = Number(Utilities.formatDate(now, TZ, 'H'));
  const id = str(b.appointmentId);
  if (id && !/^[A-Za-z0-9]+$/.test(id)) throw new Error('appointmentId is not valid.');
  if (act !== 'APPOINTMENT' && !id) throw new Error('appointmentId is required to update or cancel (it was in the reply when the appointment was made).');
  const users = listUsers(), specs = users.filter(u => u.active && u.role === 'specialist');
  let spec = null;
  if (str(b.specialist)) {
    const q = low(b.specialist);
    spec = specs.find(u => low(u.email) === q) || specs.find(u => low(u.name) === q) || specs.find(u => low(u.name).indexOf(q) >= 0) || null;
    if (!spec) throw new Error('Specialist "' + str(b.specialist) + '" is not an active Specialist in the app. Leave it empty, or give him the Specialist role in Team & Access.');
  }
  let type = '';
  if (str(b.type)) { type = APPT_TYPES.find(t => low(t) === low(b.type)) || ''; if (!type) throw new Error('type must be one of: ' + APPT_TYPES.join(', ') + '.'); }
  const a = { customer: str(b.customer), phone: phone(b.phone), address: str(b.address), area: str(b.area), location: str(b.mapsLink || b.location), due: str(b.date), time: str(b.time), notes: noPay(str(b.notes)), quoteNo: up(b.quoteNo) };
  if (a.due && !isDate(a.due)) throw new Error('date must be YYYY-MM-DD.');
  if (a.time && !/^\d{1,2}:\d{2}$/.test(a.time)) throw new Error('time must be HH:MM (24h), or leave it empty.');
  if (a.location && !/^https:\/\//.test(a.location)) { a.address = a.address || a.location; a.location = ''; }
  let dealId = '';
  if (a.quoteNo) { const d = findOne('deals', [eq('quoteNo', a.quoteNo)]); dealId = d ? d.id : ''; }
  const label = u => u ? (u.name || u.email) : 'no specialist yet';
  const when = (dd, tt) => [dd, tt].filter(Boolean).join(' ');

  if (!id) {   // ---- new appointment ----
    if (!a.customer) throw new Error('customer is required for an APPOINTMENT.');
    if (!a.due) throw new Error('date is required for an APPOINTMENT (YYYY-MM-DD).');
    if (!spec) spec = specs[0] || null;
    type = type || 'Measurement';
    const task = {
      title: (type + ': ' + a.customer).slice(0, 120), type: type, assigneeUid: spec ? spec.uid : '', due: a.due, time: a.time, dealId: dealId, quoteNo: a.quoteNo,
      customer: a.customer, phone: a.phone, address: a.address, area: a.area, location: a.location, items: [], quoteUrl: '', notes: a.notes,
      status: 'Open', report: '', doneAt: '', notified: !!spec, remindEve: a.due === tomorrow && hour >= 18, remindDay: a.due === today && hour >= 8,
      createdAt: iso(), createdBy: AGENT, updatedAt: iso(), updatedBy: AGENT
    };
    const newId = fs('post', '/tasks', { fields: encFields(task) }).name.split('/').pop();
    if (spec) pushTo([spec], 'New appointment: ' + type + ' · ' + a.customer, [when(a.due, a.time), a.area || a.address].filter(Boolean).join(' · '), './#visits', newId);
    return { ok: true, action: 'APPOINTMENT', appointmentId: newId, quoteNo: a.quoteNo, specialist: label(spec), message: 'Appointment saved: ' + type + ' · ' + a.customer + ' · ' + when(a.due, a.time) + ' (' + label(spec) + '). appointmentId ' + newId + '.' };
  }

  // ---- existing appointment: update or cancel ----
  let cur;
  try { cur = decFields(fs('get', '/tasks/' + id).fields || {}); } catch (err) { throw new Error('No appointment with appointmentId ' + id + '.'); }
  if (cur.type === 'Delivery') throw new Error('appointmentId ' + id + ' is a delivery, not an appointment. Use UPDATE with the Quote No for deliveries.');
  const owner = users.find(u => u.uid === cur.assigneeUid) || null;
  if (act === 'APPOINTMENT CANCEL') {
    const upd = { status: 'Cancelled', notes: [cur.notes, 'Cancelled (' + today + ')' + (a.notes ? ': ' + a.notes : '')].filter(Boolean).join('\n'), updatedAt: iso(), updatedBy: AGENT };
    fs('patch', '/tasks/' + id + '?' + mask(Object.keys(upd)), { fields: encFields(upd) });
    if (owner) pushTo([owner], 'Appointment cancelled: ' + (cur.customer || ''), when(cur.due, cur.time), './#visits', id);
    return { ok: true, action: 'APPOINTMENT CANCEL', appointmentId: id, message: 'Appointment cancelled: ' + (cur.customer || '') + ' · ' + when(cur.due, cur.time) + '.' };
  }
  const upd = { updatedAt: iso(), updatedBy: AGENT };
  ['customer', 'phone', 'address', 'area', 'location', 'due', 'time', 'quoteNo'].forEach(k => { if (a[k]) upd[k] = a[k]; });
  if (a.notes) upd.notes = a.notes;
  if (type) upd.type = type;
  if (a.quoteNo) upd.dealId = dealId;
  if (spec) upd.assigneeUid = spec.uid;
  if (upd.type || upd.customer) upd.title = ((upd.type || cur.type) + ': ' + (upd.customer || cur.customer)).slice(0, 120);
  if (cur.status === 'Cancelled' && str(b.reopen).toLowerCase() === 'true') upd.status = 'Open';
  const target = spec || owner;
  const changed = ['due', 'time', 'address', 'area', 'location', 'assigneeUid'].some(k => upd[k] !== undefined && upd[k] !== cur[k]);
  if (changed && target) {
    const due = upd.due || cur.due;
    Object.assign(upd, { notified: true, remindEve: due === tomorrow && hour >= 18, remindDay: due === today && hour >= 8 });
  }
  fs('patch', '/tasks/' + id + '?' + mask(Object.keys(upd)), { fields: encFields(upd) });
  const m = Object.assign({}, cur, upd);
  if (changed && target) pushTo([target], 'Appointment changed: ' + (m.customer || ''), [when(m.due, m.time), m.area || m.address].filter(Boolean).join(' · '), './#visits', id);
  return { ok: true, action: 'APPOINTMENT UPDATE', appointmentId: id, specialist: label(spec || owner), message: 'Appointment updated: ' + (m.type || '') + ' · ' + (m.customer || '') + ' · ' + when(m.due, m.time) + ' (' + label(spec || owner) + ').' };
}

// ---------- input ----------
function read(b) {
  const action = up(b.action || 'NEW SALE').replace(/[_-]/g, ' ');
  if (['NEW SALE', 'PAYMENT', 'UPDATE', 'DELETE TEST'].indexOf(action) < 0) throw new Error('Unknown action. Use NEW SALE, PAYMENT, UPDATE, APPOINTMENT…, or one of: ' + ADMIN_ACTIONS.join(', ') + '.');
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
    str(b.package), itemsText, str(b.total), str(b.paid), str(b.method), str(b.orderDate), str(b.deliveryDate || b.date), str(b.deliveryTime || b.time), str(b.refCode || b.source),
    str(b.salesEmail || b.seller), res.quoteUrl || str(b.quoteUrl), str(b.notes), res.dealId || res.appointmentId || '', res.ok ? res.message : res.error].map(String);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

// ---------- full HQ access for the sales agent (read + manage) ----------
// Reads: FIND, LIST DEALS, LIST TASKS, SUMMARY, LIST SUPPLIERS, LIST SUPPLIER PAYMENTS, LIST EXPENSES, LIST TEAM.
// Writes: TASK ADD, TASK UPDATE, SUPPLIER ADD, SUPPLIER UPDATE, SUPPLIER PAYMENT, EXPENSE ADD, ROLE.
// Safety: nothing is deleted here; owner accounts can never be changed and nobody can be made owner.
const ADMIN_ACTIONS = ['FIND', 'LIST DEALS', 'LIST TASKS', 'SUMMARY', 'LIST SUPPLIERS', 'LIST SUPPLIER PAYMENTS', 'LIST EXPENSES', 'LIST TEAM',
  'TASK ADD', 'TASK UPDATE', 'SUPPLIER ADD', 'SUPPLIER UPDATE', 'SUPPLIER PAYMENT', 'EXPENSE ADD', 'ROLE'];
const TASK_TYPES = ['Delivery', 'Measurement', 'Curtains', 'Fabric samples', 'Site visit', 'Follow-up', 'Supplier pickup', 'Other'];
const TASK_STATUS = ['Open', 'Done', 'Cancelled'];
const WON = ['Advance paid', 'Delivery scheduled', 'Delivered'];
const EXP_CATS = ['Google Ads', 'Meta Ads', 'Salaries', 'Delivery & transport', 'Rent & office', 'Other'];
const PAY_METHODS = ['Bank transfer', 'Cash', 'Card', 'Cheque'];
const GIVE_ROLES = ['admin', 'manager', 'sales', 'supervisor', 'specialist', 'marketing'];
const MAX_LIST = 100;

function listAll(coll) {
  let docs = [], token = '';
  do {
    const r = fs('get', '/' + coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (r.documents || []).forEach(d => docs.push({ id: d.name.split('/').pop(), data: decFields(d.fields || {}) }));
    token = r.nextPageToken || '';
  } while (token);
  return docs;
}
function pick(list, v, label) {           // exact match from a fixed list, case-insensitive
  if (!str(v)) return '';
  const x = list.find(o => low(o) === low(v)) || list.find(o => low(o).indexOf(low(v)) === 0);
  if (!x) throw new Error(label + ' must be one of: ' + list.join(', ') + '.');
  return x;
}
function person(users, v) {
  const q = low(v); if (!q) return null;
  const act = users.filter(u => u.active);
  const u = act.find(x => low(x.email) === q) || act.find(x => low(x.name) === q) || act.find(x => low(x.name).indexOf(q) >= 0);
  if (!u) throw new Error('"' + str(v) + '" is not an active app user. Use LIST TEAM to see names and Gmails.');
  return u;
}
const uname = (users, uid) => { const u = users.find(x => x.uid === uid); return u ? (u.name || u.email) : (uid ? 'unknown user' : 'Unassigned'); };
const inRange = (d, a, b) => !!d && d >= a && d <= b;
function range(b) {
  const t = day(new Date()), a = str(b.from) || t.slice(0, 8) + '01', z = str(b.to) || t;
  if (!isDate(a) || !isDate(z)) throw new Error('from / to must be YYYY-MM-DD.');
  return [a, z];
}
function moneyMap() { const m = {}; listAll('dealMoney').forEach(x => m[x.id] = x.data); return m; }
function dealOut(x, m, users, tasks) {
  const d = x.data, mm = m[x.id] || {}, value = Number(mm.value) || 0, paid = Number(mm.paid) || 0;
  const o = { dealId: x.id, quoteNo: d.quoteNo || '', customer: d.customer || '', phone: d.phone || '', area: d.area || '', package: d.package || '', stage: d.stage || 'New lead',
    total: value, paid: paid, balance: Math.max(0, value - paid), leadDate: d.date || '', orderDate: d.closeDate || '', deliveryDate: d.deliveryDate || '',
    salesPerson: uname(users, d.ownerUid), source: d.source || '', quoteUrl: d.quoteUrl || '', items: d.items || [], notes: d.notes || '' };
  if (tasks) o.tasks = tasks.filter(t => t.data.dealId === x.id).map(t => taskOut(t, users));
  return o;
}
function taskOut(t, users) {
  const x = t.data;
  return { taskId: t.id, type: x.type || '', title: x.title || '', date: x.due || '', time: x.time || '', status: x.status || 'Open', assignedTo: uname(users, x.assigneeUid),
    customer: x.customer || '', phone: x.phone || '', area: x.area || '', address: x.address || '', mapsLink: x.location || '', quoteNo: x.quoteNo || '', dealId: x.dealId || '',
    notes: x.notes || '', report: x.report || '' };
}

function admin(b, act) {
  const users = listUsers(), now = new Date(), today = day(now), tomorrow = day(new Date(now.getTime() + 864e5)), hour = Number(Utilities.formatDate(now, TZ, 'H'));
  const bosses = users.filter(u => u.active && (u.role === 'owner' || u.role === 'admin'));
  const stamp = () => ({ updatedAt: iso(), updatedBy: AGENT });
  const done = (o, msg) => Object.assign({ ok: true, action: act, message: msg }, o);

  // ===== reads =====
  if (act === 'FIND') {
    const q = str(b.q || b.quoteNo || b.phone || b.customer); if (!q) throw new Error('Send q: a Quote No, phone or customer name.');
    const digits = q.replace(/\D/g, '').slice(-9), deals = listAll('deals'), m = moneyMap(), tasks = listAll('tasks');
    const hit = deals.filter(x => { const d = x.data;
      return up(d.quoteNo) === up(q) || (digits.length >= 7 && String(d.phone || '').replace(/\D/g, '').indexOf(digits) >= 0) || low(d.customer).indexOf(low(q)) >= 0; }).slice(0, 20);
    return done({ count: hit.length, deals: hit.map(x => dealOut(x, m, users, tasks)) }, hit.length ? 'Found ' + hit.length + ' deal(s) for "' + q + '".' : 'No deal found for "' + q + '".');
  }
  if (act === 'LIST DEALS') {
    const m = moneyMap(), stage = str(b.stage), unpaid = str(b.unpaid).toLowerCase() === 'true';
    if (stage && stage !== 'Open' && stage !== 'All' && STAGES.indexOf(stage) < 0) throw new Error('stage must be Open, All, or one of: ' + STAGES.join(', '));
    let list = listAll('deals');
    if (unpaid) list = list.filter(x => WON.indexOf(x.data.stage) >= 0 && (Number((m[x.id] || {}).value) || 0) > (Number((m[x.id] || {}).paid) || 0));
    else {
      if (stage === 'Open' || !stage) list = list.filter(x => ['Delivered', 'Lost'].indexOf(x.data.stage) < 0);
      else if (stage !== 'All') list = list.filter(x => (x.data.stage || 'New lead') === stage);
      if (str(b.from) || str(b.to)) { const r = range(b); list = list.filter(x => inRange(x.data.date, r[0], r[1])); }
    }
    list.sort((p, q) => String(q.data.date || '').localeCompare(String(p.data.date || '')));
    const outList = list.slice(0, MAX_LIST).map(x => dealOut(x, m, users));
    const due = outList.reduce((s, d) => s + d.balance, 0);
    return done({ count: list.length, deals: outList }, list.length + ' deal(s)' + (unpaid ? ' with money still to collect: AED ' + due : '') + (list.length > MAX_LIST ? ' (first ' + MAX_LIST + ' shown)' : '') + '.');
  }
  if (act === 'LIST TASKS') {
    const type = str(b.type) ? pick(TASK_TYPES, b.type, 'type') : '', status = str(b.status) ? (low(b.status) === 'all' ? 'All' : pick(TASK_STATUS, b.status, 'status')) : 'Open';
    const who = str(b.assignee) ? person(users, b.assignee) : null;
    let list = listAll('tasks').filter(t => (!type || t.data.type === type) && (status === 'All' || (t.data.status || 'Open') === status) && (!who || t.data.assigneeUid === who.uid));
    if (str(b.from) || str(b.to)) { const r = range(b); list = list.filter(t => inRange(t.data.due, r[0], r[1])); }
    list.sort((p, q) => ((p.data.due || '9') + (p.data.time || '')).localeCompare((q.data.due || '9') + (q.data.time || '')));
    return done({ count: list.length, tasks: list.slice(0, MAX_LIST).map(t => taskOut(t, users)) }, list.length + ' task(s).');
  }
  if (act === 'SUMMARY') {
    const r = range(b), m = moneyMap(), deals = listAll('deals'), pays = listAll('payments'), exps = listAll('expenses');
    const val = x => Number((m[x.id] || {}).value) || 0, paidOf = x => Number((m[x.id] || {}).paid) || 0;
    const won = deals.filter(x => WON.indexOf(x.data.stage) >= 0 && inRange(x.data.closeDate, r[0], r[1]));
    const sales = won.reduce((s, x) => s + val(x), 0);
    const sup = pays.filter(p => inRange(p.data.date, r[0], r[1])).reduce((s, p) => s + (Number(p.data.amount) || 0), 0);
    const ex = exps.filter(e => inRange(e.data.date, r[0], r[1])), sum = f => ex.filter(f).reduce((s, e) => s + (Number(e.data.amount) || 0), 0);
    const google = sum(e => e.data.category === 'Google Ads'), meta = sum(e => e.data.category === 'Meta Ads'), other = sum(e => ['Google Ads', 'Meta Ads'].indexOf(e.data.category) < 0);
    const leads = deals.filter(x => inRange(x.data.date, r[0], r[1])).length;
    const toCollect = deals.filter(x => WON.indexOf(x.data.stage) >= 0).reduce((s, x) => s + Math.max(0, val(x) - paidOf(x)), 0);
    const costs = sup + google + meta + other;
    const s = { from: r[0], to: r[1], sales: sales, orders: won.length, paidToSuppliers: sup, googleAds: google, metaAds: meta, otherExpenses: other, profitEstimate: sales - costs, newLeads: leads, stillToCollect: toCollect };
    return done({ summary: s }, r[0] + ' to ' + r[1] + ': sales AED ' + sales + ' (' + won.length + ' orders), costs AED ' + costs + ', profit (estimate) AED ' + (sales - costs) + ', still to collect AED ' + toCollect + '.');
  }
  if (act === 'LIST SUPPLIERS') {
    const list = listAll('suppliers').map(x => ({ supplierId: x.id, name: x.data.name || '', phone: x.data.phone || '', category: x.data.category || '', notes: x.data.notes || '' }));
    return done({ count: list.length, suppliers: list }, list.length + ' supplier(s).');
  }
  if (act === 'LIST SUPPLIER PAYMENTS' || act === 'LIST EXPENSES') {
    const r = range(b), sups = {}; listAll('suppliers').forEach(x => sups[x.id] = x.data.name);
    const isPay = act === 'LIST SUPPLIER PAYMENTS';
    const list = listAll(isPay ? 'payments' : 'expenses').filter(x => inRange(x.data.date, r[0], r[1])).sort((p, q) => String(q.data.date).localeCompare(String(p.data.date)))
      .map(x => isPay ? { paymentId: x.id, supplier: sups[x.data.supplierId] || '', amount: Number(x.data.amount) || 0, date: x.data.date || '', method: x.data.method || '', note: x.data.note || '' }
                      : { expenseId: x.id, category: x.data.category || '', amount: Number(x.data.amount) || 0, date: x.data.date || '', note: x.data.note || '' });
    const total = list.reduce((s, x) => s + x.amount, 0);
    return done({ count: list.length, total: total, items: list.slice(0, MAX_LIST) }, list.length + (isPay ? ' supplier payment(s)' : ' expense(s)') + ', total AED ' + total + ' (' + r[0] + ' to ' + r[1] + ').');
  }
  if (act === 'LIST TEAM') {
    const list = users.map(u => ({ name: u.name || '', email: u.email || '', role: u.role || '', active: !!u.active }));
    const inv = listAll('invites').filter(i => !users.some(u => low(u.email) === i.id)).map(i => ({ email: i.id, role: i.data.role || '', status: 'invited, not signed in yet' }));
    return done({ team: list, invites: inv }, list.length + ' people in the app' + (inv.length ? ', ' + inv.length + ' invited' : '') + '.');
  }

  // ===== writes =====
  if (act === 'TASK ADD') {
    const title = str(b.title), type = pick(TASK_TYPES, b.type || 'Other', 'type'), due = str(b.date), time = str(b.time);
    if (!title) throw new Error('title is required (what needs doing).');
    if (due && !isDate(due)) throw new Error('date must be YYYY-MM-DD.');
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM (24h).');
    const who = str(b.assignee) ? person(users, b.assignee) : null, qn = up(b.quoteNo);
    let dealId = ''; if (qn) { const d = findOne('deals', [eq('quoteNo', qn)]); if (!d) throw new Error('No deal with Quote No ' + qn + '.'); dealId = d.id; }
    let loc = str(b.mapsLink || b.location), addr = str(b.address); if (loc && !/^https:\/\//.test(loc)) { addr = addr || loc; loc = ''; }
    const task = Object.assign({ title: title.slice(0, 120), type: type, assigneeUid: who ? who.uid : '', due: due, time: time, dealId: dealId, quoteNo: qn,
      customer: str(b.customer), phone: phone(b.phone), area: str(b.area), address: addr, location: loc, items: items(b.items) || [], quoteUrl: '', notes: noPay(str(b.notes)),
      status: 'Open', report: '', doneAt: '', notified: !!who, remindEve: due === tomorrow && hour >= 18, remindDay: due === today && hour >= 8, createdAt: iso(), createdBy: AGENT }, stamp());
    const id = fs('post', '/tasks', { fields: encFields(task) }).name.split('/').pop();
    if (who) pushTo([who], 'New task: ' + title, [due, time, task.area || addr].filter(Boolean).join(' · '), './#tasks', id);
    return done({ taskId: id }, 'Task saved: ' + type + ' · ' + title + (due ? ' · ' + due + (time ? ' ' + time : '') : '') + ' (' + (who ? who.name || who.email : 'Unassigned') + '). taskId ' + id + '.');
  }
  if (act === 'TASK UPDATE') {
    let t = null, id = str(b.taskId);
    if (id) { if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('taskId is not valid.'); try { t = { id: id, data: decFields(fs('get', '/tasks/' + id).fields || {}) }; } catch (err) { throw new Error('No task with taskId ' + id + '.'); } }
    else if (up(b.quoteNo)) { const d = findOne('deals', [eq('quoteNo', up(b.quoteNo))]); if (!d) throw new Error('No deal with Quote No ' + up(b.quoteNo) + '.'); t = findOne('tasks', [eq('dealId', d.id), eq('type', 'Delivery')]); if (!t) throw new Error('Quote No ' + up(b.quoteNo) + ' has no delivery yet. Send UPDATE with deliveryDate first.'); id = t.id; }
    else throw new Error('Send taskId, or quoteNo to change that order\'s delivery.');
    const cur = t.data, upd = stamp();
    if (str(b.title)) upd.title = str(b.title).slice(0, 120);
    if (str(b.type)) upd.type = pick(TASK_TYPES, b.type, 'type');
    if (str(b.date)) { if (!isDate(str(b.date))) throw new Error('date must be YYYY-MM-DD.'); upd.due = str(b.date); }
    if (str(b.time)) { if (!/^\d{1,2}:\d{2}$/.test(str(b.time))) throw new Error('time must be HH:MM (24h).'); upd.time = str(b.time); }
    ['customer', 'area', 'address', 'report'].forEach(k => { if (str(b[k])) upd[k] = str(b[k]); });
    if (str(b.notes)) upd.notes = noPay(str(b.notes));
    if (str(b.phone)) upd.phone = phone(b.phone);
    if (str(b.mapsLink || b.location)) { const l = str(b.mapsLink || b.location); if (/^https:\/\//.test(l)) upd.location = l; else upd.address = upd.address || l; }
    if (b.items) upd.items = items(b.items) || [];
    let who = null;
    if (str(b.assignee)) { if (low(b.assignee) === 'none' || low(b.assignee) === 'unassigned') upd.assigneeUid = ''; else { who = person(users, b.assignee); upd.assigneeUid = who.uid; } }
    if (str(b.status)) { upd.status = pick(TASK_STATUS, b.status, 'status'); upd.doneAt = upd.status === 'Done' ? (cur.doneAt || iso()) : ''; }
    const target = who || users.find(u => u.uid === (upd.assigneeUid !== undefined ? upd.assigneeUid : cur.assigneeUid)) || null;
    const moved = ['due', 'time', 'address', 'area', 'location', 'assigneeUid'].some(k => upd[k] !== undefined && upd[k] !== cur[k]);
    if (moved && target && (upd.status || cur.status) === 'Open') { const due = upd.due || cur.due; Object.assign(upd, { notified: true, remindEve: due === tomorrow && hour >= 18, remindDay: due === today && hour >= 8 }); }
    fs('patch', '/tasks/' + id + '?' + mask(Object.keys(upd)), { fields: encFields(upd) });
    const m2 = Object.assign({}, cur, upd);
    if (moved && target && m2.status === 'Open') pushTo([target], (who && who.uid !== cur.assigneeUid ? 'New ' : 'Changed ') + (m2.type || 'task').toLowerCase() + ': ' + (m2.customer || m2.title), [m2.due, m2.time, m2.area || m2.address].filter(Boolean).join(' · '), m2.type === 'Delivery' ? './#tasks' : './#visits', id);
    if (upd.status === 'Done' && m2.dealId && m2.type === 'Delivery') pushTo(bosses, 'Delivered: ' + (m2.customer || ''), m2.due || '', './#tasks', id);
    return done({ taskId: id }, 'Task updated: ' + (m2.type || '') + ' · ' + (m2.customer || m2.title) + ' · ' + [m2.due, m2.time].filter(Boolean).join(' ') + ' · ' + (m2.status || 'Open') + ' (' + uname(users, m2.assigneeUid) + ').');
  }
  if (act === 'SUPPLIER ADD' || act === 'SUPPLIER UPDATE' || act === 'SUPPLIER PAYMENT') {
    const sups = listAll('suppliers'), sid = str(b.supplierId), sname = str(b.supplier || b.name);
    const find = () => sid ? sups.find(x => x.id === sid) : (sups.find(x => low(x.data.name) === low(sname)) || sups.find(x => low(x.data.name).indexOf(low(sname)) >= 0 && sname));
    if (act === 'SUPPLIER ADD') {
      if (!sname) throw new Error('name is required.');
      if (sups.some(x => low(x.data.name) === low(sname))) throw new Error('Supplier "' + sname + '" already exists. Use SUPPLIER UPDATE.');
      const rec = Object.assign({ name: sname, phone: phone(b.phone), category: str(b.category), notes: str(b.notes), createdAt: iso(), createdBy: AGENT }, stamp());
      const id = fs('post', '/suppliers', { fields: encFields(rec) }).name.split('/').pop();
      return done({ supplierId: id }, 'Supplier saved: ' + sname + '. supplierId ' + id + '.');
    }
    const s = find(); if (!s) throw new Error('Supplier "' + (sid || sname) + '" not found. Use LIST SUPPLIERS, or SUPPLIER ADD first.');
    if (act === 'SUPPLIER UPDATE') {
      const upd = stamp();
      if (str(b.newName)) upd.name = str(b.newName);
      if (str(b.phone)) upd.phone = phone(b.phone);
      ['category', 'notes'].forEach(k => { if (str(b[k])) upd[k] = str(b[k]); });
      fs('patch', '/suppliers/' + s.id + '?' + mask(Object.keys(upd)), { fields: encFields(upd) });
      return done({ supplierId: s.id }, 'Supplier updated: ' + (upd.name || s.data.name) + '.');
    }
    const amount = money(b.amount, 'amount'); if (!amount) throw new Error('amount is required (AED).');
    const date = str(b.date) || today; if (!isDate(date)) throw new Error('date must be YYYY-MM-DD.');
    let method = 'Bank transfer'; if (str(b.method)) method = low(b.method) === 'bank' ? 'Bank transfer' : pick(PAY_METHODS, b.method, 'method');
    let dealId = ''; if (up(b.quoteNo)) { const d = findOne('deals', [eq('quoteNo', up(b.quoteNo))]); if (!d) throw new Error('No deal with Quote No ' + up(b.quoteNo) + '.'); dealId = d.id; }
    const rec = Object.assign({ supplierId: s.id, amount: amount, date: date, method: method, dealId: dealId, note: str(b.note || b.notes), createdAt: iso(), createdBy: AGENT }, stamp());
    const id = fs('post', '/payments', { fields: encFields(rec) }).name.split('/').pop();
    pushTo(bosses, 'Supplier paid: ' + s.data.name, 'AED ' + amount + ' · ' + method + ' · ' + date, './#suppliers', 'pay-' + id);
    return done({ paymentId: id }, 'Supplier payment saved: ' + s.data.name + ', AED ' + amount + ', ' + method + ', ' + date + '.');
  }
  if (act === 'EXPENSE ADD') {
    const category = pick(EXP_CATS, b.category, 'category'); if (!category) throw new Error('category is required: ' + EXP_CATS.join(', ') + '.');
    const amount = money(b.amount, 'amount'); if (!amount) throw new Error('amount is required (AED).');
    const date = str(b.date) || today; if (!isDate(date)) throw new Error('date must be YYYY-MM-DD.');
    const rec = Object.assign({ category: category, amount: amount, date: date, note: str(b.note || b.notes), createdAt: iso(), createdBy: AGENT }, stamp());
    const id = fs('post', '/expenses', { fields: encFields(rec) }).name.split('/').pop();
    return done({ expenseId: id }, 'Expense saved: ' + category + ', AED ' + amount + ', ' + date + '.');
  }
  if (act === 'ROLE') {
    const email = low(b.email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email is required (their Gmail).');
    if (low(b.role) === 'owner') throw new Error('Nobody can be made Owner through the agent. Only Irfan can do that in the app.');
    const role = str(b.role) ? pick(GIVE_ROLES, b.role, 'role') : '';
    const active = str(b.active) ? str(b.active).toLowerCase() === 'true' : null;
    if (!role && active === null) throw new Error('Send role, or active true / false.');
    const u = users.find(x => low(x.email) === email);
    if (u) {
      if (u.role === 'owner') throw new Error(email + ' is an Owner. Owner accounts can only be changed by Irfan in the app.');
      const upd = {}; if (role) { upd.role = role; upd.active = active === null ? true : active; } else upd.active = active;
      fs('patch', '/users/' + u.uid + '?' + mask(Object.keys(upd)), { fields: encFields(upd) });
      const msg = (u.name || email) + ': ' + (role ? 'role ' + role : '') + (role ? ', ' : '') + 'access ' + (upd.active ? 'on' : 'off') + '.';
      pushTo(bosses, 'Team change by sales agent', msg, './#team', 'role-' + u.uid);
      return done({ email: email }, 'Saved. ' + msg);
    }
    if (!role) throw new Error(email + ' has not signed in to the app yet. Send a role to invite them.');
    fs('patch', '/invites/' + encodeURIComponent(email), { fields: encFields({ role: role, invitedBy: AGENT, createdAt: iso() }) });
    pushTo(bosses, 'Team change by sales agent', email + ' invited as ' + role, './#team', 'inv-' + email);
    return done({ email: email }, email + ' invited as ' + role + '. They get an email and can sign in with that Gmail.');
  }
  throw new Error('Unknown action.');
}


// ---------- app requests: quotation PDF inside the HQ app ----------
// The app sends the signed-in user's Firebase ID token. Firestore itself checks that token (users/{uid} read with it),
// then this script (running as the owner) reads the PDF from the Quotations folder and sends it back as base64.
// Owner / admin / manager / sales: any deal or task. Supervisor / specialist / marketing: only tasks assigned to them.
// Nothing about payments is sent: only the PDF, its name and the Quote No.
const APP_FULL = ['owner', 'admin', 'manager', 'sales'], APP_FIELD = ['supervisor', 'specialist', 'marketing'];
const MAX_PDF = 20 * 1024 * 1024;
function appRequest(b) {
  let res, who = null;
  try { const r = quotePdf(b); who = r.who; res = r.res; } catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
  try { appLog(b, res, who); } catch (err) {}
  return res;
}
function appUser(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Please sign in to the app again.');
  let claims;
  try { let p = parts[1]; while (p.length % 4) p += '='; claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p)).getDataAsString()); }
  catch (err) { throw new Error('Please sign in to the app again.'); }
  const uid = str(claims.user_id || claims.sub);
  if (claims.aud !== PROJECT || !/^[A-Za-z0-9]+$/.test(uid)) throw new Error('Please sign in to the app again.');
  const r = UrlFetchApp.fetch(BASE + '/users/' + uid, { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + idToken } });
  const code = r.getResponseCode();
  if (code === 401 || code === 403) throw new Error('Your sign-in has expired. Close the app and open it again.');
  if (code >= 300) throw new Error('Could not check your account (' + code + '). Try again.');
  const u = decFields(JSON.parse(r.getContentText()).fields || {});
  if (!u.active) throw new Error('Your access to the app is off. Ask Irfan.');
  return Object.assign({ uid: uid }, u);
}
function getDocData(coll, id) {
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) return null;
  try { return decFields(fs('get', '/' + coll + '/' + id).fields || {}); } catch (err) { return null; }
}
function fileIdOf(v) {
  const s = str(v); if (!s) return '';
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? m[1] : '';
}
function quotePdf(b) {
  if (up(b.action) !== 'QUOTE PDF') throw new Error('Unknown app request.');
  const me = appUser(b.idToken), full = APP_FULL.indexOf(me.role) >= 0;
  if (!full && APP_FIELD.indexOf(me.role) < 0) throw new Error('Your role cannot open quotations.');
  const tid = str(b.taskId), did = str(b.dealId);
  let task = null, deal = null;
  if (tid) {
    task = getDocData('tasks', tid);
    if (!task) throw new Error('This task was not found. It may have been deleted.');
    if (!full && task.assigneeUid !== me.uid) throw new Error('This task is not assigned to you.');
  } else if (did) {
    if (!full) throw new Error('Open the quotation from your delivery or visit.');
  } else throw new Error('No task or deal was given.');
  const dealId = did || (task && task.dealId) || '';
  if (dealId) deal = getDocData('deals', dealId);
  if (!deal && task && task.quoteNo) { const f = findOne('deals', [eq('quoteNo', up(task.quoteNo))]); deal = f ? f.data : null; }
  if (did && !deal) throw new Error('This deal was not found.');
  const quoteNo = (deal && deal.quoteNo) || (task && task.quoteNo) || '';
  const fid = fileIdOf(deal && (deal.quoteFileId || deal.quoteUrl)) || fileIdOf(task && (task.quoteFileId || task.quoteUrl));
  if (!fid) throw new Error('No quotation PDF is attached to this ' + (task ? (task.type || 'task').toLowerCase() : 'deal') + ' yet. Ask the sales team to add it.');
  let file;
  try { file = DriveApp.getFileById(fid); file.getName(); } catch (err) { throw new Error('The quotation file was not found in Drive. It may have been deleted. Ask the sales team to add it again.'); }
  if (file.isTrashed()) throw new Error('The quotation file is in the Drive bin. Ask the sales team to add it again.');
  let inFolder = false; const ps = file.getParents(); while (ps.hasNext()) if (ps.next().getId() === QUOTES_FOLDER) inFolder = true;
  if (!inFolder) throw new Error('This quotation is not in the "Quotations" folder, so the app cannot show it. Ask the sales team to send it again.');
  const version = fid + ':' + file.getLastUpdated().getTime(), name = full ? file.getName() : 'Quotation ' + quoteNo;   // file names can hold prices
  const who = { email: me.email || me.uid, role: me.role, quoteNo: quoteNo };
  if (str(b.have) && str(b.have) === version) return { who: who, res: { ok: true, notModified: true, version: version, name: name, quoteNo: quoteNo } };
  const mime = file.getMimeType();
  let blob;
  try { blob = mime === 'application/pdf' ? file.getBlob() : file.getAs('application/pdf'); } catch (err) { throw new Error('This quotation file is not a PDF and could not be turned into one.'); }
  const bytes = blob.getBytes();
  if (bytes.length > MAX_PDF) throw new Error('The quotation file is too big to open in the app (over 20 MB).');
  return { who: who, res: { ok: true, version: version, name: name, quoteNo: quoteNo, size: bytes.length, pdfBase64: Utilities.base64Encode(bytes) } };
}
function appLog(b, res, who) {
  const sh = logSheet();
  const row = new Array(22).fill('');
  row[0] = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); row[1] = res.ok ? 'OPENED' : 'ERROR'; row[2] = 'APP ' + up(b.action);
  row[3] = who ? who.quoteNo : ''; row[17] = who ? who.email + ' (' + who.role + ')' : ''; row[20] = str(b.taskId || b.dealId);
  row[21] = res.ok ? (res.notModified ? 'Quotation opened from phone cache' : 'Quotation sent (' + Math.round((res.size || 0) / 1024) + ' KB)') : res.error;
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row.map(String)]);
}

// Payment details must never reach delivery staff: drop any sentence about payments from task / visit notes.
const PAY_WORDS = /(paytabs|\bPTB\d+|\bpaid\b|\bpayments?\b|\bpay\b|tabby|tamara|deposit|advance|\bbalance\b|\bAED\b|\bdhs?\b|\bcard\b|\bcash\b|bank transfer|\breceipt\b|\binvoice\b|dirhams?|\bbaa?qi\b|\bbaa?ki\b|remaining|outstanding|\bCOD\b|\bprice\b|discount)/i;
function noPay(text) {
  return str(text).split(/\r?\n/).map(line => line.split(/(?<=[.!?])\s+/).filter(x => !PAY_WORDS.test(x)).join(' ')).filter(l => l.trim()).join('\n');
}
