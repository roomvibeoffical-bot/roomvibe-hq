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

// ---------- invitation emails (sent once per invited Gmail) ----------
const GU = process.env.GMAIL_USER, GP = process.env.GMAIL_APP_PASSWORD;
const APP_URL = "https://roomvibeoffical-bot.github.io/roomvibe-hq/";
if (GU && GP) {
  const nodemailer = (await import("nodemailer")).default;
  const mail = nodemailer.createTransport({ service: "gmail", auth: { user: GU, pass: GP.replace(/\s+/g, "") } });
  const inv = await db.collection("invites").get();
  let sentInv = 0;
  for (const d of inv.docs) {
    const v = d.data();
    if (v.emailSent === true || v.emailSent === "error") continue;
    const role = String(v.role || "team member"), label = role.charAt(0).toUpperCase() + role.slice(1);
    const text = `Assalam o Alaikum,\n\nYou have been given access to RoomVibe HQ (RoomVibe team app) as ${label}.\n\n1) Open this link in Chrome (iPhone: Safari): ${APP_URL}\n2) Tap "Sign in with Google" and choose this Gmail: ${d.id}\n3) Android: Chrome menu (3 dots) > "Install and create shortcut" > Install.\n   iPhone: Share > "Add to Home Screen", then open the app from the home screen.\n4) In the app tap "Turn on notifications" and Allow, so you get your visits and deliveries.\n\nAfter this, open the app from the RV icon on your phone.\n\nRoomVibe`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#16211B">
<div style="background:#0F311E;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0"><div style="font-family:Georgia,serif;font-size:26px">RoomVibe HQ</div><div style="opacity:.8;font-size:13px">RoomVibe team app</div></div>
<div style="border:1px solid #DCE2DC;border-top:0;padding:24px;border-radius:0 0 12px 12px">
<p>Assalam o Alaikum,</p><p>You have been given access to <b>RoomVibe HQ</b> as <b>${label}</b>.</p>
<p style="text-align:center;margin:26px 0"><a href="${APP_URL}" style="background:#0F311E;color:#fff;text-decoration:none;padding:14px 26px;border-radius:8px;font-weight:bold;display:inline-block">Open RoomVibe HQ</a></p>
<ol style="padding-left:18px;line-height:1.6"><li>Open the button above in <b>Chrome</b> (iPhone: <b>Safari</b>).</li><li>Tap <b>Sign in with Google</b> and choose <b>${d.id}</b>.</li><li><b>Android:</b> Chrome menu (3 dots) &gt; <b>Install and create shortcut</b> &gt; Install.<br><b>iPhone:</b> Share &gt; <b>Add to Home Screen</b>, then open it from the home screen.</li><li>In the app tap <b>Turn on notifications</b> and <b>Allow</b>.</li></ol>
<p style="color:#5D6A62;font-size:13px">After this, just open the app from the RV icon on your phone.</p></div></div>`;
    try {
      await mail.sendMail({ from: `RoomVibe HQ <${GU}>`, to: d.id, subject: "You're invited to RoomVibe HQ", text, html });
      await d.ref.update({ emailSent: true, emailSentAt: new Date().toISOString() }); sentInv++;
    } catch (e) {
      console.log("Invitation email failed:", e.message);
      await d.ref.update({ emailSent: "error", emailError: String(e.message).slice(0, 200) });
    }
  }
  console.log(`Invitation emails sent: ${sentInv}`);
} else {
  console.log("GMAIL_USER / GMAIL_APP_PASSWORD secrets not set; invitation emails skipped.");
}
