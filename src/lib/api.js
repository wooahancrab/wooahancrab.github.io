// 화면은 이 파일의 api 객체만 쓴다. 키가 없으면 데모(localStorage), 있으면 Supabase.
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "../config.js";
import { summarize, defaultData } from "./report.js";
import { todayKST, addDays, dow } from "./kst.js";
import { attDemo } from "./att-demo.js";
import { claimsDemo } from "./claims-demo.js";

export const isDemo = !(SUPABASE_URL && SUPABASE_ANON_KEY);

// 대표가 지금 보고 있는 사업장. 대표가 호출하는 서버 함수·조회에 함께 실린다. (직원·매니저는 서버가 자기 사업장으로 고정)
let curStore = null;

const LS = {
  get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

function rowFrom(date, data, extra = {}) {
  const s = summarize(data);
  return {
    report_date: date, data,
    has_claim: s.has_claim, incomplete: s.incomplete,
    late_count: s.late_count, absent_count: s.absent_count,
    submitted_at: new Date().toISOString(), ...extra,
  };
}

/* ---------------- 데모 ---------------- */
const DEMO_STORES = [
  { id: "demo-gejang", name: "본촌점", display_name: "우아한게장 본촌점", kind: "restaurant", app_key: "gejang" },
  { id: "demo-ck", name: "우아한CK", display_name: "우아한CK", kind: "ck", app_key: "ck" },
  { id: "demo-fnb", name: "우아한F&B", display_name: "우아한F&B", kind: "hq", app_key: "fnb" },
];
const demo = {
  async getProfile() {
    const s = LS.get("woo_demo_session", null);
    return s ? { role: s.role, store_name: "본촌점", display_name: { owner: "대표(데모)", manager: "매니저(데모)", staff: "김자유(데모)" }[s.role] } : null;
  },
  async signIn(role) { LS.set("woo_demo_session", { role }); },
  async signOut() { localStorage.removeItem("woo_demo_session"); },
  setStore(st) { curStore = st; },
  async changePassword() { throw new Error("데모 모드에서는 비밀번호를 바꿀 수 없어요"); },
  async tkMine() { throw new Error("데모 모드에서는 업무지시를 쓸 수 없어요"); },
  async sgSend() { throw new Error("데모 모드에서는 건의함을 쓸 수 없어요"); },
  async sgList() { return []; },
  async sgSet() {},
  async sgDelete() {},
  async wkList() { return []; },
  async wkSave() { throw new Error("데모 모드에서는 업무 기록을 쓸 수 없어요"); },
  async wkDelete() {},
  async chkToday() { throw new Error("데모 모드에서는 점검 기능을 쓸 수 없어요"); },
  async listStores() { return DEMO_STORES; },
  async overview() {
    const z = { in_today: 0, working: 0, not_in: 0, missing_out: 0, pending_approval: 0 };
    return { stores: DEMO_STORES.map((s) => ({ ...s, closed: false, people: 3, attendance: { ...z, in_today: 2 }, claims: { open: s.app_key === "gejang" ? 1 : 0, severe: 0 }, report: s.kind === "restaurant" ? { submitted: false } : null })) };
  },
  async getReport(date) { return LS.get("woo_demo_reports", {})[date] ?? null; },
  async saveReport(date, data) {
    const all = LS.get("woo_demo_reports", {});
    all[date] = rowFrom(date, data);
    LS.set("woo_demo_reports", all);
    return all[date];
  },
  async listReports(fromDate) {
    const all = LS.get("woo_demo_reports", {});
    return Object.values(all).filter((r) => r.report_date >= fromDate).sort((a, b) => b.report_date.localeCompare(a.report_date));
  },
  async enablePush() {
    if (!("Notification" in window)) throw new Error("이 브라우저는 알림을 지원하지 않아요");
    const p = await Notification.requestPermission();
    if (p !== "granted") throw new Error("알림이 허용되지 않았어요");
    const reg = await navigator.serviceWorker?.ready;
    const opt = { body: "데모: 실제 연결 후에는 보고가 올 때 이렇게 알려 드려요", icon: "icons/icon-192.png" };
    if (reg) reg.showNotification("본촌점 일일보고 도착 · 클레임 1건", opt); else new Notification("본촌점 일일보고 도착", opt);
    LS.set("woo_demo_push", true);
  },
  pushEnabled() { return !!LS.get("woo_demo_push", false); },
  ...attDemo,
  ...claimsDemo,
  async stRecv() { return LS.get("woo_demo_recv", []); },
  async stDeps() { return LS.get("woo_demo_deps", []); },
  async stWds() { return []; },
  async stRules() { return []; },
  async stSetRule() {},
  async stDelRule() {},
  async stAddWds() { return 0; },
  async stInvs() { return []; },
  async stAddInvs() { return 0; },
  async stAddRecv(rows) {
    const all = LS.get("woo_demo_recv", []); const have = new Set(all.map((r) => r.ref)); let n = 0;
    for (const r of rows) if (!have.has(r.ref)) { all.push({ id: "r" + Math.random().toString(36).slice(2), closed: false, dunned_at: null, ...r }); n++; }
    LS.set("woo_demo_recv", all); return n;
  },
  async stAddDeps(rows) {
    const all = LS.get("woo_demo_deps", []); const have = new Set(all.map((r) => r.ref)); let n = 0;
    for (const r of rows) if (!have.has(r.ref)) { all.push({ id: "d" + Math.random().toString(36).slice(2), ...r }); n++; }
    LS.set("woo_demo_deps", all); return n;
  },
  async stPatch(id, f) { LS.set("woo_demo_recv", LS.get("woo_demo_recv", []).map((r) => (r.id === id ? { ...r, ...f } : r))); },
  async stDelete(id) { LS.set("woo_demo_recv", LS.get("woo_demo_recv", []).filter((r) => r.id !== id)); },
  async adminUsers(body) {
    if (body.action === "list") return { users: [{ id: "1", email: "owner@demo", role: "owner", display_name: "대표(데모)", job_title: "대표" }, { id: "2", email: "manager@demo", role: "manager", display_name: "매니저(데모)", job_title: "매니저" }] };
    throw new Error("데모 모드에서는 계정을 바꿀 수 없어요");
  },
  // 데모 전용: 최근 3주 샘플 데이터
  async seedSample() {
    const all = LS.get("woo_demo_reports", {});
    const today = todayKST();
    for (let i = 1; i <= 21; i++) {
      const date = addDays(today, -i);
      if (i % 9 === 0) continue; // 미제출 날
      const d = defaultData(date);
      d.att.absent = i % 7 === 0 ? "has" : "none"; if (d.att.absent === "has") d.att.absents = [{ name: "김결원", note: "개인 사정" }];
      d.att.late = i % 5 === 0 ? "has" : "none";
      if (d.att.late === "has") d.att.lates = [{ name: "홍길동", time: "18:10" }];
      d.claim.state = i % 6 === 0 ? "has" : "none";
      if (d.claim.state === "has") d.claim.items = [{ content: "반찬 리필이 늦다는 말씀", result: "사과드리고 서비스 제공" }];
      d.chk.reviewDone = true; d.chk.openDone = true; d.chk.yard = true; d.chk.closing = i % 4 !== 0;
      d.chk.openMissing = i % 8 === 0 ? ["천장 거미줄 제거"] : [];
      d.chk.trash = dow(date) === 0 ? "noPickup" : "done";
      all[date] = rowFrom(date, d, { submitted_at: new Date(Date.parse(date) + 13 * 3600e3).toISOString() });
    }
    LS.set("woo_demo_reports", all);
  },
  async resetDemo() { localStorage.removeItem("woo_demo_reports"); localStorage.removeItem("woo_demo_push"); },
};

/* ---------------- Supabase ---------------- */
let _sb;
async function sb() {
  if (!_sb) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
    _sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return _sb;
}

function b64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const remote = {
  async getProfile() {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;
    const { data, error } = await c.from("profiles").select("role,store_id,display_name,can_settle,stores(name,kind,display_name,app_key)").eq("user_id", session.user.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("계정에 역할이 아직 연결되지 않았어요 (accounts.sql 실행 필요)");
    return { role: data.role, can_settle: !!data.can_settle, store_id: data.store_id, store_name: data.stores?.name ?? "본촌점", store_kind: data.stores?.kind ?? "restaurant", store_app_key: data.stores?.app_key ?? null, store_display: data.stores?.display_name ?? data.stores?.name ?? "본촌점", display_name: data.display_name, user_id: session.user.id };
  },
  async signIn(email, password) {
    const c = await sb();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw new Error("이메일 또는 비밀번호가 맞지 않아요");
  },
  async signOut() {
    curStore = null;
    const c = await sb();
    // 이 폰의 푸시 구독을 정리해, 같은 폰에서 다른 계정으로 로그인해도 알림이 섞이지 않게 한다
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await c.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    } catch { /* 정리에 실패해도 로그아웃은 진행 */ }
    LS.set("woo_push_on", false);
    await c.auth.signOut();
  },
  setStore(st) { curStore = st; },
  async changePassword(password) {
    const { error } = await (await sb()).auth.updateUser({ password });
    if (error) throw new Error("비밀번호를 바꾸지 못했어요. 다시 로그인한 뒤 시도해 주세요");
  },
  // 지금 다루는 사업장 id: 대표가 고른 곳, 없으면 내 소속
  async storeId() { return curStore?.id ?? (await this.getProfile()).store_id; },
  async listStores() {
    const { data, error } = await (await sb()).from("stores").select("id,name,display_name,kind,app_key").order("app_key");
    if (error) throw error;
    return data;
  },
  overview() { return this.fn("overview", {}); },
  async getReport(date) {
    const { data, error } = await (await sb()).from("daily_reports").select("*").eq("report_date", date).eq("store_id", await this.storeId()).maybeSingle();
    if (error) throw error;
    return data;
  },
  async saveReport(date, data) {
    const c = await sb();
    const p = await this.getProfile();
    const s = summarize(data);
    const row = {
      store_id: p.store_id, report_date: date, data,
      has_claim: s.has_claim, incomplete: s.incomplete, late_count: s.late_count, absent_count: s.absent_count,
      submitted_by: p.user_id, submitted_at: new Date().toISOString(),
    };
    const { data: saved, error } = await c.from("daily_reports").upsert(row, { onConflict: "store_id,report_date" }).select().single();
    if (error) throw error;
    // 대표 푸시: 실패해도 제출은 성공 처리
    c.functions.invoke("notify-report", { body: { report_date: date } }).catch(() => {});
    return saved;
  },
  async listReports(fromDate) {
    const { data, error } = await (await sb()).from("daily_reports").select("*").eq("store_id", await this.storeId()).gte("report_date", fromDate).order("report_date", { ascending: false });
    if (error) throw error;
    return data;
  },
  async enablePush() {
    const miss = [];
    if (!("serviceWorker" in navigator)) miss.push("serviceWorker");
    if (!("PushManager" in window)) miss.push("PushManager");
    if (typeof Notification === "undefined") miss.push("Notification");
    if (miss.length) {
      const standalone = matchMedia("(display-mode: standalone)").matches ? "설치앱" : "브라우저";
      throw new Error(`푸시를 지원하지 않아요 [없는 기능: ${miss.join(", ")} / ${isSecureContext ? "https" : "비보안"} / ${standalone} / ${navigator.userAgent.slice(0, 90)}]`);
    }
    if (!VAPID_PUBLIC_KEY) throw new Error("VAPID 공개키가 config.js에 없어요");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("알림이 허용되지 않았어요");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const p = await this.getProfile();
    const { error } = await (await sb()).from("push_subscriptions").upsert(
      { user_id: p.user_id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) throw error;
    LS.set("woo_push_on", true);
  },
  // Edge Function 호출. 실패하면 서버가 준 한국어 메시지와 code를 담은 Error를 던진다
  async fn(name, body) {
    const { data, error } = await (await sb()).functions.invoke(name, { body: curStore ? { store_id: curStore.id, ...body } : body });
    if (error) {
      let msg = "서버에 연결하지 못했어요", code = "network";
      try { const j = await error.context.json(); if (j?.error) { msg = j.error; code = j.code ?? "error"; } } catch { /* 기본 문구 */ }
      throw Object.assign(new Error(msg), { code });
    }
    if (data?.error) throw Object.assign(new Error(data.error), { code: data.code ?? "error" });
    return data;
  },
  adminUsers(body) { return this.fn("manage-users", body); },

  /* 업무지시 */
  tkMine() { return this.fn("tasks", { action: "mine" }); },
  // all=true: 사업장 구분 없이 전 직원 대상(대표·부대표)
  tkAll(all = false) { return this.fn("tasks", { action: "all", all }); },
  tkPeople(all = false) { return this.fn("tasks", { action: "people", all }); },
  tkCreate(f, all = false) { return this.fn("tasks", { action: "create", all, ...f }); },
  tkComplete(id, note) { return this.fn("tasks", { action: "complete", id, note }); },
  tkCancel(id, all = false) { return this.fn("tasks", { action: "cancel", id, all }); },
  tkReopen(id, all = false) { return this.fn("tasks", { action: "reopen", id, all }); },

  /* CK 점검 체크리스트 */
  chkToday() { return this.fn("checklist", { action: "today" }); },
  chkSubmit(f) { return this.fn("checklist", { action: "submit", ...f }); },
  chkReport(note) { return this.fn("checklist", { action: "report", note }); },
  chkBoard() { return this.fn("checklist", { action: "board" }); },
  chkResolve(id) { return this.fn("checklist", { action: "resolve", id }); },
  chkItems() { return this.fn("checklist", { action: "items" }); },
  chkSave(f) { return this.fn("checklist", { action: "save_item", ...f }); },
  chkSeed(replace) { return this.fn("checklist", { action: "seed_defaults", replace: replace === true }); },

  /* 클레임 후속조치 */
  clList(scope) { return this.fn("claims", { action: "list", scope }); },
  clCreate(f) { return this.fn("claims", { action: "create", ...f }); },
  clNote(id, note) { return this.fn("claims", { action: "note", id, note }); },
  clStatus(id, status, note) { return this.fn("claims", { action: "status", id, status, note }); },

  /* 출퇴근 */
  attStatus() { return this.fn("attendance", { action: "status" }); },
  attConsent() { return this.fn("attendance", { action: "consent" }); },
  attPunch(kind, pos) { return this.fn("attendance", { action: kind, ...(pos ?? {}) }); },
  attReportOut(id, time) { return this.fn("attendance", { action: "report_out", id, time }); },
  async attMine(fromDate) {
    const p = await this.getProfile();
    const { data, error } = await (await sb()).from("attendance").select("*").eq("user_id", p.user_id).gte("work_date", fromDate).order("in_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async attAll(fromDate) {
    const { data, error } = await (await sb()).from("attendance").select("*").eq("store_id", await this.storeId()).gte("work_date", fromDate).order("in_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async attEmployees() { return (await this.fn("attendance", { action: "employees" })).employees; },
  async attStore() {
    const { data, error } = await (await sb()).from("stores").select("name,lat,lng,radius_m").eq("id", await this.storeId()).single();
    if (error) throw error;
    return data;
  },
  attSetStore(lat, lng, radius_m) { return this.fn("attendance", { action: "set_store", lat, lng, radius_m }); },
  attSetWork(user_id, f) { return this.fn("attendance", { action: "set_work", user_id, ...f }); },
  attEdit(id, f, reason) { return this.fn("attendance", { action: "edit", id, ...f, reason }); },
  attApprove(id) { return this.fn("attendance", { action: "approve", id }); },
  attAdd(f) { return this.fn("attendance", { action: "add", ...f }); },
  /* 수금 대조 (대표 전용 테이블, RLS로 보호) */
  async stRecv() {
    const { data, error } = await (await sb()).from("receivables").select("*").eq("store_id", await this.storeId()).order("expected_date");
    if (error) throw error;
    return data;
  },
  async stDeps() {
    const { data, error } = await (await sb()).from("bank_deposits").select("id,dep_date,amount,memo").eq("store_id", await this.storeId()).order("dep_date");
    if (error) throw error;
    return data.map((d) => ({ id: d.id, date: d.dep_date, amount: d.amount, memo: d.memo }));
  },
  // 이미 있는 건(ref 같음)은 건드리지 않는다 → 종결·독촉 기록이 유지된다. 새로 들어간 건수를 돌려준다.
  async stAddRecv(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, source: r.source, counterparty: r.counterparty ?? "", expected_date: r.expected_date, amount: r.amount, ref: r.ref, estimated: !!r.estimated, note: r.note ?? "" }));
      // 이미 있는 건 중 "추정"이던 것은 새 파일의 금액으로 갱신(추정 → 확정). 종결·독촉 기록은 건드리지 않는다.
      const { data: ex, error: e1 } = await c.from("receivables").select("id,ref,estimated,amount").eq("store_id", store_id).in("ref", part.map((p) => p.ref));
      if (e1) throw e1;
      const exMap = new Map(ex.map((e) => [e.ref, e]));
      for (const p of part) {
        const e = exMap.get(p.ref);
        if (e && e.estimated && (!p.estimated || p.amount !== e.amount)) {
          const { error } = await c.from("receivables").update({ amount: p.amount, estimated: p.estimated, expected_date: p.expected_date, note: p.note }).eq("id", e.id);
          if (error) throw error; n++;
        }
      }
      const fresh = part.filter((p) => !exMap.has(p.ref));
      if (fresh.length) {
        const { data, error } = await c.from("receivables").upsert(fresh, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
        if (error) throw error; n += data.length;
      }
    }
    return n;
  },
  async stAddDeps(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, dep_date: r.date, amount: r.amount, memo: r.memo ?? "", ref: r.ref }));
      const { data, error } = await c.from("bank_deposits").upsert(part, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  // 통장 출금(지출) 내역
  async stWds() {
    const { data, error } = await (await sb()).from("bank_withdrawals").select("id,wd_date,amount,memo").eq("store_id", await this.storeId()).order("wd_date");
    if (error) throw error;
    return data.map((d) => ({ id: d.id, date: d.wd_date, amount: d.amount, memo: d.memo }));
  },
  // 거래처 분류 규칙 (지출 분석)
  async stRules() {
    const { data, error } = await (await sb()).from("spend_rules").select("keyword,category").eq("store_id", await this.storeId());
    if (error) throw error;
    return data;
  },
  async stSetRule(keyword, category) {
    const { error } = await (await sb()).from("spend_rules").upsert({ store_id: await this.storeId(), keyword: keyword.trim(), category: category.trim() }, { onConflict: "store_id,keyword" });
    if (error) throw error;
  },
  async stDelRule(keyword) {
    const { error } = await (await sb()).from("spend_rules").delete().eq("store_id", await this.storeId()).eq("keyword", keyword);
    if (error) throw error;
  },
  async stAddWds(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, wd_date: r.date, amount: r.amount, memo: r.memo ?? "", ref: r.ref }));
      const { data, error } = await c.from("bank_withdrawals").upsert(part, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  // 매입 (세금)계산서
  async stInvs() {
    const { data, error } = await (await sb()).from("tax_invoices").select("issue_date,approval_no,supplier,rep,biz_no,amount,tax_free,item").eq("store_id", await this.storeId()).order("issue_date").limit(5000);
    if (error) throw error;
    return data.map((d) => ({ date: d.issue_date, no: d.approval_no, supplier: d.supplier, rep: d.rep, bizNo: d.biz_no, amount: d.amount, taxFree: d.tax_free, item: d.item }));
  },
  async stAddInvs(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, issue_date: r.date, approval_no: r.no, supplier: r.supplier, rep: r.rep, biz_no: r.bizNo, amount: r.amount, tax_free: r.taxFree, item: r.item }));
      const { data, error } = await c.from("tax_invoices").upsert(part, { onConflict: "store_id,approval_no", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  async stPatch(id, f) { const { error } = await (await sb()).from("receivables").update(f).eq("id", id); if (error) throw error; },
  async stDelete(id) { const { error } = await (await sb()).from("receivables").delete().eq("id", id); if (error) throw error; },
  // 건의함: 직원은 보내기만, 읽기·처리는 대표만(RLS)
  async sgSend(row) {
    const p = await this.getProfile();
    const { error } = await (await sb()).from("suggestions").insert({ store_id: p.store_id ?? null, author_id: p.user_id, author_name: p.display_name ?? "", anon: !!row.anon, category: row.category, body: row.body });
    if (error) throw error;
  },
  async sgList() {
    const { data, error } = await (await sb()).from("suggestions").select("*, stores(display_name,name)").order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return data;
  },
  async sgSet(id, patch) { const { error } = await (await sb()).from("suggestions").update(patch).eq("id", id); if (error) throw error; },
  async sgDelete(id) { const { error } = await (await sb()).from("suggestions").delete().eq("id", id); if (error) throw error; },
  // 업무 기록(일지·일정·기록함): table = work_logs | work_events | work_notes. 보이는 범위는 서버(RLS)가 정한다.
  async wkList(table) {
    const { data, error } = await (await sb()).from(table).select("*").eq("store_id", await this.storeId()).order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return data;
  },
  async wkSave(table, row) {
    const c = await sb();
    if (row.id) { const { id, ...rest } = row; const { error } = await c.from(table).update(rest).eq("id", id); if (error) throw error; return; }
    const p = await this.getProfile();
    const { error } = await c.from(table).insert({ ...row, store_id: await this.storeId(), author_id: p.user_id, author_name: p.display_name ?? "" });
    if (error) throw error;
  },
  async wkDelete(table, id) { const { error } = await (await sb()).from(table).delete().eq("id", id); if (error) throw error; },
  pushEnabled() { return !!LS.get("woo_push_on", false) && typeof Notification !== "undefined" && Notification.permission === "granted"; },
};

export const api = isDemo ? demo : remote;
