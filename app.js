// RoomVibe HQ — team app (Firebase). Security is enforced by firestore.rules; this file only decides what to show.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, onSnapshot, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyC6QC6z2H7vzVdapDNGTX_FSGqv8hixI4w",
  authDomain: "roomvibe-hq.firebaseapp.com",
  projectId: "roomvibe-hq",
  storageBucket: "roomvibe-hq.firebasestorage.app",
  messagingSenderId: "735051890725",
  appId: "1:735051890725:web:e0c222c8c9783c5176bfcc"
};
const BOOT_OWNERS = ["roomvibeoffical@gmail.com", "irfanaligroumaskhan@gmail.com"];

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
const VAPID_KEY = "BJmHqvGb0sSEH8r15gC9MaIt63dY6ZJqw-l4tmIbDfwgYB63v6Z4qrWUPoByCXVU77A_0-WCsTTRJVrUN5RbP9Y"; // Web Push public key from Firebase > Project settings > Cloud Messaging

// ---------- constants ----------
const STAGES = ["New lead", "Quotation sent", "Advance paid", "Delivery scheduled", "Delivered", "Lost"];
const WON = new Set(["Advance paid", "Delivery scheduled", "Delivered"]);
const SOURCES = ["G1 · Google Ads (website)", "G2 · Google organic", "G3 · Google ad WhatsApp", "M1 · Meta ad", "S1 · FB/IG visit", "A1 · AI / ChatGPT", "W1 · Direct / other", "Unknown"];
const PACKAGES = ["Modry", "Vibe", "Marble", "Halo", "Mini Studio", "Individual items", "Custom"];
const TASK_TYPES = ["Delivery", "Site visit", "Follow-up", "Supplier pickup", "Other"];
const EXP_CATS = ["Google Ads", "Meta Ads", "Salaries", "Delivery & transport", "Rent & office", "Other"];
const PAY_METHODS = ["Bank transfer", "Cash", "Card", "Cheque"];
const ROLE_LABEL = { owner: "Owner", admin: "Admin", manager: "Manager", sales: "Sales", supervisor: "Supervisor", marketing: "Marketing", pending: "Waiting for access" };
const ROLE_HELP = {
  owner: "Everything, including money and giving access",
  admin: "Everything, including money and giving access (cannot change owners)",
  manager: "All customers, deals and tasks. No profit, suppliers or expenses",
  sales: "Customers & deals, own deal values, team tasks",
  supervisor: "Only their own deliveries and site visits",
  marketing: "Leads and sources (no money), own tasks"
};
const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["d3", "Last 3 days"], ["d5", "Last 5 days"], ["d7", "Last 7 days"], ["d30", "Last 1 month (30 days)"], ["thism", "This month"], ["lastm", "Last month"], ["d60", "Last 2 months"], ["d90", "Last 3 months"], ["d180", "Last 6 months"], ["thisy", "This year"], ["d365", "Last 12 months"], ["custom", "Custom dates…"]];

// ---------- small helpers ----------
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = () => iso(new Date());
const nowISO = () => new Date().toISOString();
const addDays = (s, k) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + k); return iso(d); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const aed = v => "AED " + Math.round(num(v)).toLocaleString("en-US");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const code = s => String(s || "Unknown").split(" ·")[0];
const fmtDate = s => { if (!s) return ""; const d = new Date(s + "T00:00:00"); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const fmtLong = s => { const d = new Date(s + "T00:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };
const fmtTime = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); if (!m) return s || ""; let h = +m[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + m[2] + " " + ap; };
const safeUrl = u => (typeof u === "string" && u.startsWith("https://")) ? u : "icon-192.png";
const inR = (s, a, b) => typeof s === "string" && s >= a && s <= b;
function presetRange(p) {
  const t = today(), d = new Date(t + "T00:00:00");
  switch (p) {
    case "today": return [t, t];
    case "yesterday": { const y = addDays(t, -1); return [y, y]; }
    case "d3": return [addDays(t, -2), t]; case "d5": return [addDays(t, -4), t]; case "d7": return [addDays(t, -6), t];
    case "d30": return [addDays(t, -29), t]; case "d60": return [addDays(t, -59), t]; case "d90": return [addDays(t, -89), t];
    case "d180": return [addDays(t, -179), t]; case "d365": return [addDays(t, -364), t];
    case "thism": return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), t];
    case "lastm": return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
    case "thisy": return [d.getFullYear() + "-01-01", t];
  }
  return null;
}

// ---------- state ----------
let user = null, me = null, R = "none", subKey = "", unsubs = [], meUnsub = null;
const data = { users: [], deals: [], money: {}, tasks: [], suppliers: [], payments: [], expenses: [] };
const state = { view: "", stage: "", q: "", taskWho: "", preset: "thism", from: "", to: "", msg: "", msgBad: false };
{ const r = presetRange("thism"); state.from = r[0]; state.to = r[1]; }
const app = document.getElementById("app");
const modal = document.getElementById("modal");

const is = (...roles) => roles.includes(R);
const isAdmin = () => is("owner", "admin");
const fullTasks = () => is("owner", "admin", "manager", "sales");
const byId = (arr, id) => arr.find(x => x.id === id);
const userName = id => { const u = id && byId(data.users, id); return u ? u.name : (id && user && id === user.uid && me ? me.name : ""); };
const activeStaff = () => data.users.filter(u => u.active && u.role !== "pending").sort((a, b) => String(a.name).localeCompare(String(b.name)));
const dealVal = d => num(data.money[d.id] && data.money[d.id].value);
const dealPaid = d => num(data.money[d.id] && data.money[d.id].paid);
const hasMoney = d => !!data.money[d.id];
function setMsg(m, bad) { state.msg = m || ""; state.msgBad = !!bad; render(); }
function errText(e) {
  if (e && e.code === "permission-denied") return "You don't have permission for this. Ask the owner.";
  if (e && e.code === "unavailable") return "No internet right now. Your change will be sent when you're back online.";
  return "Couldn't save. Check your internet and try again.";
}

// ---------- auth ----------
getRedirectResult(auth).catch(() => {});
async function login() {
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment" || e.code === "auth/cancelled-popup-request")) { await signInWithRedirect(auth, provider); return; }
    if (e && e.code === "auth/popup-closed-by-user") return;
    renderLogin("Sign-in failed (" + esc(e && e.code || "unknown") + "). Try again.");
  }
}
function stopSubs() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; subKey = ""; }
onAuthStateChanged(auth, async u => {
  stopSubs(); if (meUnsub) { meUnsub(); meUnsub = null; }
  user = u; me = null; R = "none";
  Object.assign(data, { users: [], deals: [], money: {}, tasks: [], suppliers: [], payments: [], expenses: [] });
  if (!u) { renderLogin(); return; }
  const ref = doc(db, "users", u.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const boot = u.emailVerified && BOOT_OWNERS.includes(String(u.email || "").toLowerCase());
      let role = boot ? "owner" : "pending";
      if (!boot && u.emailVerified) { try { const inv = await getDoc(doc(db, "invites", String(u.email || "").toLowerCase())); if (inv.exists() && inv.data().role) role = inv.data().role; } catch (e) {} }
      await setDoc(ref, { name: u.displayName || u.email, email: u.email, photo: u.photoURL || "", role, active: role !== "pending", createdAt: nowISO() });
    }
  } catch (e) { renderLogin("Couldn't open your account: " + esc(e.code || "error") + ". Try again."); return; }
  meUnsub = onSnapshot(ref, s => {
    if (!s.exists()) { me = null; R = "none"; render(); return; }
    me = Object.assign({ id: s.id }, s.data());
    R = me.active ? me.role : "pending";
    subscribe();
    render();
  }, () => renderLogin("Couldn't load your account. Reload the app."));
});

// ---------- data subscriptions (by role) ----------
function listen(q, fn) {
  unsubs.push(onSnapshot(q, s => { fn(s); render(); }, e => setMsg("Couldn't load some data (" + (e.code || "error") + "). Reload the app.", true)));
}
const toArr = s => s.docs.map(d => Object.assign({ id: d.id }, d.data()));
function subscribe() {
  const key = R + "|" + (user && user.uid);
  if (key === subKey) return;
  stopSubs(); subKey = key;
  Object.assign(data, { users: [], deals: [], money: {}, tasks: [], suppliers: [], payments: [], expenses: [] });
  if (R === "pending" || R === "none") return;
  const uid = user.uid;
  listen(collection(db, "users"), s => data.users = toArr(s));
  if (is("owner", "admin", "manager", "sales", "marketing")) listen(collection(db, "deals"), s => data.deals = toArr(s));
  if (is("owner", "admin", "manager")) listen(collection(db, "dealMoney"), s => { const m = {}; s.docs.forEach(d => m[d.id] = d.data()); data.money = m; });
  else if (is("sales")) listen(query(collection(db, "dealMoney"), where("ownerUid", "==", uid)), s => { const m = {}; s.docs.forEach(d => m[d.id] = d.data()); data.money = m; });
  if (fullTasks()) listen(collection(db, "tasks"), s => data.tasks = toArr(s));
  else listen(query(collection(db, "tasks"), where("assigneeUid", "==", uid)), s => data.tasks = toArr(s));
  if (isAdmin()) ["suppliers", "payments", "expenses"].forEach(c => listen(collection(db, c), s => data[c] = toArr(s)));
  if (isAdmin()) listen(collection(db, "invites"), s => data.invites = toArr(s));
}

