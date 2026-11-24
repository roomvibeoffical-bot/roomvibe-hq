// Runs every few minutes on GitHub Actions: sends phone notifications for new visits/deliveries and reminders.
import admin from "firebase-admin";
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.log("FIREBASE_SERVICE_ACCOUNT secret is not set yet. Skipping."); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
const db = admin.firestore(), fcm = admin.messaging();
const TZ = "Asia/Dubai";
const parts = d => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d).map(p => [p.type, p.value]));
const now = new Date(), p = parts(now);
const today = `${p.year}-${p.month}-${p.day}`, hour = Number(p.hour);
const q = parts(new Date(now.getTime() + 864e5)), tomorrow = `${q.year}-${q.month}-${q.day}`;
const fmtTime = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); if (!m) return ""; let h = Number(m[1]); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };
const dayLabel = d => d === today ? "Today" : d === tomorrow ? "Tomorrow" : new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const cache = {};
async function tokensFor(uid) {
  if (!(uid in cache)) { const s = await db.doc("users/" + uid).get(); cache[uid] = s.exists && s.data().active ? (s.data().fcmTokens || []) : []; }
  return cache[uid];
}
async function send(uid, title, body, tag) {
  const tokens = await tokensFor(uid); if (!tokens.length) return 0;
  const res = await fcm.sendEachForMulticast({ tokens, data: { title, body, url: "./#tasks", tag }, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
  const bad = [];
  res.responses.forEach((r, i) => { if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"].includes(r.error && r.error.code)) bad.push(tokens[i]); });
  if (bad.length) { await db.doc("users/" + uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...bad) }); cache[uid] = tokens.filter(t => !bad.includes(t)); }
  return res.successCount;
}
const snap = await db.collection("tasks").where("status", "==", "Open").get();
let sent = 0;
for (const d of snap.docs) {
  const t = d.data(); if (!t.assigneeUid) continue;
  const when = [t.due ? dayLabel(t.due) : "", fmtTime(t.time)].filter(Boolean).join(" ");
  const body = [when, t.customer, t.area || t.location].filter(Boolean).join(" · ").slice(0, 180);
  const name = t.title || t.type || "task", upd = {};
  if (t.notified === false) {
    sent += await send(t.assigneeUid, `New ${String(t.type || "task").toLowerCase()}: ${name}`.slice(0, 90), body, d.id);
    upd.notified = true; upd.notifiedAt = now.toISOString();
    if (t.due === tomorrow && hour >= 18) upd.remindEve = true;
    if (t.due === today && hour >= 8) upd.remindDay = true;
  } else {
    if (t.due === tomorrow && hour >= 18 && !t.remindEve) { sent += await send(t.assigneeUid, `Tomorrow: ${name}`.slice(0, 90), body, d.id); upd.remindEve = true; }
    if (t.due === today && hour >= 8 && !t.remindDay) { sent += await send(t.assigneeUid, `Today: ${name}`.slice(0, 90), body, d.id); upd.remindDay = true; }
  }
  if (Object.keys(upd).length) await d.ref.update(upd);
}
console.log(`Dubai ${today} ${hour}:00 — checked ${snap.size} open tasks, sent ${sent} notifications.`);
