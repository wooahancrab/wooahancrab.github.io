// 데모 모드 출퇴근 (이 기기 localStorage 안에서만 동작, 서버 규칙을 단순화해 흉내 냄)
import { todayKST, dateOf, kstIso } from "./kst.js";

const LS = {
  get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const K = { rec: "woo_demo_att", store: "woo_demo_store", emp: "woo_demo_emps", edits: "woo_demo_att_edits" };

const defaultEmps = () => [
  { user_id: "s1", role: "staff", display_name: "김자유(데모)", job_title: "홀 서버", work_type: "flex", shift_start: null, shift_end: null, daily_minutes: 480, consented: false },
  { user_id: "s2", role: "staff", display_name: "박고정(데모)", job_title: "주방", work_type: "fixed", shift_start: "17:00", shift_end: "21:00", daily_minutes: null, consented: true },
  { user_id: "m1", role: "manager", display_name: "매니저(데모)", job_title: "매니저", work_type: "fixed", shift_start: "16:30", shift_end: "22:00", daily_minutes: null, consented: true },
];
const emps = () => LS.get(K.emp, null) ?? defaultEmps();
const recs = () => LS.get(K.rec, []);
const meId = () => (LS.get("woo_demo_session", {}).role === "staff" ? "s1" : "m1");
const dist = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180, dl = r(c - a), dn = r(d - b);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const err = (message, code = "error", extra = {}) => Object.assign(new Error(message), { code, ...extra });
const isStale = (o) => Date.now() > (o.expected_out ? new Date(o.expected_out).getTime() : new Date(o.in_at).getTime() + 12 * 3600e3) + 3 * 3600e3;

export const attDemo = {
  async attStatus() {
    const me = emps().find((e) => e.user_id === meId());
    const store = LS.get(K.store, null);
    const open = recs().find((r) => r.user_id === me.user_id && !r.out_at) ?? null;
    return {
      me: { ...me, consented: me.consented }, store: { name: "본촌점", configured: !!store, radius_m: store?.radius_m ?? 100 },
      open, stale: open ? isStale(open) : false, now: new Date().toISOString(),
    };
  },
  async attConsent() { LS.set(K.emp, emps().map((e) => (e.user_id === meId() ? { ...e, consented: true } : e))); },
  async attPunch(kind, pos) {
    const me = emps().find((e) => e.user_id === meId());
    const all = recs();
    const open = all.find((r) => r.user_id === me.user_id && !r.out_at);
    if (kind === "in") {
      const store = LS.get(K.store, null);
      if (!store) throw err("매장 위치가 아직 설정되지 않았어요. 대표님께 문의해 주세요", "store_not_set");
      if (!pos) throw err("위치를 확인하지 못했어요", "no_location");
      if (pos.acc > 150) throw err(`위치 정확도가 낮아요(약 ${Math.round(pos.acc)}m). 창가나 건물 밖에서 다시 눌러 주세요`, "low_accuracy");
      const d = Math.round(dist(pos.lat, pos.lng, store.lat, store.lng));
      if (d > store.radius_m) throw err(`매장에서 약 ${d}m 떨어져 있어요. 매장 ${store.radius_m}m 안에서 눌러 주세요`, "out_of_range");
      if (open) { if (isStale(open)) return { needs_out_report: true, record: open }; throw err("이미 출근 상태예요. 퇴근을 먼저 눌러 주세요", "already_in"); }
      const now = new Date(), today = todayKST();
      if (all.some((r) => r.user_id === me.user_id && r.work_date === today)) throw err("오늘은 이미 출근·퇴근을 마쳤어요. 출퇴근은 하루 한 번만 가능해요", "already_today");
      let late = 0, expected = null;
      if (me.work_type === "fixed" && me.shift_start) {
        late = Math.max(0, Math.floor((now - new Date(kstIso(today, me.shift_start))) / 60000));
        if (late > 600) late = 0;
        if (me.shift_end) expected = kstIso(today, me.shift_end, kstIso(today, me.shift_start));
      } else if (me.work_type === "flex" && me.daily_minutes) expected = new Date(now.getTime() + me.daily_minutes * 60000).toISOString();
      const rec = { id: crypto.randomUUID(), user_id: me.user_id, user_name: me.display_name, work_date: today, in_at: now.toISOString(),
        in_dist: d, late_min: late, expected_out: expected, out_at: null, out_dist: null, out_source: null, out_approved: true };
      LS.set(K.rec, [rec, ...all]);
      return { ok: true, record: rec };
    }
    if (!open) throw err("출근 기록이 없어요", "not_in");
    if (isStale(open)) return { needs_out_report: true, record: open };
    const store = LS.get(K.store, null);
    open.out_at = new Date().toISOString();
    open.out_source = "punch";
    open.out_dist = pos && store ? Math.round(dist(pos.lat, pos.lng, store.lat, store.lng)) : null;
    LS.set(K.rec, all);
    return { ok: true, record: open, no_location: !pos };
  },
  async attReportOut(id, time) {
    const all = recs(), r = all.find((x) => x.id === id);
    if (!r) throw err("대상 기록을 찾지 못했어요", "not_found");
    const out = kstIso(dateOf(r.in_at), time, r.in_at);
    if (new Date(out) > new Date()) throw err("미래 시각은 입력할 수 없어요", "bad_time");
    r.out_at = out; r.out_source = "self_report"; r.out_approved = false;
    LS.set(K.rec, all);
  },
  async attMine(fromDate) { return recs().filter((r) => r.user_id === meId() && r.work_date >= fromDate).sort((a, b) => b.in_at.localeCompare(a.in_at)); },
  async attAll(fromDate) { return recs().filter((r) => r.work_date >= fromDate).sort((a, b) => b.in_at.localeCompare(a.in_at)); },
  async attEmployees() { return emps(); },
  async attStore() { return { name: "본촌점", ...(LS.get(K.store, {})) }; },
  async attSetStore(lat, lng, radius_m) { LS.set(K.store, { lat, lng, radius_m }); },
  async attSetWork(user_id, f) {
    LS.set(K.emp, emps().map((e) => (e.user_id === user_id ? { ...e, work_type: f.work_type, shift_start: f.shift_start ?? null, shift_end: f.shift_end ?? null, daily_minutes: f.daily_minutes ?? null } : e)));
  },
  async attEdit(id, f, reason) {
    if (!reason?.trim()) throw err("수정 사유를 입력해 주세요");
    const all = recs(), r = all.find((x) => x.id === id);
    if (!r) throw err("기록을 찾지 못했어요", "not_found");
    if (f.in_at) { r.in_at = f.in_at; r.work_date = dateOf(f.in_at); }
    if (f.out_at) { r.out_at = f.out_at; r.out_source = "owner_edit"; r.out_approved = true; }
    if (r.out_at && new Date(r.out_at) <= new Date(r.in_at)) throw err("퇴근 시각이 출근 시각보다 늦어야 해요");
    LS.set(K.rec, all);
  },
  async attApprove(id) { const all = recs(); const r = all.find((x) => x.id === id); if (r) r.out_approved = true; LS.set(K.rec, all); },
  async attAdd(f) {
    if (!f.reason?.trim()) throw err("사유를 입력해 주세요");
    const e = emps().find((x) => x.user_id === f.user_id);
    LS.set(K.rec, [{ id: crypto.randomUUID(), user_id: f.user_id, user_name: e.display_name, work_date: dateOf(f.in_at), in_at: f.in_at,
      out_at: f.out_at, late_min: 0, out_source: "owner_edit", out_approved: true, expected_out: null }, ...recs()]);
  },
  async seedAttendance() {
    const today = todayKST(), out = [];
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.now() + 9 * 3600e3 - i * 86400e3).toISOString().slice(0, 10);
      const emp = i % 2 ? "s2" : "s1";
      const e = emps().find((x) => x.user_id === emp);
      const inT = e.user_id === "s2" ? (i % 4 === 1 ? "17:12" : "16:58") : "07:40";
      const outT = e.user_id === "s2" ? "21:05" : "15:45";
      const inAt = kstIso(d, inT);
      out.push({ id: crypto.randomUUID(), user_id: emp, user_name: e.display_name, work_date: d, in_at: inAt, out_at: i === 3 ? null : kstIso(d, outT),
        late_min: e.user_id === "s2" && i % 4 === 1 ? 12 : 0, expected_out: kstIso(d, outT), out_source: i === 3 ? null : "punch", out_approved: i !== 5, out_dist: i % 6 === 0 ? 240 : 20 });
    }
    LS.set(K.rec, [...out, ...recs()]);
    return today;
  },
  async resetAttendance() { Object.values(K).forEach((k) => localStorage.removeItem(k)); },
};
