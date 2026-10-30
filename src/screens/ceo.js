// 우아한F&B 본사(대표용) 총괄 앱: 3개 사업장의 오늘 현황을 한눈에 보고, 사업장을 눌러 관리·지시한다
import { api } from "../lib/api.js";
import { h, toast } from "../lib/ui.js";
import { fmtHM, dateOf, labelMD } from "../lib/kst.js";
import { renderOwner } from "./owner.js";
import { renderSuggestAdmin } from "./suggest.js";
import { renderTasksAdmin } from "./tasks-admin.js";
import { renderWork } from "./work.js";
import { renderLibrary } from "./library.js";

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };
const KIND_ICON = { restaurant: "🦀", ck: "🏭", hq: "🏢" };

export async function renderCeo(root, profile) {
  let stores = [];
  let ov = null;
  let err = "";
  let sel = "all";
  let accountsOpen = false; // 전체 계정 관리 화면
  let sgOpen = false, sgNew = 0; // 건의함 화면(대표만)
  let tkOpen = false; // 전 직원 업무지시 화면
  let pjNew = 0; // 프로젝트 안 읽은 글(내가 참여한 프로젝트)
  let tk = null; // 업무지시 현황 {today, open, done}
  let libOpen = false; // 서식·자료함 화면
  let aiOpen = false; // 말로 업무지시(AI) 화면
  // 프로젝트 화면(대표·부대표). ?p=프로젝트&post=글 주소로 들어오면 바로 그 프로젝트를 연다
  const dl = new URLSearchParams(location.search);
  let pjOpts = { openId: dl.get("p") || null, postId: dl.get("post") || null };
  let pjOpen = !!pjOpts.openId;
  let wk = null, people = [], wkOpen = false; // 업무 기록(일지·일정·기록함) 전체, 직원 목록, 전체 기록 화면
  try { sel = localStorage.getItem("woo_ceo_sel") || "all"; } catch { /* 저장소를 못 쓰는 환경 */ }
  if (pjOpen) sel = "all";

  const badge = (t, c) => h("span", { class: "badge " + c }, t);

  async function load() {
    try {
      // 보고판용 자료는 한꺼번에 불러와서 첫 화면이 느려지지 않게 한다(실패해도 그 칸만 숨김)
      const extra = Promise.all([
        profile.role === "owner" ? api.sgList().catch(() => []) : Promise.resolve([]),
        api.tkAll(true).catch(() => null), // 전 직원 업무지시 현황
        Promise.all(["work_logs", "work_events", "work_notes"].map((t) => api.wkList(t, true))).then(([logs, events, notes]) => ({ logs, events, notes })).catch(() => null),
        api.tkPeople(true).catch(() => ({ people: [] })),
      ]);
      [stores, ov] = await Promise.all([api.listStores(), api.overview()]);
      const [sg, t, w, pp] = await extra;
      sgNew = sg.filter((r) => r.status === "새글").length; tk = t; wk = w; people = pp.people;
      err = "";
      if (sel !== "all" && !stores.some((s) => s.id === sel)) sel = "all";
    } catch (e) { err = e.message; }
    draw();
    // 프로젝트 안 읽음 숫자는 따로(느려도 첫 화면을 막지 않는다)
    import("./projects.js").then((m) => m.pjSummary()).then((s) => { if (s.newPosts !== pjNew) { pjNew = s.newPosts; if (sel === "all" && !pjOpen && !libOpen && !wkOpen && !tkOpen && !sgOpen && !accountsOpen) draw(); } }).catch(() => {});
  }

  function choose(id) {
    sel = id;
    try { localStorage.setItem("woo_ceo_sel", id); } catch { /* 무시 */ }
    draw();
  }

  function chips() {
    return h("div", { class: "chips-bar" }, [{ id: "all", label: "전체" }, ...stores.map((s) => ({ id: s.id, label: SHORT[s.app_key] ?? s.name }))].map((c) =>
      h("button", { class: "chip" + (sel === c.id ? " on" : ""), onclick: () => choose(c.id) }, c.label)));
  }

  function needs(st) {
    const a = st.attendance;
    const n = [];
    if (a.not_in) n.push(["미출근 " + a.not_in, "bad"]);
    if (a.missing_out) n.push(["퇴근 누락 " + a.missing_out, "bad"]);
    if (a.pending_approval) n.push(["승인 대기 " + a.pending_approval, "info"]);
    if (st.kind !== "restaurant") { /* CK·F&B는 클레임 없음 */ }
    else if (st.claims.severe) n.push(["중대 클레임 " + st.claims.severe, "bad"]);
    else if (st.claims.open) n.push(["클레임 처리 중 " + st.claims.open, "warn"]);
    if (st.report && !st.report.submitted && !st.closed) n.push(["일일보고 미제출", "warn"]);
    if (st.report?.has_claim) n.push(["클레임 있음", "warn"]);
    if (st.report?.has_request) n.push(["요청사항", "info"]);
    return n;
  }

  function card(st) {
    const a = st.attendance;
    const alerts = needs(st);
    return h("button", { class: "scard", onclick: () => choose(st.id) },
      h("div", { class: "top2" }, h("b", null, `${KIND_ICON[st.kind] ?? ""} ${st.display_name}`), st.closed ? badge("휴무", "warn2") : alerts.some(([, c]) => c === "bad") ? badge("확인 필요", "bad") : badge("정상", "ok")),
      h("div", { class: "srow" }, h("span", null, "👥 출근"), h("b", null, `${a.in_today} / ${st.people}명`), a.working > 0 && h("span", { class: "muted" }, `근무 중 ${a.working}`)),
      st.kind === "restaurant" && h("div", { class: "srow" }, h("span", null, "📣 클레임"), h("b", null, st.claims.open ? `${st.claims.open}건 진행 중` : "없음")),
      st.report && h("div", { class: "srow" }, h("span", null, "📝 일일보고"), h("b", null, st.report.submitted ? "제출 " + fmtHM(st.report.at) : st.closed ? "휴무" : "미제출")),
      alerts.length > 0 && h("div", { class: "badges", style: "justify-content:flex-start;margin-top:6px" }, alerts.map(([t, c]) => badge(t, c))));
  }

  // 보고판: 업무지시(진행·밀림·완료)·일일보고·건의함을 한 화면에서 훑어본다. 타일을 누르면 해당 화면으로.
  function board() {
    const tile = (icon, title, big, sub, cls, onclick) => h("button", { class: "scard", style: "flex:1;min-width:130px;text-align:left", onclick },
      h("div", { class: "muted", style: "font-size:12px" }, icon + " " + title), h("b", { class: cls, style: "font-size:20px" }, big), h("div", { class: "muted", style: "font-size:12px" }, sub));
    const sname = (id) => SHORT[stores.find((s) => s.id === id)?.app_key] ?? "";
    const open = tk?.open ?? [], late = open.filter((t) => t.due_date && t.due_date < tk.today);
    const doneToday = (tk?.done ?? []).filter((t) => t.done_at && dateOf(t.done_at) === tk.today);
    const reps = ov.stores.filter((s) => s.report && !s.closed), repOk = reps.filter((s) => s.report.submitted).length;
    const recent = tk ? [
      ...late.slice(0, 5).map((t) => ({ k: 0, icon: "⚠", cls: "err", text: `${sname(t.store_id)} ${t.assignee_name} · ${t.title}`, sub: `마감 ${labelMD(t.due_date)} 지남` })),
      ...(tk.done ?? []).slice(0, 6).map((t) => ({ k: 1, icon: "✅", cls: "ok-text", text: `${sname(t.store_id)} ${t.done_by_name || t.assignee_name} · ${t.title}`, sub: `${labelMD(dateOf(t.done_at))} ${fmtHM(t.done_at)}${t.done_note ? " — " + t.done_note : ""}` })),
    ] : [];
    return h("div", null,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:10px 0" },
        tk && tile("📌", "업무지시", `진행 ${open.length}건`, `밀림 ${late.length} · 오늘 완료 ${doneToday.length}`, late.length ? "err" : "", () => { tkOpen = true; draw(); }),
        reps.length > 0 && tile("📝", "일일보고", `${repOk} / ${reps.length} 제출`, repOk === reps.length ? "모두 제출" : "미제출 " + reps.filter((s) => !s.report.submitted).map((s) => SHORT[s.app_key] ?? s.name).join(", "), repOk < reps.length ? "err" : "ok-text", () => choose(reps.find((s) => !s.report.submitted)?.id ?? reps[0].id)),
        tile("📂", "프로젝트", pjNew ? `안 읽음 ${pjNew}` : "새 글 없음", "눌러서 보기", pjNew ? "err" : "", () => { pjOpen = true; draw(); }),
        profile.role === "owner" && tile("💌", "건의함", sgNew ? `새 건의 ${sgNew}` : "새 건의 없음", "눌러서 보기", sgNew ? "err" : "", () => { sgOpen = true; draw(); })),
      recent.length > 0 && h("div", null, h("div", { class: "muted", style: "font-size:12px;margin:4px 0" }, "최근 업무 보고"),
        recent.map((r) => h("div", { class: "srow", style: "align-items:flex-start" }, h("span", { class: r.cls }, r.icon + " " + r.text, h("div", { class: "muted", style: "font-size:12px" }, r.sub))))),
      wkBoard(sname));
  }

  // 업무 기록 보고판: 오늘 전 직원 일지, 다가오는 일정, 최근 기록함
  function wkBoard(sname) {
    if (!wk) return null;
    const today = tk?.today ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const logs = wk.logs.filter((l) => l.log_date === today);
    const wrote = new Set(logs.map((l) => l.author_id));
    const missing = people.filter((p) => !wrote.has(p.user_id));
    const events = wk.events.filter((e) => !e.done);
    const endOf = (e) => e.end_date || e.ev_date;
    const upcoming = events.filter((e) => endOf(e) >= today).sort((a, b) => (a.ev_date + a.ev_time).localeCompare(b.ev_date + b.ev_time)).slice(0, 6);
    const overdue = events.filter((e) => endOf(e) < today).length;
    const notes = wk.notes.slice(0, 5);
    const head = (t, extra) => h("div", { style: "margin:12px 0 4px;display:flex;justify-content:space-between;align-items:baseline" }, h("b", null, t), extra);
    return h("div", null,
      head(`📝 오늘 업무 일지 (${logs.length}${people.length ? " / " + people.length : ""}명 작성)`, null),
      logs.length ? logs.map((l) => h("details", { style: "margin:4px 0;padding:6px 10px;border:1px solid #ddd;border-radius:10px" },
        h("summary", null, h("b", null, `${sname(l.store_id)} ${l.author_name}`), h("span", { class: "muted", style: "font-size:13px" }, "  " + (l.done || l.plan || "").split("\n")[0].slice(0, 40))),
        l.done && h("div", { style: "white-space:pre-wrap;margin-top:4px" }, h("b", null, "한 일  "), l.done),
        l.plan && h("div", { style: "white-space:pre-wrap;margin-top:4px" }, h("b", null, "내일  "), l.plan),
        l.blockers && h("div", { class: "err", style: "white-space:pre-wrap;margin-top:4px" }, "막힌 점  " + l.blockers))) : h("p", { class: "muted", style: "margin:4px 0" }, "오늘 작성된 일지가 아직 없어요"),
      missing.length > 0 && people.length > 0 && h("p", { class: "muted", style: "font-size:12px;margin:4px 0" }, "미작성: " + missing.slice(0, 12).map((p) => p.display_name).join(", ") + (missing.length > 12 ? ` 외 ${missing.length - 12}명` : "")),
      head("📅 다가오는 일정", overdue ? h("span", { class: "err", style: "font-size:12px" }, `결과 없이 지난 일정 ${overdue}건`) : null),
      upcoming.length ? upcoming.map((e) => h("div", { class: "srow" }, h("span", null, `${labelMD(e.ev_date)}${e.end_date && e.end_date !== e.ev_date ? "~" + labelMD(e.end_date) : ""}${e.ev_time ? " " + e.ev_time : ""} · ${e.title}`), h("span", { class: "muted" }, `${sname(e.store_id)} ${e.author_name}`))) : h("p", { class: "muted", style: "margin:4px 0" }, "예정된 일정이 없어요"),
      head("🗂 최근 기록함", null),
      notes.length ? notes.map((n) => h("div", { class: "srow" }, h("span", null, n.title, n.tags ? h("span", { class: "muted", style: "font-size:12px" }, "  " + n.tags.split(",").map((x) => "#" + x.trim()).filter((x) => x.length > 1).join(" ")) : null), h("span", { class: "muted" }, `${sname(n.store_id)} ${n.author_name}`))) : h("p", { class: "muted", style: "margin:4px 0" }, "기록이 없어요"),
      h("button", { class: "btn ghost slim", style: "margin-top:8px", onclick: () => { wkOpen = true; draw(); } }, "🗂 전체 업무 기록 열기"));
  }

  function allView() {
    const totalBad = ov.stores.reduce((s, st) => s + needs(st).filter(([, c]) => c === "bad").length, 0);
    return h("div", null,
      h("section", { class: "card" }, h("h2", null, "오늘 한눈에"),
        totalBad > 0 ? h("p", { class: "err" }, `확인이 필요한 항목 ${totalBad}건`) : h("p", { class: "muted" }, "지금 밀린 항목이 없어요 👍"),
        board()),
      h("button", { class: "btn primary", style: "width:100%;margin-top:8px", onclick: () => { aiOpen = true; draw(); } }, "🗣 말로 업무지시 (AI)"),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0" },
        h("button", { class: "btn primary", style: "flex:1", onclick: () => { tkOpen = true; draw(); } }, "📌 업무지시 (전 직원)"),
        h("button", { class: "btn primary", style: "flex:1", onclick: () => { libOpen = true; draw(); } }, "📁 서식·자료함"),
        h("button", { class: "btn primary", style: "flex:1", onclick: () => { pjOpen = true; draw(); } }, "📂 프로젝트")),
      h("div", { class: "list" }, ov.stores.map(card)),
      // 대표(마스터)만: 모든 사업장 계정을 한 곳에서 관리 (부대표는 전체 소속)
      profile.role === "owner" && h("button", { class: "btn ghost", style: "margin-top:12px", onclick: () => { accountsOpen = true; draw(); } }, "👤 전체 계정 관리 (사업장·부대표 포함)"),
      // 건의함은 대표만(부대표도 못 봄)
      profile.role === "owner" && h("button", { class: "btn ghost", style: "margin-top:8px", onclick: () => { sgOpen = true; draw(); } }, `💌 건의함${sgNew > 0 ? ` (새 건의 ${sgNew})` : ""}`));
  }

  function accountsView() {
    const holder = h("div", { id: "ceo-accounts" });
    api.setStore(null);
    renderOwner(holder, profile, { allAccounts: true, stores, onBack: () => { accountsOpen = false; draw(); } });
    return holder;
  }

  function tkView() {
    const holder = h("div");
    renderTasksAdmin(holder, () => { tkOpen = false; draw(); }, { all: true });
    return holder;
  }

  function pjView() {
    const holder = h("div");
    import("./projects.js").then((m) => {
      const o = pjOpts; pjOpts = {};
      if (o.openId) { try { history.replaceState(history.state, "", location.pathname); } catch { /* 무시 */ } }
      return m.renderProjects(holder, { ...o, onBack: () => { pjOpen = false; draw(); } });
    }).catch((e) => holder.replaceChildren(h("p", { class: "err", style: "padding:16px" }, "프로젝트 화면을 불러오지 못했어요: " + e.message)));
    return holder;
  }

  function aiView() {
    const holder = h("div");
    import("./ai-task.js").then((m) => m.renderAiTask(holder, { onBack: () => { aiOpen = false; draw(); } }))
      .catch((e) => holder.replaceChildren(h("p", { class: "err", style: "padding:16px" }, "말로 업무지시 화면을 불러오지 못했어요: " + e.message)));
    return holder;
  }

  function libView() {
    const holder = h("div");
    renderLibrary(holder, { onBack: () => { libOpen = false; draw(); } });
    return holder;
  }

  function wkView() {
    const holder = h("div");
    renderWork(holder, { all: true, stores, onBack: () => { wkOpen = false; load(); } });
    return holder;
  }

  function sgView() {
    const holder = h("div");
    renderSuggestAdmin(holder, () => { sgOpen = false; load(); });
    return holder;
  }

  function storeView() {
    const st = stores.find((s) => s.id === sel);
    api.setStore(st);
    const holder = h("div", { id: "ceo-store" });
    renderOwner(holder, profile, { store: st, embedded: true });
    return holder;
  }

  function draw() {
    const y = scrollY;
    if (sel === "all") api.setStore(null);
    root.replaceChildren(h("div", { class: "page", style: "padding-bottom:0" }, chips()),
      // 알림을 눌러 들어온 프로젝트는 다른 자료가 늦거나 실패해도 바로 열린다
      pjOpen && sel === "all" ? pjView()
        : err ? h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"))
        : !ov ? h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…"))
        : sel === "all" ? (aiOpen ? aiView() : pjOpen ? pjView() : libOpen ? libView() : wkOpen ? wkView() : tkOpen ? tkView() : sgOpen ? sgView() : accountsOpen ? accountsView() : h("div", { class: "page" }, allView())) : storeView());
    scrollTo(0, y);
  }

  draw();
  await load();
  void toast;
}
