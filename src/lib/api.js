// 화면은 이 파일의 api 객체만 쓴다. 키가 없으면 데모(localStorage), 있으면 Supabase.
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "../config.js";
import { summarize, defaultData } from "./report.js";
import { todayKST, addDays, dow } from "./kst.js";
import { attDemo } from "./att-demo.js";
import { claimsDemo } from "./claims-demo.js";
import { t } from "./i18n.js";

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
// 공지 데모 자료: 이 화면을 연 동안 메모리에만 있다(새로 고치면 처음 상태). 사람 이름은 가짜다
const ntDemo = {
  rows: null, reads: new Map(),
  seed() {
    if (this.rows) return this.rows;
    const ago = (d) => new Date(Date.now() - d * 86400e3).toISOString();
    const base = { store_id: null, translated_at: null, important: false, expires_on: null, created_by: "demo", created_name: "대표(데모)", removed_at: null, title_vi: null, body_vi: null, title_en: null, body_en: null };
    this.rows = [
      { ...base, id: "demo-nt-1", important: true, created_at: ago(1), updated_at: ago(1), translated_at: ago(1),
        title: "이번 주 위생 점검 안내", body: "금요일 오전에 위생 점검이 있어요.\n작업대와 냉장고 안쪽까지 한 번 더 닦아 주세요.",
        title_vi: "Thông báo kiểm tra vệ sinh tuần này", body_vi: "Sáng thứ Sáu sẽ có đợt kiểm tra vệ sinh.\nHãy lau thêm một lần cả bàn làm việc và bên trong tủ lạnh.",
        title_en: "Hygiene inspection this week", body_en: "There will be a hygiene inspection on Friday morning.\nPlease wipe down the work tables and the inside of the fridge once more." },
      { ...base, id: "demo-nt-2", created_at: ago(3), updated_at: ago(3), title: "명절 연휴 근무표", body: "근무표는 이번 주 안에 알려 드릴게요. 바꾸고 싶은 날이 있으면 미리 말해 주세요." },
    ];
    return this.rows;
  },
  storeName(id) { const s = DEMO_STORES.find((x) => x.id === id); return s ? (s.display_name || s.name) : ""; },
  view(r) { return { ...r, read_at: this.reads.get(r.id) ?? null, store_name: r.store_id ? this.storeName(r.store_id) : "" }; },
};
const demo = {
  async getProfile() {
    const s = LS.get("woo_demo_session", null);
    return s ? { role: s.role, store_name: "본촌점", display_name: { owner: "대표(데모)", manager: "매니저(데모)", staff: "김자유(데모)" }[s.role] } : null;
  },
  async setMyLang() { /* 데모 모드: 이 기기에만 저장(화면에서 처리) */ },
  async signIn(role) { LS.set("woo_demo_session", { role }); },
  async signOut() { localStorage.removeItem("woo_demo_session"); },
  setStore(st) { curStore = st; },
  async changePassword() { throw new Error("데모 모드에서는 비밀번호를 바꿀 수 없어요"); },
  async tkMine() { throw new Error("데모 모드에서는 업무지시를 쓸 수 없어요"); },
  async sgSend() { throw new Error("데모 모드에서는 건의함을 쓸 수 없어요"); },
  async sgList() { return []; },
  async sgSet() {},
  async sgDelete() {},
  async sgUrls() { return new Map(); },
  async sgUrl() { throw new Error("데모 모드에서는 파일을 열 수 없어요"); },
  async pj() { throw new Error("데모 모드에서는 프로젝트를 쓸 수 없어요"); },
  async pushStatus() { return { supported: false, permission: "unsupported" }; },
  async pushTest() { throw new Error("데모 모드에서는 알림을 시험할 수 없어요"); },
  async aiTaskParse() { throw new Error("데모 모드에서는 AI를 쓸 수 없어요"); },
  async aiPing() { throw new Error("데모 모드에서는 AI를 쓸 수 없어요"); },
  async libList() { return []; },
  async libUpload() { throw new Error("데모 모드에서는 파일을 올릴 수 없어요"); },
  async libUrl() { throw new Error("데모 모드에서는 파일을 열 수 없어요"); },
  async libUpdate() { throw new Error("데모 모드에서는 파일을 고칠 수 없어요"); },
  async libDelete() {},
  // 공지(데모): 메모리 안에서만 동작한다. 번역은 하지 않고(translated:false), 확인은 이 기기에서만 센다
  async noticeList() { return ntDemo.seed().filter((r) => !r.removed_at).map((r) => ntDemo.view(r)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100); },
  async noticeRead(id) { if (!ntDemo.reads.has(id)) ntDemo.reads.set(id, new Date().toISOString()); },
  async noticeStatus(id) {
    const people = [{ user_id: "demo-u1", name: "직원A", job_title: "홀" }, { user_id: "demo-u2", name: "직원B", job_title: "주방" }, { user_id: "demo-u3", name: "직원C", job_title: "포장" }];
    const at = ntDemo.reads.get(id);
    return { targets: people.length, confirmed: at ? [{ ...people[0], at }] : [], pending: at ? people.slice(1) : people };
  },
  async noticeSave(p) {
    const rows = ntDemo.seed(), now = new Date().toISOString();
    if (!String(p.title ?? "").trim() || !String(p.body ?? "").trim()) throw new Error("제목과 내용을 적어 주세요");
    const f = { title: p.title, body: p.body, store_id: p.store_id ?? null, important: !!p.important, expires_on: p.expires_on || null, updated_at: now };
    let row = p.id ? rows.find((r) => r.id === p.id) : null;
    if (row) {
      if (row.title !== f.title || row.body !== f.body) Object.assign(row, { title_vi: null, body_vi: null, title_en: null, body_en: null, translated_at: null });
      Object.assign(row, f);
    } else {
      row = { id: "demo-nt-" + Math.random().toString(36).slice(2, 8), title_vi: null, body_vi: null, title_en: null, body_en: null, translated_at: null, created_by: "demo", created_name: "대표(데모)", created_at: now, removed_at: null, ...f };
      rows.unshift(row);
    }
    return { ok: true, notice: ntDemo.view(row), translated: false, pushed: 0 };
  },
  async noticeRetranslate(id) {
    const row = ntDemo.seed().find((r) => r.id === id);
    if (!row) throw new Error("공지를 찾지 못했어요");
    return { ok: true, notice: ntDemo.view(row), translated: false };
  },
  async noticeRemove(id) { const row = ntDemo.seed().find((r) => r.id === id); if (row) row.removed_at = new Date().toISOString(); return { ok: true }; },
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
    const opt = { body: t("데모: 실제 연결 후에는 보고가 올 때 이렇게 알려 드려요"), icon: "icons/icon-192.png" };
    if (reg) reg.showNotification(t("{store} 일일보고 도착 · 클레임 {n}건", { store: "본촌점", n: 1 }), opt); else new Notification(t("{store} 일일보고 도착", { store: "본촌점" }), opt);
    LS.set("woo_demo_push", true);
  },
  pushEnabled() { return !!LS.get("woo_demo_push", false); },
  ...attDemo,
  ...claimsDemo,
  async stRecv() { return LS.get("woo_demo_recv", []); },
  async stDeps() { return LS.get("woo_demo_deps", []); },
  async recon18Deps() { return LS.get("woo_demo_deps", []); },
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
let pjMod; // 프로젝트 기능은 따로 불러온다(새 파일에 문제가 있어도 로그인·다른 화면은 정상)
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

