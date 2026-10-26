// 데모 모드 클레임 추적 (이 기기 localStorage 안에서만 동작)
import { todayKST } from "./kst.js";

const LS = {
  get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const KEY = "woo_demo_claims";
const err = (message, code = "error") => Object.assign(new Error(message), { code });
const role = () => LS.get("woo_demo_session", {}).role ?? "staff";
const meName = () => ({ staff: "김자유(데모)", manager: "매니저(데모)", owner: "대표(데모)" }[role()]);
const canManage = () => role() !== "staff";

export const claimsDemo = {
  async clList(scope = "open") {
    const all = LS.get(KEY, []);
    const rows = scope === "done" ? all.filter((c) => c.status === "done") : all.filter((c) => c.status !== "done");
    rows.sort((a, b) => (b.severity === "severe") - (a.severity === "severe") || b.created_at.localeCompare(a.created_at));
    return { can_manage: canManage(), claims: rows };
  },
  async clCreate({ content, severity, claim_date }) {
    if (!content?.trim()) throw err("클레임 내용을 입력해 주세요");
    const all = LS.get(KEY, []);
    const now = new Date().toISOString();
    all.push({
      id: crypto.randomUUID(), claim_date: claim_date || todayKST(), content: content.trim(), severity: severity === "severe" ? "severe" : "normal",
      status: "open", reported_name: meName(), created_at: now, resolved_at: null, resolved_by_name: "",
      events: [{ kind: "created", note: "", by_name: meName(), at: now }],
    });
    LS.set(KEY, all);
  },
  async clNote(id, note) {
    if (!note?.trim()) throw err("내용을 입력해 주세요");
    const all = LS.get(KEY, []);
    all.find((c) => c.id === id)?.events.push({ kind: "note", note: note.trim(), by_name: meName(), at: new Date().toISOString() });
    LS.set(KEY, all);
  },
  async clStatus(id, status, note = "") {
    if (!canManage()) throw err("매니저·대표만 처리 상태를 바꿀 수 있어요", "forbidden");
    if (status === "done" && !note.trim()) throw err("해결 내용을 한 줄 적어 주세요");
    const all = LS.get(KEY, []);
    const c = all.find((x) => x.id === id);
    if (!c) throw err("클레임을 찾지 못했어요", "not_found");
    const now = new Date().toISOString();
    c.status = status;
    c.resolved_at = status === "done" ? now : null;
    c.resolved_by_name = status === "done" ? meName() : "";
    const label = { open: "접수로 되돌림", working: "처리 중", done: "해결 완료" }[status];
    c.events.push({ kind: "status", note: note.trim() ? `${label} — ${note.trim()}` : label, by_name: meName(), at: now });
    LS.set(KEY, all);
  },
};
