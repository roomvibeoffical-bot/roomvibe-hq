// Sales Inbox importer (runs every 5 min on GitHub Actions, before notify.mjs).
// The sales team's Claude agent writes one row per sale/payment into the private Google Sheet "HQ Sales Inbox".
// This script reads new rows, saves them as deals / payments / deliveries in the app, and writes the result back.
import admin from "firebase-admin";
import { JWT } from "google-auth-library";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT, SHEET = process.env.SALES_SHEET_ID;
if (!raw || !SHEET) { console.log("Inbox: FIREBASE_SERVICE_ACCOUNT or SALES_SHEET_ID missing. Skipping."); process.exit(0); }
const sa = JSON.parse(raw);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore(), fcm = admin.messaging();

const TAB = "Sheet1", AGENT = "sales-agent";
const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
async function api(path, opts = {}) {
  const { token } = await jwt.getAccessToken();
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const SOURCES = ["G1 · Google Ads (website)", "G2 · Google organic", "G3 · Google ad WhatsApp", "M1 · Meta ad", "S1 · FB/IG visit", "A1 · AI / ChatGPT", "W1 · Direct / other", "Unknown"];
const TZ = "Asia/Dubai";
const todayDubai = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const nowISO = () => new Date().toISOString();
const s = v => String(v ?? "").trim();
const money = v => { const x = s(v).replace(/aed|dhs?\.?|,|\s/gi, ""); if (!x) return null; const n = Number(x); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => /^\d{1,2}:\d{2}$/.test(v);
const source = v => { const c = s(v).toUpperCase().split(/[\s·]/)[0]; return SOURCES.find(x => x.startsWith(c + " ")) || "Unknown"; };
function items(v) {
  return s(v).split(/\r?\n|;/).map(l => l.trim()).filter(Boolean).slice(0, 60).map(l => {
    const m = /^(\d+)\s*[x×*]\s*(.+)$/i.exec(l); let qty = 1, rest = l;
    if (m) { qty = Number(m[1]) || 1; rest = m[2]; }
    const [name, ...note] = rest.split(/\s+[—–-]\s+/);
    return { name: name.trim().slice(0, 120), qty, note: note.join(" - ").trim().slice(0, 160) };
  });
}

// ---- people ----
const users = (await db.collection("users").get()).docs.map(d => ({ uid: d.id, ...d.data() }));
const byEmail = e => users.find(u => u.active && s(u.email).toLowerCase() === s(e).toLowerCase());
const supervisor = users.find(u => u.active && u.role === "supervisor");
const bosses = users.filter(u => u.active && ["owner", "admin"].includes(u.role));
async function push(title, body) {
  for (const u of bosses) {
    const tokens = u.fcmTokens || []; if (!tokens.length) continue;
    try { await fcm.sendEachForMulticast({ tokens, data: { title: title.slice(0, 90), body: body.slice(0, 180), url: "./#deals", tag: "inbox" }, webpush: { headers: { Urgency: "high", TTL: "86400" } } }); } catch (e) { console.log("push failed", e.message); }
  }
}

// ---- read sheet ----
const got = await api(`/values/${encodeURIComponent(TAB + "!A2:V1000")}?valueRenderOption=FORMATTED_VALUE`);
const rows = got.values || [];
let done = 0, failed = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i], rowNo = i + 2;
  const status = s(r[0]).toUpperCase();
  if (status && status !== "NEW") continue;           // only blank or NEW rows
  if (!r.slice(2, 20).some(x => s(x))) continue;        // empty line
  const f = {
    action: s(r[2]).toUpperCase() || "NEW SALE", quoteNo: s(r[3]).toUpperCase(), customer: s(r[4]), phone: s(r[5]), area: s(r[6]), location: s(r[7]),
    package: s(r[8]), items: items(r[9]), value: money(r[10]), paid: money(r[11]), method: s(r[12]), orderDate: s(r[13]), deliveryDate: s(r[14]),
    time: s(r[15]), source: s(r[16]), seller: s(r[17]), quoteUrl: s(r[18]), notes: s(r[19])
  };
  let result = "", dealId = "", ok = true;
  try {
    if (!f.quoteNo) throw new Error("Quote No is required.");
    if (Number.isNaN(f.value) || Number.isNaN(f.paid)) throw new Error("Total / Paid must be numbers.");
    if (f.orderDate && !isDate(f.orderDate)) throw new Error("Order date must be YYYY-MM-DD.");
    if (f.deliveryDate && !isDate(f.deliveryDate)) throw new Error("Delivery date must be YYYY-MM-DD.");
    if (f.time && !isTime(f.time)) throw new Error("Delivery time must be HH:MM.");
    if (f.quoteUrl && !/^https:\/\//.test(f.quoteUrl)) throw new Error("Quotation link must start with https://");
    if (f.value != null && f.paid != null && f.paid > f.value) throw new Error("Paid is more than Total.");

    const found = await db.collection("deals").where("quoteNo", "==", f.quoteNo).limit(1).get();
    const stamp = { updatedAt: nowISO(), updatedBy: AGENT };
    const seller = f.seller ? byEmail(f.seller) : null;
    if (f.seller && !seller) throw new Error(`Sales person ${f.seller} is not an active app user.`);
    const payNote = f.method && f.paid != null ? `Payment ${f.paid} AED via ${f.method} (${todayDubai()})` : "";

    if (found.empty) {
      if (f.action === "PAYMENT") throw new Error(`No deal with Quote No ${f.quoteNo}. Send it first as NEW SALE.`);
      if (!f.customer) throw new Error("Customer is required for a new sale.");
      const ref = db.collection("deals").doc(); dealId = ref.id;
      const stage = f.deliveryDate ? "Delivery scheduled" : (f.paid ? "Advance paid" : "Quotation sent");
      const closeDate = stage === "Quotation sent" ? "" : (f.orderDate || todayDubai());
      const owner = seller ? seller.uid : "";
      await ref.set(Object.assign({ customer: f.customer, phone: f.phone, area: f.area, location: f.location, package: f.package, source: source(f.source),
        items: f.items, quoteUrl: f.quoteUrl, quoteNo: f.quoteNo, stage, ownerUid: owner, date: f.orderDate || todayDubai(), closeDate, deliveryDate: f.deliveryDate,
        notes: [`Quote ${f.quoteNo}`, payNote, f.notes].filter(Boolean).join("\n"), createdAt: nowISO(), createdBy: AGENT }, stamp));
      if (f.value != null || f.paid != null) await db.doc("dealMoney/" + dealId).set({ value: f.value || 0, paid: f.paid || 0, ownerUid: owner, updatedAt: stamp.updatedAt });
      if (f.deliveryDate) await addDelivery(dealId, f);
      result = `New deal saved (${stage})${f.deliveryDate ? `, delivery ${f.deliveryDate}${supervisor ? " for " + (supervisor.name || supervisor.email) : " — no supervisor assigned yet"}` : ""}.`;
      await push(`New sale: ${f.customer}`, [f.package, f.value != null ? `AED ${f.value}` : "", f.paid ? `paid ${f.paid}` : "", f.deliveryDate ? `delivery ${f.deliveryDate}` : ""].filter(Boolean).join(" · "));
    } else {
      const doc = found.docs[0], d = doc.data(); dealId = doc.id;
      const upd = { ...stamp };
      for (const k of ["customer", "phone", "area", "location", "package", "quoteUrl"]) if (f[k]) upd[k] = f[k];
      if (f.items.length) upd.items = f.items;
      if (f.source) upd.source = source(f.source);
      if (seller) upd.ownerUid = seller.uid;
      if (f.deliveryDate) { upd.deliveryDate = f.deliveryDate; if (!["Delivered", "Lost"].includes(d.stage)) upd.stage = "Delivery scheduled"; }
      else if (f.paid && ["New lead", "Quotation sent"].includes(d.stage || "New lead")) upd.stage = "Advance paid";
      if (upd.stage && upd.stage !== "Quotation sent" && !d.closeDate) upd.closeDate = f.orderDate || todayDubai();
      const extra = [payNote, f.notes].filter(Boolean).join("\n");
      if (extra) upd.notes = [d.notes, extra].filter(Boolean).join("\n");
      await doc.ref.update(upd);
      if (f.value != null || f.paid != null) {
        const mref = db.doc("dealMoney/" + dealId), m = (await mref.get()).data() || {};
        await mref.set({ value: f.value != null ? f.value : (m.value || 0), paid: f.paid != null ? f.paid : (m.paid || 0), ownerUid: upd.ownerUid || d.ownerUid || "", updatedAt: stamp.updatedAt });
      }
      if (f.deliveryDate) {
        const t = await db.collection("tasks").where("dealId", "==", dealId).where("type", "==", "Delivery").limit(1).get();
        if (t.empty) await addDelivery(dealId, { ...d, ...f, customer: f.customer || d.customer, phone: f.phone || d.phone, area: f.area || d.area, location: f.location || d.location, package: f.package || d.package, items: f.items.length ? f.items : (d.items || []), quoteUrl: f.quoteUrl || d.quoteUrl });
        else {
          const tu = { due: f.deliveryDate, updatedAt: nowISO(), updatedBy: AGENT };
          if (f.time) tu.time = f.time;
          if (t.docs[0].data().due !== f.deliveryDate) Object.assign(tu, { notified: false, remindEve: false, remindDay: false });
          await t.docs[0].ref.update(tu);
        }
      }
      result = `Updated deal${upd.stage ? " (" + upd.stage + ")" : ""}${f.paid != null ? `, paid now AED ${f.paid}` : ""}${f.deliveryDate ? `, delivery ${f.deliveryDate}` : ""}.`;
      await push(`${f.action === "PAYMENT" ? "Payment" : "Deal updated"}: ${f.customer || d.customer}`, result);
    }
    done++;
  } catch (e) { ok = false; failed++; result = "Error: " + e.message; }
  await api(`/values/${encodeURIComponent(`${TAB}!A${rowNo}`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [[ok ? "IMPORTED" : "ERROR"]] }) });
  await api(`/values/${encodeURIComponent(`${TAB}!U${rowNo}:V${rowNo}`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [[dealId, `${result} (${new Date().toLocaleString("en-GB", { timeZone: TZ })})`]] }) });
}

async function addDelivery(dealId, f) {
  const title = ("Delivery: " + (f.package || (f.items[0] && f.items[0].name) || "order") + " — " + f.customer).slice(0, 120);
  await db.collection("tasks").doc().set({ title, type: "Delivery", assigneeUid: supervisor ? supervisor.uid : "", due: f.deliveryDate, time: f.time || "", dealId,
    customer: f.customer, phone: f.phone || "", area: f.area || "", location: f.location || "", items: f.items || [], quoteUrl: f.quoteUrl || "", notes: f.notes || "",
    status: "Open", report: "", doneAt: "", notified: false, remindEve: false, remindDay: false, createdAt: nowISO(), createdBy: AGENT, updatedAt: nowISO(), updatedBy: AGENT });
}

console.log(`Inbox: ${rows.length} rows, imported ${done}, errors ${failed}.`);