/* ---------------- 건의함 첨부 (supabase/suggestions-files.sql) ---------------- */
// 비공개 보관함 suggest-files. 경로는 {uid}/{무작위 id}.{확장자} (ASCII) — 한글·공백 이름은 경로에 쓰지 않고 원래 이름은 건의 행의 files[].name 에만 둔다.
const SG_BUCKET = "suggest-files";
const SG_MAX = 5; // 건의 하나에 붙일 수 있는 개수(DB 검사와 같게)
const SG_URL_KEEP_MS = 55 * 60 * 1000; // 1시간짜리 주소는 55분만 기억(만료 직전 주소를 쓰지 않도록)
const sgUrlCache = new Map(); // 경로 -> { url, exp }
// 보관함이 받는 파일 종류(supabase/suggestions-files.sql 4번의 allowed_mime_types 와 같게 유지). 이 밖이면 octet-stream 으로 올린다
const SG_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp", "application/vnd.hancom.hwpx", "application/hwp+zip",
  "text/plain", "text/csv", "application/csv",
  "application/zip", "application/x-zip-compressed",
  "application/octet-stream",
]);
const SG_MIME_ALIAS = { "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
const SG_PATH_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]+$/i;
// 건의 행의 files 에서 지울 수 있는 경로만(모양이 맞는 것). 남이 쓴 값이라 그대로 믿지 않는다
const sgPaths = (files) => (Array.isArray(files) ? files : []).map((f) => f && f.path).filter((p) => typeof p === "string" && SG_PATH_OK.test(p) && !p.includes(".."));
const sgCleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "");
const sgShort = (s) => { const a = [...sgCleanName(s)]; return a.length > 30 ? a.slice(0, 29).join("") + "…" : a.join(""); };
// 첨부 열·보관함이 아직 없다는 오류인가(suggestions-files.sql 을 안 돌린 서버)
function sgNotReady(e) {
  const m = String((e && e.message) || ""), code = String((e && (e.code || e.statusCode || e.status)) || "");
  return /bucket not found/i.test(m) || code === "PGRST204" || code === "42703" || (/files/i.test(m) && /column|schema cache/i.test(m));
}
// 첨부가 있는 건의 보내기: 파일을 한 개씩 올리고 → 건의 행 저장. 어느 단계든 실패하면 올린 파일을 치우고(가능한 만큼) 건의는 저장하지 않는다.
// opts.onProgress({ phase: "up"|"save", i, n }) 로 진행을 알린다. 사진은 폰에서 줄여(긴 변 1600px JPEG) 올린다.
async function sgSendFiles(c, p, base, files, opts) {
  const img = await import("./img.js");
  if (files.length > SG_MAX) throw new Error(t("첨부는 최대 {max}개까지 붙일 수 있어요", { max: SG_MAX }));
  for (const f of files) { const bad = img.checkFile(f); if (bad) throw new Error(bad); }
  const bucket = c.storage.from(SG_BUCKET);
  const tried = []; // 올리려고 시도한 경로 전부(응답이 끊겨도 서버에는 올라갔을 수 있어서)
  const done = [];  // 건의 행에 적을 첨부 정보 {path,name,size,type}
  let step = "up", cur = "";
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      cur = sgShort(f.name);
      if (opts.onProgress) opts.onProgress({ phase: "up", i: i + 1, n: files.length });
      let blob = f, ext = img.extOf(f.name), type = "";
      let name = sgCleanName(f.name) || "file";
      if (img.isImage(f)) {
        let r = null;
        try { r = await img.resizeImage(f); } catch { r = null; }
        if (r && r.big) { blob = r.big; ext = "jpg"; type = "image/jpeg"; name = name.replace(/\.[^./\\]+$/, "") + ".jpg"; }
      }
      if (!type) { // 줄이지 않은 파일: 보관함이 받는 종류가 아니면 octet-stream (File 은 contentType 옵션이 무시되고 file.type 이 그대로 가므로 Blob 으로 감싼다)
        type = String(f.type || "").toLowerCase();
        type = SG_MIME_ALIAS[type] ?? type;
        if (!SG_MIME.has(type)) type = "application/octet-stream";
        if (type !== f.type) blob = new Blob([f], { type });
      }
      const path = `${p.user_id}/${crypto.randomUUID()}.${ext}`;
      tried.push(path);
      const up = await bucket.upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw up.error;
      done.push({ path, name: [...name].slice(0, 200).join(""), size: blob.size, type }); // 글자(코드포인트) 단위로 자른다: DB 는 200자 이하만 받고, 쪼개진 이모지는 JSON 저장이 거절된다
    }
    step = "save";
    if (opts.onProgress) opts.onProgress({ phase: "save", i: files.length, n: files.length });
    const { error } = await c.from("suggestions").insert({ ...base, files: done });
    if (error) throw error;
  } catch (e) {
    if (tried.length) { try { await bucket.remove(tried); } catch { /* 정리에 실패해도 원래 오류를 알린다(고아 파일은 남을 수 있다: suggestions-files.sql 설명) */ } }
    console.warn("[건의 첨부]", e);
    if (sgNotReady(e)) throw new Error("첨부 기능을 쓰려면 supabase/suggestions-files.sql 을 먼저 Run 해야 해요");
    if (step === "up") throw new Error(t("{nm}: 올리지 못해서 건의를 보내지 않았어요. 다시 시도해 주세요", { nm: cur }));
    throw new Error("건의를 보내지 못했어요. 다시 시도해 주세요");
  }
}