// ---------- tabs ----------
function tabs() {
  if (isAdmin()) return [["dashboard", "Dashboard"], ["calendar", "Calendar"], ["deals", "Customers & Deals"], ["tasks", "Tasks & Deliveries"], ["suppliers", "Suppliers"], ["expenses", "Expenses & Ads"], ["team", "Team & Access"]];
  if (is("manager")) return [["calendar", "Calendar"], ["deals", "Customers & Deals"], ["tasks", "Tasks & Deliveries"]];
  if (is("sales")) return [["tasks", "My Work"], ["calendar", "Calendar"], ["deals", "Customers & Deals"]];
  if (is("marketing")) return [["deals", "Leads"], ["tasks", "My Work"]];
  if (is("supervisor")) return [["tasks", "My Work"], ["calendar", "Calendar"]];
  return [];
}
window.addEventListener("hashchange", render);

// ---------- render ----------
function renderLogin(msg) {
  closeForm();
  app.innerHTML = `<div class="login"><div class="card"><img class="logo" src="icon-192.png" alt=""><h1>RoomVibe HQ</h1>
  <p class="muted">Team app for sales, deliveries and suppliers.</p>
  <button class="btn primary gbtn" id="gl">Sign in with Google</button>
  ${msg ? `<p class="err" style="margin-top:14px">${msg}</p>` : ""}
  <p class="muted" style="font-size:12px;margin-top:18px">New team member? Sign in once, then ask the owner to give you access.</p></div></div>`;
  document.getElementById("gl").onclick = login;
}
function header() {
  const list = tabs(), h = location.hash.replace("#", "");
  state.view = list.some(t => t[0] === h) ? h : (list[0] ? list[0][0] : "");
  return `<header class="top"><div class="wrap"><div class="bar"><div class="brand">RoomVibe HQ <small>${esc(ROLE_LABEL[R] || "")}</small></div>
  <div class="who"><img src="${esc(safeUrl(me && me.photo))}" alt="" referrerpolicy="no-referrer"><span>${esc(me ? me.name : "")}</span><button id="so">Sign out</button></div></div>
  <nav class="tabs" aria-label="Sections">${list.map(([v, l]) => `<a href="#${v}" ${v === state.view ? 'aria-current="page"' : ""}>${esc(l)}</a>`).join("")}</nav></div></header>`;
}
function render() {
  if (!user) return;
  if (!me) { app.innerHTML = `<div class="login"><div class="card"><img class="logo" src="icon-192.png" alt=""><h1>RoomVibe HQ</h1><p class="muted">Opening your account…</p></div></div>`; return; }
  if (R === "pending") {
    app.innerHTML = `<div class="login"><div class="card"><img class="logo" src="icon-192.png" alt=""><h1>Almost there</h1>
    <p>Hi ${esc(me.name)}, your account is created.</p><p class="muted">Ask Irfan to open <strong>Team &amp; Access</strong> and give you a role. This page opens by itself once he does.</p>
    <p class="muted" style="font-size:12px">Signed in as ${esc(me.email)}</p><button class="btn" id="so">Sign out</button></div></div>`;
    document.getElementById("so").onclick = () => signOut(auth); return;
  }
  const keepQ = document.activeElement && document.activeElement.id === "q";
  const hdr = header();
  const fn = { dashboard: vDash, calendar: vCalendar, deals: vDeals, tasks: vTasks, suppliers: vSuppliers, expenses: vExpenses, team: vTeam }[state.view];
  app.innerHTML = hdr + `<main class="wrap">${state.msg ? `<div class="note ${state.msgBad ? "bad" : ""}">${esc(state.msg)}</div>` : ""}<section id="view">${fn ? fn() : ""}</section></main>`;
  document.getElementById("so").onclick = () => signOut(auth);
  if (keepQ) { const q = document.getElementById("q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}
const addBtn = (kind, label) => `<button class="btn primary" data-add="${kind}">+ ${esc(label)}</button>`;
const emptyRow = (span, msg) => `<tr><td colspan="${span}" class="empty">${msg}</td></tr>`;
function stagePill(s) { const cls = s === "Lost" ? "bad" : s === "Delivered" ? "good" : WON.has(s) ? "brand" : s === "Quotation sent" ? "warn" : ""; return `<span class="pill ${cls}">${esc(s || "New lead")}</span>`; }
function rangeBar() {
  const c = state.preset === "custom";
  return `<div class="range"><label for="preset" class="muted">Period</label><select id="preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${state.preset === k ? "selected" : ""}>${l}</option>`).join("")}</select>
  <input type="date" id="from" value="${state.from}" aria-label="From date" ${c ? "" : "hidden"}><input type="date" id="to" value="${state.to}" aria-label="To date" ${c ? "" : "hidden"}>
  <span class="muted">${esc(fmtLong(state.from))} – ${esc(fmtLong(state.to))} · ${daysBetween(state.from, state.to) + 1} days</span></div>`;
}

// ---------- dashboard (owner/admin) ----------
function nums(a, b) {
  const won = data.deals.filter(d => WON.has(d.stage) && inR(d.closeDate, a, b));
  const sales = won.reduce((x, d) => x + dealVal(d), 0);
  const pays = data.payments.filter(p => inR(p.date, a, b)); const supplier = pays.reduce((x, p) => x + num(p.amount), 0);
  const ex = data.expenses.filter(e => inR(e.date, a, b)); const sum = f => ex.filter(f).reduce((x, e) => x + num(e.amount), 0);
  const google = sum(e => e.category === "Google Ads"), meta = sum(e => e.category === "Meta Ads"), other = sum(e => e.category !== "Google Ads" && e.category !== "Meta Ads");
  return { won, sales, pays, supplier, google, meta, other, costs: supplier + google + meta + other, leads: data.deals.filter(d => inR(d.date, a, b)) };
}
function chart(a, b) {
  const days = daysBetween(a, b) + 1, daily = days <= 62, buckets = [];
  if (daily) { for (let i = 0; i < days; i++) { const d = addDays(a, i); buckets.push({ a: d, b: d, lab: String(Number(d.slice(8))) }); } }
  else {
    let d = new Date(a.slice(0, 7) + "-01T00:00:00"); const end = b.slice(0, 7);
    while (iso(d).slice(0, 7) <= end) { const s = iso(d), e = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); buckets.push({ a: s < a ? a : s, b: e > b ? b : e, lab: d.toLocaleDateString("en-GB", { month: "short" }) }); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  }
  const rows = buckets.map(x => { const r = nums(x.a, x.b); return Object.assign(x, { s: r.sales, c: r.costs }); });
  const max = Math.max(1000, ...rows.map(r => Math.max(r.s, r.c)));
  const W = 700, H = 220, L = 40, bw = (W - L - 8) / rows.length, every = Math.ceil(rows.length / 12);
  let svg = `<svg class="bars" viewBox="0 0 ${W} ${H + 26}" role="img" aria-label="Sales and costs by ${daily ? "day" : "month"}">`;
  [0, .5, 1].forEach(f => { const y = H - (H - 14) * f; svg += `<line x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${f ? (max * f >= 1000 ? Math.round(max * f / 1000) + "k" : Math.round(max * f)) : "0"}</text>`; });
  rows.forEach((r, i) => {
    const x = L + 4 + i * bw, w = Math.max(1, (bw - 4) / 2 - 1), hs = (H - 14) * r.s / max, hc = (H - 14) * r.c / max;
    svg += `<rect x="${x}" y="${H - hs}" width="${w}" height="${hs}" fill="var(--brand)"><title>${esc(r.a)} sales ${aed(r.s)}</title></rect><rect x="${x + w + 1}" y="${H - hc}" width="${w}" height="${hc}" fill="var(--accent)"><title>${esc(r.a)} costs ${aed(r.c)}</title></rect>`;
    if (i % every === 0) svg += `<text x="${x + w}" y="${H + 17}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(r.lab)}</text>`;
  });
  return svg + "</svg>";
}
function vDash() {
  const a = state.from, b = state.to, len = daysBetween(a, b) + 1;
  const n = nums(a, b), p = nums(addDays(a, -len), addDays(a, -1));
  const profit = n.sales - n.costs, pprofit = p.sales - p.costs;
  const ch = (x, y) => y ? ((x >= y ? "+" : "") + Math.round((x - y) / Math.abs(y) * 100) + "% vs previous " + len + " days") : "nothing in previous " + len + " days";
  const owed = data.deals.filter(d => WON.has(d.stage)).reduce((x, d) => x + Math.max(0, dealVal(d) - dealPaid(d)), 0);
  const k = (l, v, s, hero) => `<div class="kpi${hero ? " hero" : ""}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const srcRows = SOURCES.map(s => { const c = code(s), L = n.leads.filter(d => code(d.source) === c), W = n.won.filter(d => code(d.source) === c); return { s, leads: L.length, orders: W.length, sales: W.reduce((x, d) => x + dealVal(d), 0) }; }).filter(r => r.leads || r.orders);
  const gL = n.leads.filter(d => ["G1", "G3"].includes(code(d.source))).length, mL = n.leads.filter(d => code(d.source) === "M1").length;
  const people = activeStaff().filter(u => u.role === "sales").map(u => { const L = n.leads.filter(d => d.ownerUid === u.id), W = n.won.filter(d => d.ownerUid === u.id); return { u, leads: L.length, orders: W.length, sales: W.reduce((x, d) => x + dealVal(d), 0) }; });
  const open = data.deals.filter(d => !["Delivered", "Lost"].includes(d.stage));
  const pipe = STAGES.slice(0, 4).map(s => { const L = open.filter(d => (d.stage || "New lead") === s); return { s, c: L.length, v: L.reduce((x, d) => x + dealVal(d), 0) }; });
  const t = today(), due = data.tasks.filter(x => x.status !== "Done" && x.due && x.due <= t).sort((x, y) => x.due < y.due ? -1 : 1);
  return `<div class="row spread"><h2>Business overview</h2><span class="lock">Owner &amp; admin only</span></div>${rangeBar()}
  <div class="kpis">
   ${k("Sales", aed(n.sales), `${n.won.length} orders · ${ch(n.sales, p.sales)}`, 1)}
   ${k("Profit (estimate)", `<span style="color:${profit < 0 ? "var(--bad)" : "inherit"}">${aed(profit)}</span>`, `Sales − suppliers − expenses · ${ch(profit, pprofit)}`)}
   ${k("Paid to suppliers", aed(n.supplier), `${n.pays.length} payments`)}
   ${k("Ads spend", aed(n.google + n.meta), `Google ${aed(n.google)} · Meta ${aed(n.meta)}`)}
   ${k("Other expenses", aed(n.other), "Salaries, transport, rent, other")}
   ${k("New leads", n.leads.length, `${n.leads.length ? Math.round(n.won.length / n.leads.length * 100) : 0}% became orders`)}
   ${k("Still to collect", aed(owed), "All confirmed orders, any date")}
  </div>
  <div class="grid2">
   <div class="panel"><h3>Sales vs costs · by ${len <= 62 ? "day" : "month"}</h3>${chart(a, b)}<div class="legend"><span><i style="background:var(--brand)"></i>Sales</span><span><i style="background:var(--accent)"></i>Suppliers + expenses</span></div></div>
   <div class="panel"><h3>Where customers came from</h3><div class="tbl"><table><thead><tr><th>Source</th><th class="n">Leads</th><th class="n">Orders</th><th class="n">Sales</th></tr></thead><tbody>
    ${srcRows.length ? srcRows.map(r => `<tr><td>${esc(r.s)}</td><td class="n">${r.leads}</td><td class="n">${r.orders}</td><td class="n">${aed(r.sales)}</td></tr>`).join("") : emptyRow(4, "No leads in this period.")}
    </tbody></table></div><p class="muted" style="margin:10px 0 0;font-size:12.5px">Cost per lead: Google (G1+G3) ${gL ? aed(n.google / gL) : "—"} · Meta (M1) ${mL ? aed(n.meta / mL) : "—"}</p></div>
   <div class="panel"><h3>Sales team in this period</h3><div class="tbl"><table><thead><tr><th>Person</th><th class="n">Leads</th><th class="n">Orders</th><th class="n">Sales</th></tr></thead><tbody>
    ${people.length ? people.map(r => `<tr><td>${esc(r.u.name)}</td><td class="n">${r.leads}</td><td class="n">${r.orders}</td><td class="n">${aed(r.sales)}</td></tr>`).join("") : emptyRow(4, "Give someone the Sales role in Team &amp; Access.")}</tbody></table></div></div>
   <div class="panel"><h3>Open pipeline (all dates)</h3><div class="tbl"><table><thead><tr><th>Stage</th><th class="n">Deals</th><th class="n">Value</th></tr></thead><tbody>
    ${pipe.map(x => `<tr><td>${stagePill(x.s)}</td><td class="n">${x.c}</td><td class="n">${aed(x.v)}</td></tr>`).join("")}</tbody></table></div></div>
   <div class="panel"><h3>Deliveries · next 7 days</h3>${(() => { const u = data.tasks.filter(x => x.type === "Delivery" && x.status !== "Done" && x.due && x.due >= t && x.due <= addDays(t, 7)).sort((p, q) => (p.due + (p.time || "")).localeCompare(q.due + (q.time || ""))); return u.length ? u.slice(0, 8).map(taskRow).join("") : `<div class="empty">No deliveries in the next 7 days.</div>`; })()}</div>
   <div class="panel"><h3>Due today or overdue</h3>${due.length ? due.slice(0, 8).map(taskRow).join("") : `<div class="empty">Nothing due.</div>`}</div>
  </div>`;
}

// ---------- deals ----------
const canAddDeal = () => is("owner", "admin", "manager", "sales");
const canEditDeal = d => is("owner", "admin", "manager") || (is("sales") && ["", user.uid].includes(d.ownerUid || ""));
const showMoneyCol = () => is("owner", "admin", "manager", "sales");
function vDeals() {
  const q = state.q.trim().toLowerCase(), mk = is("marketing");
  const chips = is("sales") ? ["Mine", "Open", ...STAGES, "All"] : ["Open", ...STAGES, "All"];
  if (!chips.includes(state.stage)) state.stage = is("sales") ? "Mine" : "Open";
  const test = s => d => s === "All" ? true : s === "Mine" ? d.ownerUid === user.uid : s === "Open" ? !["Delivered", "Lost"].includes(d.stage) : (d.stage || "New lead") === s;
  let list = data.deals.filter(test(state.stage));
  if (q) list = list.filter(d => [d.customer, d.phone, d.area, d.package, userName(d.ownerUid)].some(v => String(v || "").toLowerCase().includes(q)));
  list.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const money = showMoneyCol();
  return `<div class="row spread"><h2>${mk ? "Leads" : "Customers &amp; Deals"}</h2><div class="row"><input id="q" class="search" type="search" placeholder="Search name, phone, area…" value="${esc(state.q)}" aria-label="Search">${canAddDeal() ? addBtn("deals", "New customer") : ""}</div></div>
  <div class="chips">${chips.map(s => `<button class="chip" data-stage="${esc(s)}" aria-pressed="${state.stage === s}">${esc(s)} · ${data.deals.filter(test(s)).length}</button>`).join("")}</div>
  <div class="panel tbl"><table><thead><tr><th>Customer</th><th>Package</th><th>Source</th><th>Stage</th>${money ? `<th class="n">Value</th><th class="n">Balance</th>` : ""}<th>Sales person</th><th>Lead date</th></tr></thead><tbody>
  ${list.length ? list.map(d => { const hm = hasMoney(d), v = dealVal(d), bal = v - dealPaid(d);
    return `<tr class="click" data-edit="deals" data-id="${esc(d.id)}" tabindex="0"><td><strong>${esc(d.customer)}</strong><div class="muted">${esc(mk ? d.area : (d.area || d.phone || ""))}</div></td><td>${esc(d.package)}</td><td><span class="pill">${esc(code(d.source))}</span></td><td>${stagePill(d.stage)}</td>${money ? `<td class="n">${hm && v ? aed(v) : "—"}</td><td class="n">${hm && WON.has(d.stage) && bal > 0 ? `<span style="color:var(--warn)">${aed(bal)}</span>` : "—"}</td>` : ""}<td>${esc(userName(d.ownerUid))}</td><td>${fmtDate(d.date)}</td></tr>`; }).join("")
    : emptyRow(money ? 8 : 6, data.deals.length ? "No deals match this filter." : "No customers yet. Tap “+ New customer” when a WhatsApp or call comes in.")}
  </tbody></table></div>`;
}

// ---------- tasks ----------
function taskRow(x) {
  const t = today(), late = x.status !== "Done" && x.due && x.due < t;
  return `<div class="task"><input type="checkbox" data-done="${esc(x.id)}" ${x.status === "Done" ? "checked" : ""} aria-label="Mark done"><div class="body" data-edit="tasks" data-id="${esc(x.id)}" tabindex="0"><div class="t" style="${x.status === "Done" ? "text-decoration:line-through;opacity:.6" : ""}">${esc(x.title)}</div><div class="m"><span class="pill">${esc(x.type || "Other")}</span> ${esc(userName(x.assigneeUid) || "Unassigned")} · <span style="${late ? "color:var(--bad);font-weight:600" : ""}">${x.due ? (late ? "Overdue · " : "") + fmtDate(x.due) + (x.time ? " · " + esc(fmtTime(x.time)) : "") : "No date"}</span>${x.customer ? " · " + esc(x.customer) + (x.area ? ", " + esc(x.area) : "") + (x.phone ? " · " + esc(x.phone) : "") : ""}</div></div></div>`;
}
function vTasks() {
  const full = fullTasks();
  const who = full ? [["all", "Everyone"], ["mine", "My tasks"], ...activeStaff().map(u => [u.id, u.name])] : [["mine", "My tasks"]];
  if (!who.some(w => w[0] === state.taskWho)) state.taskWho = (is("owner", "admin", "manager") ? "all" : "mine");
  const f = x => state.taskWho === "all" ? true : state.taskWho === "mine" ? x.assigneeUid === user.uid : x.assigneeUid === state.taskWho;
  const open = data.tasks.filter(x => x.status !== "Done" && f(x)).sort((x, y) => (x.due || "9").localeCompare(y.due || "9"));
  const done = data.tasks.filter(x => x.status === "Done" && f(x)).sort((x, y) => (y.doneAt || "").localeCompare(x.doneAt || ""));
  const t = today(), g = { Overdue: open.filter(x => x.due && x.due < t), Today: open.filter(x => x.due === t), Upcoming: open.filter(x => !x.due || x.due > t) };
  return `<div class="row spread"><h2>${is("owner", "admin", "manager") ? "Tasks &amp; Deliveries" : "My Work"}</h2>${full ? addBtn("tasks", "New task") : ""}</div>
  ${who.length > 1 ? `<div class="chips">${who.map(([k, l]) => `<button class="chip" data-who="${esc(k)}" aria-pressed="${state.taskWho === k}">${esc(l)}</button>`).join("")}</div>` : `<div style="height:14px"></div>`}
  ${pushBanner()}<div class="grid2">${Object.entries(g).map(([k, v]) => `<div class="panel"><h3>${k} · ${v.length}</h3>${v.length ? v.map(taskRow).join("") : `<div class="empty">${k === "Overdue" ? "Nothing overdue." : "Nothing here."}</div>`}</div>`).join("")}
  <div class="panel"><h3>Done recently</h3>${done.length ? done.slice(0, 15).map(taskRow).join("") : `<div class="empty">Completed tasks show here.</div>`}</div></div>`;
}

// ---------- suppliers & expenses (owner/admin) ----------
function vSuppliers() {
  const a = state.from, b = state.to;
  const paidAll = id => data.payments.filter(p => p.supplierId === id).reduce((x, p) => x + num(p.amount), 0);
  const paidR = id => data.payments.filter(p => p.supplierId === id && inR(p.date, a, b)).reduce((x, p) => x + num(p.amount), 0);
  const sup = [...data.suppliers].sort((x, y) => paidR(y.id) - paidR(x.id) || String(x.name).localeCompare(String(y.name)));
  const pays = data.payments.filter(p => inR(p.date, a, b)).sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const total = pays.reduce((x, p) => x + num(p.amount), 0);
  return `<div class="row spread"><h2>Suppliers</h2><div class="row">${addBtn("suppliers", "New supplier")}${data.suppliers.length ? addBtn("payments", "Record payment") : ""}</div></div>${rangeBar()}
  <div class="grid2" style="margin-top:12px">
  <div class="panel tbl"><h3>Supplier list</h3><table><thead><tr><th>Supplier</th><th class="n">This period</th><th class="n">All time</th></tr></thead><tbody>
  ${sup.length ? sup.map(s => `<tr class="click" data-edit="suppliers" data-id="${esc(s.id)}" tabindex="0"><td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.category || s.phone || "")}</div></td><td class="n">${aed(paidR(s.id))}</td><td class="n">${aed(paidAll(s.id))}</td></tr>`).join("") : emptyRow(3, "Add your suppliers first, then record each payment.")}
  </tbody></table></div>
  <div class="panel tbl"><h3>Payments · ${aed(total)}</h3><table><thead><tr><th>Date</th><th>Supplier</th><th>For</th><th class="n">Amount</th></tr></thead><tbody>
  ${pays.length ? pays.map(p => { const s = byId(data.suppliers, p.supplierId), d = p.dealId && byId(data.deals, p.dealId); return `<tr class="click" data-edit="payments" data-id="${esc(p.id)}" tabindex="0"><td>${fmtDate(p.date)}</td><td>${esc(s ? s.name : "(removed supplier)")}</td><td>${esc(d ? d.customer : (p.note || ""))}</td><td class="n">${aed(p.amount)}</td></tr>`; }).join("") : emptyRow(4, "No supplier payments in this period.")}
  </tbody></table></div></div>`;
}
function vExpenses() {
  const a = state.from, b = state.to;
  const list = data.expenses.filter(e => inR(e.date, a, b)).sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const by = EXP_CATS.map(c => ({ c, v: list.filter(e => e.category === c).reduce((x, e) => x + num(e.amount), 0) }));
  const tot = by.reduce((x, y) => x + y.v, 0);
  return `<div class="row spread"><h2>Expenses &amp; Ads</h2>${addBtn("expenses", "Add expense")}</div>${rangeBar()}
  <div class="kpis">${by.map(x => `<div class="kpi"><div class="l">${esc(x.c)}</div><div class="v">${aed(x.v)}</div><div class="s">${tot ? Math.round(x.v / tot * 100) : 0}% of period</div></div>`).join("")}</div>
  <div class="panel tbl"><table><thead><tr><th>Date</th><th>Category</th><th>Note</th><th class="n">Amount</th></tr></thead><tbody>
  ${list.length ? list.map(e => `<tr class="click" data-edit="expenses" data-id="${esc(e.id)}" tabindex="0"><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.note)}</td><td class="n">${aed(e.amount)}</td></tr>`).join("") : emptyRow(4, "No expenses in this period. Add ad spend weekly so cost per lead stays correct.")}
  </tbody></table></div>`;
}

// ---------- team & access (owner/admin) ----------
function invitePanel() {
  const roleOpts = R === "owner" ? ["admin", "manager", "sales", "supervisor", "marketing", "owner"] : ["admin", "manager", "sales", "supervisor", "marketing"];
  const inv = (data.invites || []).filter(i => !data.users.some(u => String(u.email || "").toLowerCase() === i.id));
  return `<div class="panel" style="margin-top:16px"><h3>Give access by email</h3>
  <div class="row"><input id="invEmail" type="email" placeholder="Their Gmail address" style="flex:1;min-width:200px" aria-label="Gmail address"><select id="invRole" style="width:auto" aria-label="Role">${roleOpts.map(r => `<option value="${r}" ${r === "supervisor" ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select><button class="btn primary" id="invAdd">Give access</button></div>
  <p class="muted" style="font-size:12.5px;margin:8px 0 0">They get an invitation email within a few minutes. When they sign in with this Gmail, their app opens straight away with this role.</p>
  ${inv.length ? `<div style="margin-top:12px">${inv.map(i => `<div class="row spread" style="padding:8px 0;border-top:1px solid var(--line)"><span style="word-break:break-all">${esc(i.id)} · <span class="pill">${esc(ROLE_LABEL[i.role] || i.role)}</span> <span class="muted">${i.emailSent === true ? "invite email sent" : i.emailSent === "error" ? "email failed, check the address" : "email being sent"} · not signed in yet</span></span><button class="btn danger" data-uninvite="${esc(i.id)}">Remove</button></div>`).join("")}</div>` : ""}</div>`;
}
async function addInvite() {
  const em = (document.getElementById("invEmail").value || "").trim().toLowerCase(), role = document.getElementById("invRole").value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setMsg("Enter a valid Gmail address.", true); return; }
  try {
    const existing = data.users.find(u => String(u.email || "").toLowerCase() === em);
    if (existing) {
      if (existing.id === user.uid) { setMsg("That is your own account.", true); return; }
      await updateDoc(doc(db, "users", existing.id), { role, active: true }); setMsg(existing.name + " is now " + ROLE_LABEL[role] + "."); return;
    }
    await setDoc(doc(db, "invites", em), { role, invitedBy: user.uid, createdAt: nowISO() });
    setMsg(em + " can now sign in as " + ROLE_LABEL[role] + ".");
  } catch (err) { setMsg(errText(err), true); }
}
function vTeam() {
  const order = u => u.role === "pending" ? 0 : u.active ? 1 : 2;
  const list = [...data.users].sort((a, b) => order(a) - order(b) || String(a.name).localeCompare(String(b.name)));
  const roleOpts = R === "owner" ? ["owner", "admin", "manager", "sales", "supervisor", "marketing"] : ["admin", "manager", "sales", "supervisor", "marketing"];
  const pending = list.filter(u => u.role === "pending").length;
  const card = u => {
    const self = u.id === user.uid, locked = self || (R === "admin" && u.role === "owner");
    const cur = u.role === "pending" ? "" : u.role;
    return `<div class="member ${u.role === "pending" ? "pending" : ""}"><div class="top"><img src="${esc(safeUrl(u.photo))}" alt="" referrerpolicy="no-referrer"><div style="min-width:0"><div class="nm">${esc(u.name)}${self ? " (you)" : ""}</div><div class="em">${esc(u.email)}</div></div></div>
    ${locked ? `<div><span class="pill brand">${esc(ROLE_LABEL[u.role] || u.role)}</span></div>` :
      `<div class="row"><select data-role="${esc(u.id)}" aria-label="Role for ${esc(u.name)}"><option value="" ${cur ? "" : "selected"} disabled>Choose role…</option>${roleOpts.map(r => `<option value="${r}" ${cur === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select></div>
       <div class="muted" style="font-size:12px">${esc(ROLE_HELP[cur] || "New sign-in. Choose a role to give access.")}</div>
       <div class="row">${u.role === "pending" ? "" : `<button class="btn ${u.active ? "danger" : ""}" data-toggle="${esc(u.id)}">${u.active ? "Turn off access" : "Turn access back on"}</button>`}</div>`}
    ${!u.active && u.role !== "pending" ? `<div class="muted" style="font-size:12px">Access is off.</div>` : ""}</div>`;
  };
  return `<div class="row spread"><h2>Team &amp; Access</h2>${pending ? `<span class="pill warn">${pending} waiting for access</span>` : ""}</div>
  ${invitePanel()}<div class="members">${list.map(card).join("")}</div>
  <div class="grid2" style="margin-top:18px">
   <div class="panel"><h3>Add a new team member</h3><ol class="steps">
    <li>Send them the app link.</li>
    <li>They tap <strong>Sign in with Google</strong> with their own Gmail.</li>
    <li>Their name appears here with “Waiting for access”.</li>
    <li>Choose their role. Their app opens by itself.</li>
    <li>On the phone: Chrome menu → <strong>Install app</strong> (iPhone Safari: Share → <strong>Add to Home Screen</strong>).</li></ol></div>
   <div class="panel"><h3>Roles</h3><ol class="steps">${["owner", "admin", "manager", "sales", "supervisor", "marketing"].map(r => `<li><strong>${ROLE_LABEL[r]}:</strong> ${esc(ROLE_HELP[r])}</li>`).join("")}</ol>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Someone leaves? Tap “Turn off access”. Their work stays in the app.</p></div>
  </div>`;
}

// ---------- calendar ----------
const calCss = document.createElement("style");
calCss.textContent = `
.cal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 14px}
.cal-head h2{min-width:160px;text-align:center}
.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.cal .dow{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);text-align:center;padding:4px 0}
.cal .day{background:var(--surface);border:1px solid var(--line);border-radius:8px;min-height:88px;padding:6px;cursor:pointer;display:flex;flex-direction:column;gap:4px;text-align:left;font:inherit;color:inherit;min-width:0}
.cal .day.out{opacity:.35}
.cal .day.today{border-color:var(--accent);border-width:2px}
.cal .day.sel{outline:2px solid var(--brand);outline-offset:1px}
.cal .num{font-weight:700;font-size:13px}
.cal .chip2{font-size:11px;border-radius:5px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal .c-del{background:var(--brand);color:var(--brand-ink)}
.cal .c-vis{background:var(--soft);color:var(--ink);border:1px solid var(--line)}
.cal .c-deal{background:var(--accent);color:#fff}
.legend2{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}
.legend2 i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.items{display:grid;gap:6px}
.items .it{display:grid;grid-template-columns:1fr 70px 1fr 44px;gap:6px}
.items .it input{padding:7px 8px}
.itemlist{margin:4px 0 0;padding-left:18px}
@media (max-width:560px){.cal{gap:3px}.cal .day{min-height:56px;padding:4px;gap:3px}.cal .chip2{font-size:0;padding:0;height:6px;border-radius:3px}.items .it{grid-template-columns:1fr 60px}}
`;
document.head.appendChild(calCss);
function monthAdd(ym, k) { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + k, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
function calEntries(date) {
  const tasks = data.tasks.filter(t => t.due === date);
  const deals = is("supervisor", "marketing") ? [] : data.deals.filter(d => d.closeDate === date && WON.has(d.stage));
  return { tasks, deals };
}
function vCalendar() {
  if (!state.calMonth) state.calMonth = today().slice(0, 7);
  if (!state.calDay) state.calDay = today();
  const ym = state.calMonth, [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1), lead = (first.getDay() + 6) % 7, start = addDays(iso(first), -lead), t = today();
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i % 7 === 0 && i > 0 && d.slice(0, 7) !== ym) break;
    const e = calEntries(d), del = e.tasks.filter(x => x.type === "Delivery"), oth = e.tasks.filter(x => x.type !== "Delivery");
    const chips = (del.length ? `<span class="chip2 c-del">${del.length} deliver${del.length > 1 ? "ies" : "y"}</span>` : "")
      + (oth.length ? `<span class="chip2 c-vis">${oth.length} visit${oth.length > 1 ? "s" : ""}</span>` : "")
      + (e.deals.length ? `<span class="chip2 c-deal">${e.deals.length} deal${e.deals.length > 1 ? "s" : ""} done</span>` : "");
    cells += `<button class="day ${d.slice(0, 7) !== ym ? "out" : ""} ${d === t ? "today" : ""} ${d === state.calDay ? "sel" : ""}" data-day="${d}" aria-label="${esc(fmtLong(d))}"><span class="num">${Number(d.slice(8))}</span>${chips}</button>`;
  }
  const title = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return `<div class="cal-head"><button class="btn" data-cal="-1" aria-label="Previous month">‹</button><h2>${esc(title)}</h2><button class="btn" data-cal="1" aria-label="Next month">›</button><button class="btn" data-cal="0">Today</button></div>
  <div class="cal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<div class="dow">${x}</div>`).join("")}${cells}</div>
  <div class="legend2"><span><i style="background:var(--brand)"></i>Delivery</span><span><i style="background:var(--soft);border:1px solid var(--line)"></i>Site visit / task</span>${is("supervisor", "marketing") ? "" : `<span><i style="background:var(--accent)"></i>Deal done</span>`}</div>
  ${dayPanel(state.calDay)}`;
}
function dayPanel(date) {
  const e = calEntries(date), canAdd = fullTasks();
  const tasks = e.tasks.slice().sort((p, q) => (p.time || "99").localeCompare(q.time || "99"));
  return `<div class="panel" style="margin-top:16px"><div class="row spread"><h2>${esc(fmtLong(date))}</h2>${canAdd ? `<button class="btn primary" data-newdel="${date}">+ Add delivery / deal</button>` : ""}</div>
  ${tasks.length ? `<div style="margin-top:8px">${tasks.map(taskRow).join("")}</div>` : `<div class="empty">${canAdd ? "Nothing on this day. Tap “+ Add delivery / deal” to add one." : "Nothing on this day."}</div>`}
  ${e.deals.length ? `<h3 style="margin-top:16px">Deals done this day</h3>${e.deals.map(d => `<div class="task"><div class="body" data-edit="deals" data-id="${esc(d.id)}" tabindex="0"><div class="t">${esc(d.customer)}${d.package ? " · " + esc(d.package) : ""}</div><div class="m">${stagePill(d.stage)} ${esc(userName(d.ownerUid))}${hasMoney(d) ? " · " + aed(dealVal(d)) : ""}</div></div></div>`).join("")}` : ""}</div>`;
}
function itemRow(i, disabled) {
  const dis = disabled ? "disabled" : "";
  return `<div class="it"><input class="in" placeholder="Item (e.g. 3-seater sofa)" value="${esc(i.name || "")}" ${dis} aria-label="Item"><input class="iq" type="number" min="1" inputmode="numeric" placeholder="Qty" value="${esc(i.qty || "")}" ${dis} aria-label="Quantity"><input class="nt" placeholder="Colour / size / note" value="${esc(i.note || "")}" ${dis} aria-label="Item note">${disabled ? "<span></span>" : `<button type="button" class="btn" data-delitem aria-label="Remove item">✕</button>`}</div>`;
}
function itemsEditor(items, disabled) {
  const list = Array.isArray(items) && items.length ? items : [{}];
  return `<div class="items" id="itemsBox">${list.map(i => itemRow(i, disabled)).join("")}</div>${disabled ? "" : `<button type="button" class="btn" id="addItem" style="margin-top:6px;align-self:flex-start">+ Add item</button>`}`;
}
function readItems() {
  return [...document.querySelectorAll("#itemsBox .it")].map(r => ({ name: r.querySelector(".in").value.trim(), qty: num(r.querySelector(".iq").value) || 1, note: r.querySelector(".nt").value.trim() })).filter(i => i.name).slice(0, 60);
}
function itemsHtml(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<div><span class="muted">Items:</span><ul class="itemlist">${items.map(i => `<li>${esc(i.qty || 1)} × ${esc(i.name)}${i.note ? " — " + esc(i.note) : ""}</li>`).join("")}</ul></div>`;
}
function openDelivery(date) {
  const moneyOK = is("owner", "admin", "manager", "sales");
  const F = [
    { k: "customer", l: "Customer name", t: "text", req: 1 },
    { k: "phone", l: "Customer phone", t: "tel" },
    { k: "area", l: "Area / building / unit", t: "text" },
    { k: "location", l: "Google Maps link or full address", t: "text", wide: 1 },
    { k: "package", l: "Package", t: "text", list: PACKAGES },
    { k: "source", l: "Source (ref code)", t: "select", opts: SOURCES, def: "Unknown" },
    { k: "items", l: "Items to deliver", t: "items", wide: 1 },
    { k: "quoteUrl", l: "Quotation link (Google Drive / PDF)", t: "url", wide: 1 },
    { k: "due", l: "Delivery date", t: "date", def: date },
    { k: "time", l: "Delivery time", t: "time" },
    { k: "assigneeUid", l: "Supervisor", t: "user", roles: ["supervisor", "manager", "admin", "owner"] },
    { k: "closeDate", l: "Deal confirmed on", t: "date", def: today() },
    ...(moneyOK ? [{ k: "value", l: "Deal value (AED)", t: "num" }, { k: "paid", l: "Received so far (AED)", t: "num" }] : []),
    { k: "notes", l: "Notes for supervisor", t: "area" }];
  modal.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><div class="row spread"><h2 id="mt">New delivery · ${esc(fmtLong(date))}</h2><button class="btn" data-close="1" aria-label="Close">✕</button></div>
  <p class="muted" style="margin:6px 0 0">Saves the customer deal and puts the delivery on the supervisor's calendar.</p>
  <form id="frm" class="form">${F.map(f => fieldHtml(f, f.def || (f.t === "items" ? [] : ""), false)).join("")}</form><div class="err" id="ferr"></div>
  <div class="row spread" style="margin-top:8px"><span></span><div class="row"><button class="btn" data-close="1" type="button">Cancel</button><button class="btn primary" id="sv" type="button">Save delivery</button></div></div></div></div>`;
  modal.hidden = false;
  document.getElementById("f_customer").focus();
  const sv = document.getElementById("sv"), err = document.getElementById("ferr");
  sv.onclick = async () => {
    const v = {};
    for (const f of F) {
      if (f.t === "items") { v.items = readItems(); continue; }
      const el = document.getElementById("f_" + f.k); let x = el.value.trim(); if (f.t === "num") x = x === "" ? "" : num(x);
      v[f.k] = x;
      if (f.req && !x) { err.textContent = f.l + " is required."; el.focus(); return; }
    }
    if (!v.due) { err.textContent = "Delivery date is required."; return; }
    sv.disabled = true; sv.textContent = "Saving…"; err.textContent = "";
    try {
      const stamp = { updatedAt: nowISO(), updatedBy: user.uid }, owner = is("sales") ? user.uid : "";
      const dealId = doc(collection(db, "deals")).id;
      await setDoc(doc(db, "deals", dealId), Object.assign({ customer: v.customer, phone: v.phone, area: v.area, location: v.location, package: v.package, source: v.source, items: v.items, quoteUrl: v.quoteUrl, stage: "Delivery scheduled", ownerUid: owner, date: v.closeDate || today(), closeDate: v.closeDate || today(), deliveryDate: v.due, notes: v.notes, createdAt: nowISO(), createdBy: user.uid }, stamp));
      if (moneyOK && (v.value !== "" || v.paid !== "")) await setDoc(doc(db, "dealMoney", dealId), { value: v.value === "" ? 0 : v.value, paid: v.paid === "" ? 0 : v.paid, ownerUid: owner, updatedAt: stamp.updatedAt });
      const title = ("Delivery: " + (v.package || (v.items[0] && v.items[0].name) || "order") + " — " + v.customer).slice(0, 120);
      await setDoc(doc(collection(db, "tasks")), Object.assign({ title, type: "Delivery", assigneeUid: v.assigneeUid, due: v.due, time: v.time, dealId, customer: v.customer, phone: v.phone, area: v.area, location: v.location, items: v.items, quoteUrl: v.quoteUrl, notes: v.notes, status: "Open", report: "", doneAt: "", notified: false, remindEve: false, remindDay: false, createdAt: nowISO(), createdBy: user.uid }, stamp));
      closeForm(); state.calDay = v.due; state.calMonth = v.due.slice(0, 7); setMsg("Delivery saved for " + fmtLong(v.due) + ".");
    } catch (e) { sv.disabled = false; sv.textContent = "Save delivery"; err.textContent = errText(e); }
  };
}

// ---------- forms ----------
const SCHEMAS = {
  deals: { label: "customer / deal", fields: [
    { k: "customer", l: "Customer name", t: "text", req: 1 },
    { k: "phone", l: "Phone / WhatsApp", t: "text" },
    { k: "area", l: "Area / building", t: "text" },
    { k: "package", l: "Package or items", t: "text", list: PACKAGES },
    { k: "source", l: "Source (ref code)", t: "select", opts: SOURCES, def: "Unknown" },
    { k: "stage", l: "Stage", t: "select", opts: STAGES, def: "New lead" },
    { k: "value", l: "Deal value (AED)", t: "num", money: 1 },
    { k: "paid", l: "Received so far (AED)", t: "num", money: 1 },
    { k: "items", l: "Items", t: "items", wide: 1 },
    { k: "quoteUrl", l: "Quotation link (Google Drive / PDF)", t: "url", wide: 1 },
    { k: "ownerUid", l: "Sales person", t: "user", roles: ["sales", "manager", "admin", "owner"], def: () => is("sales") ? user.uid : "" },
    { k: "date", l: "Lead date", t: "date", def: today },
    { k: "closeDate", l: "Order confirmed on", t: "date", hint: "Fills itself when stage moves to Advance paid" },
    { k: "deliveryDate", l: "Delivery date", t: "date" },
    { k: "notes", l: "Notes", t: "area" }] },
  tasks: { label: "visit / task", fields: [
    { k: "title", l: "What needs doing", t: "text", req: 1, wide: 1 },
    { k: "type", l: "Type", t: "select", opts: TASK_TYPES, def: "Site visit" },
    { k: "assigneeUid", l: "Assigned to", t: "user" },
    { k: "due", l: "Date", t: "date", def: today },
    { k: "time", l: "Time", t: "time" },
    { k: "dealId", l: "Pick existing customer (optional)", t: "deal", hint: "Fills name, phone and area below when they are empty" },
    { k: "customer", l: "Customer name", t: "text" },
    { k: "phone", l: "Customer phone", t: "tel" },
    { k: "area", l: "Area / building / unit", t: "text" },
    { k: "location", l: "Google Maps link or full address", t: "text", wide: 1 },
    { k: "items", l: "Items to deliver", t: "items", wide: 1 },
    { k: "quoteUrl", l: "Quotation link (Google Drive / PDF)", t: "url", wide: 1 },
    { k: "notes", l: "Details / what to do", t: "area" },
    { k: "status", l: "Status", t: "select", opts: ["Open", "Done"], def: "Open" },
    { k: "report", l: "Report from site", t: "area" }] },
  suppliers: { label: "supplier", fields: [
    { k: "name", l: "Supplier name", t: "text", req: 1 },
    { k: "phone", l: "Phone", t: "text" },
    { k: "category", l: "What they supply", t: "text", wide: 1 },
    { k: "notes", l: "Notes", t: "area" }] },
  payments: { label: "supplier payment", fields: [
    { k: "supplierId", l: "Supplier", t: "supplier", req: 1 },
    { k: "amount", l: "Amount (AED)", t: "num", req: 1 },
    { k: "date", l: "Paid on", t: "date", def: today },
    { k: "method", l: "Method", t: "select", opts: PAY_METHODS, def: "Bank transfer" },
    { k: "dealId", l: "For customer (optional)", t: "deal" },
    { k: "note", l: "Note", t: "area" }] },
  expenses: { label: "expense", fields: [
    { k: "category", l: "Category", t: "select", opts: EXP_CATS, def: "Google Ads" },
    { k: "amount", l: "Amount (AED)", t: "num", req: 1 },
    { k: "date", l: "Date", t: "date", def: today },
    { k: "note", l: "Note", t: "area" }] }
};
function fieldHtml(f, val, disabled) {
  const fid = "f_" + f.k, dis = disabled ? "disabled" : ""; let inp;
  if (f.t === "select") inp = `<select id="${fid}" ${dis}>${f.opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  else if (f.t === "items") inp = itemsEditor(val, disabled);
  else if (f.t === "area") inp = `<textarea id="${fid}" ${dis}>${esc(val)}</textarea>`;
  else if (f.t === "deal") inp = `<select id="${fid}" ${dis}><option value="">— none —</option>${[...data.deals].sort((x, y) => String(x.customer).localeCompare(String(y.customer))).map(d => `<option value="${esc(d.id)}" ${d.id === val ? "selected" : ""}>${esc(d.customer)}${d.area ? " · " + esc(d.area) : ""}</option>`).join("")}</select>`;
  else if (f.t === "user") { const us = activeStaff().filter(u => !f.roles || f.roles.includes(u.role)); inp = `<select id="${fid}" ${dis}><option value="">— unassigned —</option>${us.map(u => `<option value="${esc(u.id)}" ${u.id === val ? "selected" : ""}>${esc(u.name)} · ${esc(ROLE_LABEL[u.role] || "")}</option>`).join("")}</select>`; }
  else if (f.t === "supplier") inp = `<select id="${fid}" ${dis}><option value="">Choose supplier</option>${data.suppliers.map(s => `<option value="${esc(s.id)}" ${s.id === val ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`;
  else inp = `<input id="${fid}" type="${f.t === "num" ? "number" : f.t}" ${f.t === "num" ? 'inputmode="decimal" min="0" step="any"' : ""} value="${esc(val)}" ${f.list ? `list="dl_${f.k}"` : ""} ${dis}>${f.list ? `<datalist id="dl_${f.k}">${f.list.map(o => `<option value="${esc(o)}">`).join("")}</datalist>` : ""}`;
  return `<div class="f ${f.wide || f.t === "area" ? "wide" : ""}"><label for="${fid}">${esc(f.l)}${f.req ? " *" : ""}</label>${inp}${f.hint ? `<span class="muted" style="font-size:11.5px">${esc(f.hint)}</span>` : ""}</div>`;
}
function mapUrl(t) {
  const l = String(t.location || "").trim();
  if (l.startsWith("https://")) return l;
  const q = l || t.area || "";
  return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q + (l ? "" : ", UAE")) : "";
}
function waNum(tel) { let n = tel.replace(/^\+/, ""); if (/^0\d{9}$/.test(n)) n = "971" + n.slice(1); return n; }
function taskDetail(t) {
  const tel = String(t.phone || "").replace(/[^\d+]/g, ""), map = mapUrl(t), a = 'style="text-decoration:none"';
  const line = (k, v) => v ? `<div><span class="muted">${k}:</span> ${esc(v)}</div>` : "";
  return `<div class="detail"><div class="row spread"><strong>${esc(t.type || "Task")} · ${t.due ? esc(fmtLong(t.due)) : "No date"}${t.time ? " · " + esc(fmtTime(t.time)) : ""}</strong><span class="pill">${esc(userName(t.assigneeUid) || "Unassigned")}</span></div>
  ${line("Customer", t.customer)}${line("Phone", t.phone)}${line("Area", t.area)}${t.location ? `<div style="word-break:break-all"><span class="muted">Location:</span> ${esc(t.location)}</div>` : ""}${line("Details", t.notes)}${itemsHtml(t.items)}
  <div class="row" style="margin-top:6px">${tel ? `<a class="btn" ${a} href="tel:${esc(tel)}">Call</a><a class="btn" ${a} href="https://wa.me/${esc(waNum(tel))}" target="_blank" rel="noopener">WhatsApp</a>` : ""}${String(t.quoteUrl || "").startsWith("https://") ? `<a class="btn" ${a} href="${esc(t.quoteUrl)}" target="_blank" rel="noopener">Quotation</a>` : ""}${map ? `<a class="btn primary" ${a} href="${esc(map)}" target="_blank" rel="noopener">Open map</a>` : ""}</div></div>`;
}
let pushState = "";
function pushIsOn() { let t = ""; try { t = localStorage.getItem("rvhq-push") || ""; } catch (e) {} return pushState === "on" || (window.Notification && Notification.permission === "granted" && t && me && (me.fcmTokens || []).includes(t)); }
function pushBanner() {
  if (!VAPID_KEY || pushIsOn()) return "";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent), standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (ios && !standalone) return `<div class="note">iPhone: open this app in Safari, tap Share → Add to Home Screen, open it from the home screen, then turn on notifications here.</div>`;
  if (pushState === "unsupported" || !("Notification" in window)) return `<div class="note">This browser can't show notifications. Use Chrome on Android, or the installed app on iPhone.</div>`;
  if (pushState === "denied" || Notification.permission === "denied") return `<div class="note bad">Notifications are blocked for this app. Allow them in your phone or browser settings for this site, then reload.</div>`;
  return `<div class="note row spread"><span>Get a phone alert when a visit or delivery is given to you.</span><button class="btn primary" id="pushOn" ${pushState === "working" ? "disabled" : ""}>${pushState === "working" ? "Turning on…" : "Turn on notifications"}</button></div>`;
}
async function enablePush() {
  pushState = "working"; render();
  try {
    if (!("Notification" in window) || !(await isSupported())) { pushState = "unsupported"; render(); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { pushState = "denied"; render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw new Error("no token");
    await updateDoc(doc(db, "users", user.uid), { fcmTokens: arrayUnion(token) });
    try { localStorage.setItem("rvhq-push", token); } catch (e) {}
    pushState = "on"; setMsg("Notifications are on for this device.");
  } catch (e) { pushState = "error"; setMsg("Couldn't turn on notifications (" + (e.code || e.message || "error") + "). Try again.", true); }
}
function openForm(kind, id) {
  const sc = SCHEMAS[kind]; if (!sc) return;
  const src = kind === "deals" ? data.deals : data[kind];
  const rec = id ? byId(src, id) : null; if (id && !rec) return;
  let fields = sc.fields, editable, limited = false, canDelete = false;
  if (kind === "deals") {
    editable = rec ? canEditDeal(rec) : canAddDeal();
    const moneyOK = is("owner", "admin", "manager") || (is("sales") && (!rec || hasMoney(rec) || ["", user.uid].includes(rec.ownerUid || "")));
    fields = fields.filter(f => !f.money || moneyOK);
    if (is("sales")) fields = fields.map(f => f.k === "ownerUid" ? Object.assign({}, f, { fixed: 1 }) : f);
    canDelete = rec && isAdmin();
  } else if (kind === "tasks") {
    editable = fullTasks(); limited = !editable && rec && rec.assigneeUid === user.uid;
    canDelete = rec && is("owner", "admin", "manager");
  } else { editable = isAdmin(); canDelete = rec && isAdmin(); }
  const values = {};
  fields.forEach(f => { let v = rec ? (f.money ? (data.money[rec.id] || {})[f.k] : rec[f.k]) : (typeof f.def === "function" ? f.def() : f.def); values[f.k] = v == null ? "" : v; });
  const lim = new Set(["status", "report"]);
  const body = fields.map(f => fieldHtml(f, values[f.k], !(editable || (limited && lim.has(f.k))) || f.fixed)).join("");
  const detail = kind === "tasks" && rec ? taskDetail(rec) : "";
  const canSave = editable || limited;
  modal.innerHTML = `<div class="scrim" data-close="1"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt"><div class="row spread"><h2 id="mt">${rec ? (canSave ? "Edit" : "View") : "New"} ${esc(sc.label)}</h2><button class="btn" data-close="1" aria-label="Close">✕</button></div>
  ${detail}<form id="frm" class="form">${body}</form><div class="err" id="ferr"></div>
  <div class="row spread" style="margin-top:8px">${canDelete ? `<button class="btn danger" id="del" type="button">Delete</button>` : "<span></span>"}<div class="row"><button class="btn" data-close="1" type="button">${canSave ? "Cancel" : "Close"}</button>${canSave ? `<button class="btn primary" id="sv" type="button">Save</button>` : ""}</div></div></div></div>`;
  modal.hidden = false;
  const first = modal.querySelector("input:not([disabled]),select:not([disabled]),textarea:not([disabled])"); first && first.focus();
  const err = document.getElementById("ferr"), sv = document.getElementById("sv"), del = document.getElementById("del");
  if (sv) sv.onclick = async () => {
    const vals = {};
    for (const f of fields) {
      if (f.t === "items") { vals[f.k] = editable ? readItems() : (values[f.k] || []); continue; }
      const el = document.getElementById("f_" + f.k); let v = el.value.trim(); if (f.t === "num") v = v === "" ? "" : num(v);
      if (f.fixed) v = values[f.k] || (is("sales") ? user.uid : "");
      vals[f.k] = v;
      if (f.req && (v === "" || v == null) && !el.disabled) { err.textContent = f.l + " is required."; el.focus(); return; }
    }
    sv.disabled = true; sv.textContent = "Saving…"; err.textContent = "";
    try { await saveRecord(kind, rec, vals, limited); closeForm(); }
    catch (e) { sv.disabled = false; sv.textContent = "Save"; err.textContent = errText(e); }
  };
  if (del) del.onclick = async () => {
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Tap again to delete"; return; }
    del.disabled = true;
    try {
      await deleteDoc(doc(db, kind, rec.id));
      if (kind === "deals" && hasMoney(rec)) await deleteDoc(doc(db, "dealMoney", rec.id));
      closeForm();
    } catch (e) { del.disabled = false; err.textContent = errText(e); }
  };
}
async function saveRecord(kind, rec, vals, limited) {
  const stamp = { updatedAt: nowISO(), updatedBy: user.uid };
  if (kind === "tasks" && limited) {
    await updateDoc(doc(db, "tasks", rec.id), Object.assign({ status: vals.status, report: vals.report, doneAt: vals.status === "Done" ? (rec.doneAt || nowISO()) : "" }, stamp));
    return;
  }
  const id = rec ? rec.id : doc(collection(db, kind)).id;
  const base = rec ? Object.assign({}, rec) : { createdAt: nowISO(), createdBy: user.uid };
  delete base.id;
  if (kind === "deals") {
    const money = { value: vals.value, paid: vals.paid };
    delete vals.value; delete vals.paid;
    const body = Object.assign(base, vals, stamp);
    body.ownerUid = body.ownerUid || "";
    if (WON.has(body.stage) && !body.closeDate) body.closeDate = today();
    await setDoc(doc(db, "deals", id), body);
    if (money.value !== undefined) {
      const owner = is("sales") ? user.uid : body.ownerUid;
      await setDoc(doc(db, "dealMoney", id), { value: money.value === "" ? 0 : money.value, paid: money.paid === "" ? 0 : money.paid, ownerUid: owner, updatedAt: stamp.updatedAt });
    }
    return;
  }
  if (kind === "tasks") {
    const d = vals.dealId && byId(data.deals, vals.dealId);
    if (d) { if (!vals.customer) vals.customer = d.customer || ""; if (!vals.phone) vals.phone = d.phone || ""; if (!vals.area) vals.area = d.area || ""; }
    vals.doneAt = vals.status === "Done" ? (base.doneAt || nowISO()) : "";
    const changed = !rec || ["due", "time", "assigneeUid", "location", "area", "customer"].some(k => String(rec[k] || "") !== String(vals[k] || ""));
    if (changed && vals.status !== "Done") Object.assign(vals, { notified: false, remindEve: false, remindDay: false });
  }
  await setDoc(doc(db, kind, id), Object.assign(base, vals, stamp));
}
function closeForm() { modal.hidden = true; modal.innerHTML = ""; }
modal.addEventListener("click", e => {
  if (e.target.dataset && e.target.dataset.close) { closeForm(); return; }
  if (e.target.id === "addItem") { document.getElementById("itemsBox").insertAdjacentHTML("beforeend", itemRow({}, false)); const r = document.querySelectorAll("#itemsBox .it .in"); r[r.length - 1].focus(); return; }
  const di = e.target.closest("[data-delitem]");
  if (di) { const box = document.getElementById("itemsBox"); if (box.children.length > 1) di.closest(".it").remove(); else di.closest(".it").querySelectorAll("input").forEach(x => x.value = ""); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !modal.hidden) closeForm();
  if ((e.key === "Enter" || e.key === " ") && e.target.dataset && e.target.dataset.edit && modal.hidden) { e.preventDefault(); openForm(e.target.dataset.edit, e.target.dataset.id); }
});

// ---------- events ----------
app.addEventListener("click", async e => {
  if (e.target.closest("#pushOn")) { enablePush(); return; }
  if (e.target.closest("#invAdd")) { addInvite(); return; }
  const cb = e.target.closest("[data-cal]");
  if (cb) { const k = Number(cb.dataset.cal); state.calMonth = k ? monthAdd(state.calMonth || today().slice(0, 7), k) : today().slice(0, 7); if (!k) state.calDay = today(); render(); return; }
  const dd = e.target.closest("[data-day]");
  if (dd) { state.calDay = dd.dataset.day; state.calMonth = dd.dataset.day.slice(0, 7); render(); return; }
  const nd = e.target.closest("[data-newdel]");
  if (nd) { openDelivery(nd.dataset.newdel); return; }
  const ui = e.target.closest("[data-uninvite]");
  if (ui) { if (!ui.classList.contains("armed")) { ui.classList.add("armed"); ui.textContent = "Tap again to remove"; return; } try { await deleteDoc(doc(db, "invites", ui.dataset.uninvite)); } catch (err) { setMsg(errText(err), true); } return; }
  const t = e.target.closest("[data-add],[data-edit],[data-stage],[data-who],[data-done],[data-toggle]"); if (!t) return;
  if (t.dataset.done !== undefined) {
    const x = byId(data.tasks, t.dataset.done); if (!x) return; t.disabled = true;
    try { await updateDoc(doc(db, "tasks", x.id), { status: t.checked ? "Done" : "Open", doneAt: t.checked ? nowISO() : "", updatedAt: nowISO(), updatedBy: user.uid }); }
    catch (err) { t.checked = !t.checked; t.disabled = false; setMsg(errText(err), true); }
    return;
  }
  if (t.dataset.toggle) {
    const u = byId(data.users, t.dataset.toggle); if (!u) return;
    if (u.active && !t.classList.contains("armed")) { t.classList.add("armed"); t.textContent = "Tap again to turn off"; return; }
    t.disabled = true;
    try { await updateDoc(doc(db, "users", u.id), { active: !u.active }); } catch (err) { t.disabled = false; setMsg(errText(err), true); }
    return;
  }
  if (t.dataset.add) openForm(t.dataset.add);
  else if (t.dataset.edit) openForm(t.dataset.edit, t.dataset.id);
  else if (t.dataset.stage) { state.stage = t.dataset.stage; render(); }
  else if (t.dataset.who) { state.taskWho = t.dataset.who; render(); }
});
app.addEventListener("input", e => { if (e.target.id === "q") { state.q = e.target.value; render(); } });
app.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "preset") { state.preset = t.value; const r = presetRange(state.preset); if (r) { state.from = r[0]; state.to = r[1]; } render(); }
  else if (t.id === "from" || t.id === "to") { if (!t.value) return; state[t.id] = t.value; if (state.from > state.to) { const x = state.from; state.from = state.to; state.to = x; } render(); }
  else if (t.dataset && t.dataset.role) {
    const u = byId(data.users, t.dataset.role); if (!u || !t.value) return; t.disabled = true;
    try { await updateDoc(doc(db, "users", u.id), { role: t.value, active: true }); setMsg(u.name + " is now " + ROLE_LABEL[t.value] + "."); }
    catch (err) { t.disabled = false; setMsg(errText(err), true); }
  }
});