const remote = {
  async getProfile() {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;
    const cols = "role,store_id,display_name,job_title,can_settle,stores(name,kind,display_name,app_key)";
    // lang(화면 언어) 열은 i18n.sql 을 실행한 뒤에만 있다. 아직 없으면 열 없이 다시 읽어서 앱이 멈추지 않게 한다
    let { data, error } = await c.from("profiles").select("lang," + cols).eq("user_id", session.user.id).maybeSingle();
    if (error && /lang/i.test(error.message ?? "")) ({ data, error } = await c.from("profiles").select(cols).eq("user_id", session.user.id).maybeSingle());
    if (error) throw error;
    if (!data) throw new Error("계정에 역할이 아직 연결되지 않았어요 (accounts.sql 실행 필요)");
    return { lang: data.lang ?? null, role: data.role, job_title: String(data.job_title ?? "").trim(), can_settle: !!data.can_settle, store_id: data.store_id, store_name: data.stores?.name ?? "본촌점", store_kind: data.stores?.kind ?? "restaurant", store_app_key: data.stores?.app_key ?? null, store_display: data.stores?.display_name ?? data.stores?.name ?? "본촌점", display_name: data.display_name, user_id: session.user.id };
  },
  // 내 화면 언어를 서버에 저장한다(i18n.sql 의 set_my_lang). 서버가 아직 준비 안 됐으면 오류 — 호출하는 쪽에서 이 기기에만 바꾼다
  async setMyLang(l) {
    const { error } = await (await sb()).rpc("set_my_lang", { p_lang: l });
    if (error) throw error;
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
      // 진단 정보는 콘솔로만(오류 문구는 번역할 수 있게 고정)
      console.warn(`푸시를 지원하지 않아요 [없는 기능: ${miss.join(", ")} / ${isSecureContext ? "https" : "비보안"} / ${standalone} / ${navigator.userAgent.slice(0, 90)}]`);
      throw new Error("푸시를 지원하지 않아요");
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
  // 알림 점검: 이 기기가 알림을 받을 수 있는 상태인지 단계별로 알려 준다
  async pushStatus() {
    const ua = navigator.userAgent;
    const st = {
      secure: isSecureContext, standalone: matchMedia("(display-mode: standalone)").matches, ios: /iPhone|iPad|iPod/i.test(ua), kakao: /KAKAOTALK/i.test(ua),
      sw: "serviceWorker" in navigator, push: "PushManager" in window, notif: typeof Notification !== "undefined",
      permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported", hasSub: false, saved: false,
    };
    st.supported = st.sw && st.push && st.notif;
    if (!st.supported) return st;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      st.hasSub = !!sub;
      if (sub) {
        const { data } = await (await sb()).from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).limit(1);
        st.saved = !!data?.length;
      }
    } catch { /* 점검 중 오류는 상태에 반영하지 않고 넘어간다 */ }
    return st;
  },
  pushTest() { return this.fn("project-notify", { action: "test" }); }, // 내 기기들로 시험 알림을 보낸다(서버에서 보냄)
  // 말로 업무지시(AI): 해석만 한다. 저장은 사람이 카드를 확인하고 tkCreate 로 한다 (ai 함수, ai.sql)
  aiTaskParse(text) { return this.fn("ai", { action: "parse_task", text }); },
  aiPing() { return this.fn("ai", { action: "ping" }); },
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
  // 매출-입금 대조(대표·부대표·회장 전용): 서버 함수(recon18.sql)가 역할을 확인한 뒤에만 입금을 돌려준다. 권한이 없으면 오류.
  async recon18Deps(from, to) {
    const { data, error } = await (await sb()).rpc("recon18_deposits", { p_store: await this.storeId(), p_from: from ?? null, p_to: to ?? null });
    if (error) throw error;
    return (data ?? []).map((d) => ({ id: d.id, date: d.dep_date, amount: Number(d.amount), memo: d.memo }));
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
  // 프로젝트 아카이브: 화면은 const pj = await api.pj() 로 쓴다 (pj-api.js, projects.sql)
  pj() {
    return (pjMod ??= import("./pj-api.js").then((m) => m.makePj({ sb, me: () => this.getProfile() })).catch((e) => { pjMod = null; throw e; }));
  },
  // 서식·자료함: 파일은 Storage(library), 목록·권한은 library_files(RLS). 보이는 것만 서버가 내려준다.
  async libList() {
    const { data, error } = await (await sb()).from("library_files").select("*, stores(display_name,name)").order("created_at", { ascending: false }).limit(1000);
    if (error) throw error;
    return data;
  },
  // 언어판 열(lang·doc_id)이 없는 서버(library2.sql 을 아직 안 돌림)인지 알아보고, 알아볼 수 있는 문장의 오류로 바꿔 돌려준다. usedNew = 이번 요청이 새 열을 보냈는가
  libErr(e, usedNew) {
    if (!usedNew) return e;
    const m = String((e && e.message) || ""), code = String((e && (e.code || e.statusCode || e.status)) || "");
    if (code === "PGRST204" || code === "42703" || (/\b(lang|doc_id)\b/i.test(m) && /column|schema cache/i.test(m))) return new Error("언어판을 올리려면 supabase/library2.sql 을 먼저 Run 해야 해요");
    if (code === "23503" && !/store_id/i.test(m + " " + String((e && e.details) || ""))) return new Error("원본 문서가 이미 지워졌어요. 목록을 새로 불러온 뒤 다시 해 주세요"); // doc_id 가 가리키는 줄이 없음(사업장 연결 오류는 제외)
    return e;
  },
  async libUpload(file, meta) { // meta: {title, folder, note, audience, store_id, lang?, doc_id?} — lang 기본 'ko', doc_id = 번역본이 가리키는 원본 문서
    const c = await sb(), p = await this.getProfile();
    if (file.size > 20 * 1024 * 1024) throw new Error("파일 하나는 20MB까지 올릴 수 있어요");
    const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase();
    const path = `${crypto.randomUUID()}${ext}`; // 보관함에는 한글 이름 대신 번호로 저장하고, 원래 이름은 표에 남긴다
    const up = await c.storage.from("library").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (up.error) throw up.error;
    const row = {
      store_id: meta.store_id ?? null, folder: meta.folder, title: meta.title, file_name: file.name, note: meta.note ?? "", path,
      size: file.size, mime: file.type || "", audience: meta.audience, uploaded_by: p.user_id, uploaded_name: p.display_name ?? "",
    };
    // 한국어 단독 문서(lang 'ko'·원본 연결 없음)는 예전과 똑같이 새 열을 보내지 않는다 → library2.sql 을 아직 안 돌린 서버에서도 올리기가 된다
    const lg = meta.lang || "ko", usedNew = lg !== "ko" || !!meta.doc_id;
    if (usedNew) { row.lang = lg; if (meta.doc_id) row.doc_id = meta.doc_id; }
    const { error } = await c.from("library_files").insert(row);
    if (error) { await c.storage.from("library").remove([path]); throw this.libErr(error, usedNew); }
  },
  async libUpdate(row, patch) { // patch: {title?, lang?, doc_id?} — 올린 사람·대표만(lib_upd 정책). 언어·연결은 library2.sql 이 있어야 한다
    const { data, error } = await (await sb()).from("library_files").update(patch).eq("id", row.id).select("id");
    if (error) throw this.libErr(error, "lang" in patch || "doc_id" in patch);
    if (!data || !data.length) throw new Error("고치지 못했어요. 권한이 없거나 이미 지운 파일이에요"); // 정책에 막히면 오류 없이 0줄이 고쳐진다
  },
  async libUrl(row, download = false) { // 60초짜리 임시 주소(로그인한 사람만 만들 수 있음)
    const { data, error } = await (await sb()).storage.from("library").createSignedUrl(row.path, 60, download ? { download: row.file_name || true } : undefined);
    if (error) throw error;
    return data.signedUrl;
  },
  async libDelete(row) {
    const c = await sb();
    const r = await c.storage.from("library").remove([row.path]); if (r.error) throw r.error;
    const { error } = await c.from("library_files").delete().eq("id", row.id); if (error) throw error;
  },
  // 건의함: 직원은 보내기만, 읽기·처리는 대표만(RLS)
  // row.attach: 붙일 파일(File) 배열(선택, 5개까지). opts.onProgress: 올리는 진행 알림
  async sgSend(row, opts = {}) {
    const p = await this.getProfile();
    const base = { store_id: p.store_id ?? null, author_id: p.user_id, author_name: p.display_name ?? "", anon: !!row.anon, category: row.category, body: row.body };
    const files = Array.isArray(row.attach) ? row.attach : [];
    if (files.length) return sgSendFiles(await sb(), p, base, files, opts);
    // 첨부가 없으면 예전과 똑같이: files 열을 보내지 않는다(suggestions-files.sql 을 아직 안 돌린 서버에서도 된다)
    const { error } = await (await sb()).from("suggestions").insert(base);
    if (error) throw error;
  },
  async sgList() {
    const { data, error } = await (await sb()).from("suggestions").select("*, stores(display_name,name)").order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return data;
  },
  async sgSet(id, patch) { const { error } = await (await sb()).from("suggestions").update(patch).eq("id", id); if (error) throw error; },
  // 건의를 지우면 붙은 파일도 보관함에서 지운다(파일을 못 지워도 건의 삭제는 그대로 진행하고, 남은 파일은 조용히 둔다)
  async sgDelete(id) {
    const c = await sb();
    let paths = [];
    try { // 첨부 경로를 먼저 읽어 둔다(files 열이 없는 서버면 오류가 나므로 건너뜀)
      const { data } = await c.from("suggestions").select("files").eq("id", id).maybeSingle();
      paths = sgPaths(data && data.files);
    } catch { /* 첨부 없음으로 본다 */ }
    const { error } = await c.from("suggestions").delete().eq("id", id); if (error) throw error;
    if (paths.length) { try { await c.storage.from(SG_BUCKET).remove(paths); } catch { /* 남은 파일은 조용히 둔다 */ } }
  },
  // 첨부 파일 임시 주소(만들 수 있는 건 대표뿐: 보관함 읽기 정책). 사진 보기용은 1시간짜리를 55분 기억하고, 내려받기용(opts.download = 저장할 이름)은 60초짜리를 그때그때 만든다
  async sgUrls(paths, opts) {
    const out = new Map(), now = Date.now(), fresh = !!(opts && opts.fresh);
    const want = [...new Set((paths || []).filter((x) => typeof x === "string" && x))];
    const need = [];
    for (const x of want) {
      const c = fresh ? null : sgUrlCache.get(x);
      if (c && c.exp > now) out.set(x, c.url); else need.push(x);
    }
    if (!need.length) return out;
    const bucket = (await sb()).storage.from(SG_BUCKET);
    for (let i = 0; i < need.length; i += 100) {
      const part = need.slice(i, i + 100);
      const { data, error } = await bucket.createSignedUrls(part, 3600);
      if (error) throw error;
      (data || []).forEach((d, k) => {
        if (!d || d.error) return;
        const x = d.path || part[k], u = d.signedUrl || d.signedURL;
        if (!x || !u) return;
        sgUrlCache.delete(x);
        sgUrlCache.set(x, { url: u, exp: now + SG_URL_KEEP_MS });
        out.set(x, u);
      });
    }
    for (const k of sgUrlCache.keys()) { if (sgUrlCache.size <= 600) break; sgUrlCache.delete(k); }
    return out;
  },
  async sgUrl(path, opts = {}) {
    if (opts.download) {
      const { data, error } = await (await sb()).storage.from(SG_BUCKET).createSignedUrl(path, 60, { download: opts.download === true ? true : String(opts.download) });
      if (error) throw error;
      return data.signedUrl;
    }
    return (await this.sgUrls([path], { fresh: !!opts.fresh })).get(path) ?? "";
  },
  // 공지(notices.sql + Edge Function notices). 읽기는 표(RLS)에서, 쓰기(올리기·고치기·내리기·다시 번역)는 서버 함수만 한다.
  // 서버 함수는 store_id 를 자동으로 끼워 넣는 fn() 을 쓰지 않고 직접 부른다(공지의 사업장 선택과 섞이지 않게). 오류 처리는 fn() 과 같다.
  async noticeFn(body) {
    const { data, error } = await (await sb()).functions.invoke("notices", { body });
    if (error) {
      let msg = "서버에 연결하지 못했어요", code = "network";
      try { const j = await error.context.json(); if (j?.error) { msg = j.error; code = j.code ?? "error"; } } catch { /* 기본 문구 */ }
      if (code === "network" && error.context?.status === 404) { msg = "공지 기능이 아직 준비되지 않았어요"; code = "missing"; } // 서버 함수를 아직 올리지 않은 경우
      throw Object.assign(new Error(msg), { code });
    }
    if (data?.error) throw Object.assign(new Error(data.error), { code: data.code ?? "error" });
    return data;
  },
  // 내가 볼 수 있는 공지(내린 것 제외, 최신순 100개) + 내가 확인한 시각(read_at) + 사업장 이름(store_name). 두 표를 따로 읽어 합친다
  async noticeList() {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) throw new Error("로그인이 필요해요");
    const { data, error } = await c.from("notices").select("*, stores(display_name,name)").is("removed_at", null).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const rows = data ?? [], reads = new Map();
    if (rows.length) {
      const r = await c.from("notice_reads").select("notice_id,read_at").eq("user_id", session.user.id).in("notice_id", rows.map((x) => x.id));
      if (r.error) throw r.error;
      for (const x of r.data ?? []) reads.set(x.notice_id, x.read_at);
    }
    return rows.map(({ stores, ...n }) => ({ ...n, read_at: reads.get(n.id) ?? null, store_name: stores?.display_name ?? stores?.name ?? "" }));
  },
  // 확인했어요: 내 줄 하나를 넣는다(이미 있으면 무시)
  async noticeRead(id) {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) throw new Error("로그인이 필요해요");
    const { error } = await c.from("notice_reads").upsert({ notice_id: id, user_id: session.user.id }, { onConflict: "notice_id,user_id", ignoreDuplicates: true });
    if (error) throw error;
  },
  // 확인 현황(대표·부대표): {targets, confirmed:[{user_id,name,job_title,at}], pending:[{user_id,name,job_title}]}
  async noticeStatus(id) {
    const { data, error } = await (await sb()).rpc("notice_status", { p_id: id });
    if (error) throw error;
    const d = data ?? {};
    return { targets: Number(d.targets) || 0, confirmed: Array.isArray(d.confirmed) ? d.confirmed : [], pending: Array.isArray(d.pending) ? d.pending : [] };
  },
  // payload: {id?, title, body, store_id|null, important, expires_on|null, push} → {ok, notice, translated, pushed}
  noticeSave(p) {
    const body = { action: "save", title: p.title, body: p.body, store_id: p.store_id ?? null, important: !!p.important, expires_on: p.expires_on || null, push: !!p.push };
    if (p.id) body.id = p.id;
    return this.noticeFn(body);
  },
  noticeRetranslate(id) { return this.noticeFn({ action: "retranslate", id }); }, // → {ok, notice, translated}
  noticeRemove(id) { return this.noticeFn({ action: "remove", id }); }, // → {ok}
  // 업무 기록(일지·일정·기록함): table = work_logs | work_events | work_notes. 보이는 범위는 서버(RLS)가 정한다.
  async wkList(table, all = false) { // all=true: 사업장 구분 없이 전체(대표·부대표 보고판용)
    let q = (await sb()).from(table).select("*");
    if (!all) q = q.eq("store_id", await this.storeId());
    const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
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
