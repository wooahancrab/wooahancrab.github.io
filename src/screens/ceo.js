// 우아한F&B 본사(대표용) 총괄 앱: 3개 사업장의 오늘 현황을 한눈에 보고, 사업장을 눌러 관리·지시한다
import { api } from "../lib/api.js";
import { h, toast } from "../lib/ui.js";
import { fmtHM, dateOf, labelMD } from "../lib/kst.js";
import { t, tx } from "../lib/i18n.js";
import { renderOwner, errText } from "./owner.js";
import { renderSuggestAdmin } from "./suggest.js";
import { renderTasksAdmin } from "./tasks-admin.js";
import { renderWork } from "./work.js";
import { renderLibrary } from "./library.js";

// 사업장 짧은 이름(칩·목록용). 화면 언어가 정해진 뒤 그릴 때 평가돼야 해서 함수로 둔다
const shortName = (key) => ({ gejang: t("게장"), ck: "CK", fnb: "F&B" })[key];
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

  const badge = (label, c) => h("span", { class: "badge " + c }, label);

  // 공지 자리(대표·부대표): 총괄 홈 맨 위에만 붙는다. 한 번만 만들어 다시 그려도 같은 자리를 쓴다.
  // 사업장 칩으로 끼워 넣는 owner.js 화면(embedded)에는 공지를 그리지 않아 같은 공지가 두 번 나오지 않는다
  const noticeHost = h("div");
  import("./notices.js").then((m) => m.mountNotices(noticeHost, profile, { inline: true })).catch((e) => console.warn("[공지] 화면을 불러오지 못했어요:", e?.message));

  async function load() {
    try {
      // 보고판용 자료는 한꺼번에 불러와서 첫 화면이 느려지지 않게 한다(실패해도 그 칸만 숨김)
      const extra = Promise.all([
        profile.role === "owner" ? api.sgList().catch(() => []) : Promise.resolve([]),
        api.tkAll(true).catch(() => null), // 전 직원 업무지시 현황
        Promise.all(["work_logs", "work_events", "work_notes"].map((tb) => api.wkList(tb, true))).then(([logs, events, notes]) => ({ logs, events, notes })).catch(() => null),
        api.tkPeople(true).catch(() => ({ people: [] })),
      ]);
      [stores, ov] = await Promise.all([api.listStores(), api.overview()]);
      const [sg, tkRes, w, pp] = await extra;
      sgNew = sg.filter((r) => r.status === "새글").length; tk = tkRes; wk = w; people = pp.people;
      err = "";
      if (sel !== "all" && !stores.some((s) => s.id === sel)) sel = "all";
    } catch (e) { err = e.message; }
    draw();
    // 프로젝트 안 읽음 숫자는 따로(느려도 첫 화면을 막지 않는다)
    import("./projects.js").then((m) => m.pjSummary()).then((s) => { if (s.newPosts !== pjNew) { pjNew = s.newPosts; if (sel === "all" && !pjOpen && !aiOpen && !libOpen && !wkOpen && !tkOpen && !sgOpen && !accountsOpen) draw(); } }).catch(() => {});
  }

  function choose(id) {
    sel = id;
    try { localStorage.setItem("woo_ceo_sel", id); } catch { /* 무시 */ }
    draw();
  }

  function chips() {
    return h("div", { class: "chips-bar" }, [{ id: "all", label: t("전체") }, ...stores.map((s) => ({ id: s.id, label: shortName(s.app_key) ?? s.name }))].map((c) =>
      h("button", { class: "chip" + (sel === c.id ? " on" : ""), onclick: () => choose(c.id) }, c.label)));
  }

  function needs(st) {
    const a = st.attendance;
    const n = [];
    if (a.not_in) n.push([t("미출근 {n}", { n: a.not_in }), "bad"]);
    if (a.missing_out) n.push([t("퇴근 누락 {n}", { n: a.missing_out }), "bad"]);
    if (a.pending_approval) n.push([t("승인 대기 {n}", { n: a.pending_approval }), "info"]);
    if (st.kind !== "restaurant") { /* CK·F&B는 클레임 없음 */ }
    else if (st.claims.severe) n.push([t("중대 클레임 {n}", { n: st.claims.severe }), "bad"]);
    else if (st.claims.open) n.push([t("클레임 처리 중 {n}", { n: st.claims.open }), "warn"]);
    if (st.report && !st.report.submitted && !st.closed) n.push([t("일일보고 미제출"), "warn"]);
    if (st.report?.has_claim) n.push([t("클레임 있음"), "warn"]);
    if (st.report?.has_request) n.push([t("요청사항"), "info"]);
    return n;
  }

  function card(st) {
    const a = st.attendance;
    const alerts = needs(st);
    return h("button", { class: "scard", onclick: () => choose(st.id) },
      h("div", { class: "top2" }, h("b", null, `${KIND_ICON[st.kind] ?? ""} ${st.display_name}`), st.closed ? badge(tx("총괄", "휴무"), "warn2") : alerts.some(([, c]) => c === "bad") ? badge(t("확인 필요"), "bad") : badge(tx("총괄", "정상"), "ok")),
      h("div", { class: "srow" }, h("span", null, t("👥 출근")), h("b", null, t("{n} / {total}명", { n: a.in_today, total: st.people })), a.working > 0 && h("span", { class: "muted" }, t("근무 중 {n}", { n: a.working }))),
      st.kind === "restaurant" && h("div", { class: "srow" }, h("span", null, "📣 " + t("클레임")), h("b", null, st.claims.open ? t("{n}건 진행 중", { n: st.claims.open }) : tx("총괄", "없음"))),
      st.report && h("div", { class: "srow" }, h("span", null, "📝 " + t("일일보고")), h("b", null, st.report.submitted ? t("제출 {time}", { time: fmtHM(st.report.at) }) : st.closed ? tx("총괄", "휴무") : t("미제출"))),
      alerts.length > 0 && h("div", { class: "badges", style: "justify-content:flex-start;margin-top:6px" }, alerts.map(([label, c]) => badge(label, c))));
  }

  // 보고판: 업무지시(진행·밀림·완료)·일일보고·건의함을 한 화면에서 훑어본다. 타일을 누르면 해당 화면으로.
  function board() {
    const tile = (label, big, sub, cls, onclick) => h("button", { class: "scard", style: "flex:1;min-width:130px;text-align:left", onclick },
      h("div", { class: "muted" }, label), h("b", { class: cls, style: "font-size:20px" }, big), h("div", { class: "muted" }, sub));
    const sname = (id) => shortName(stores.find((s) => s.id === id)?.app_key) ?? "";
    const open = tk?.open ?? [], late = open.filter((x) => x.due_date && x.due_date < tk.today);
    const doneToday = (tk?.done ?? []).filter((x) => x.done_at && dateOf(x.done_at) === tk.today);
    const reps = ov.stores.filter((s) => s.report && !s.closed), repOk = reps.filter((s) => s.report.submitted).length;
    const recent = tk ? [
      ...late.slice(0, 5).map((x) => ({ k: 0, icon: "⚠", cls: "err", text: `${sname(x.store_id)} ${x.assignee_name} · ${x.title}`, sub: t("마감 {d} 지남", { d: labelMD(x.due_date) }) })),
      ...(tk.done ?? []).slice(0, 6).map((x) => ({ k: 1, icon: "✅", cls: "ok-text", text: `${sname(x.store_id)} ${x.done_by_name || x.assignee_name} · ${x.title}`, sub: `${labelMD(dateOf(x.done_at))} ${fmtHM(x.done_at)}${x.done_note ? " — " + x.done_note : ""}` })),
    ] : [];
    return h("div", null,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:10px 0" },
        tk && tile(t("📌 업무지시"), t("진행 {n}건", { n: open.length }), t("밀림 {late} · 오늘 완료 {done}", { late: late.length, done: doneToday.length }), late.length ? "err" : "", () => { tkOpen = true; draw(); }),
        reps.length > 0 && tile("📝 " + t("일일보고"), t("{ok} / {total} 제출", { ok: repOk, total: reps.length }), repOk === reps.length ? t("모두 제출") : t("미제출 {names}", { names: reps.filter((s) => !s.report.submitted).map((s) => shortName(s.app_key) ?? s.name).join(", ") }), repOk < reps.length ? "err" : "ok-text", () => choose(reps.find((s) => !s.report.submitted)?.id ?? reps[0].id)),
        tile("📂 " + t("프로젝트"), pjNew ? t("안 읽음 {n}", { n: pjNew }) : t("새 글 없음"), t("눌러서 보기"), pjNew ? "err" : "", () => { pjOpen = true; draw(); }),
        profile.role === "owner" && tile(t("💌 건의함"), sgNew ? t("새 건의 {n}", { n: sgNew }) : t("새 건의 없음"), t("눌러서 보기"), sgNew ? "err" : "", () => { sgOpen = true; draw(); })),
      recent.length > 0 && h("div", null, h("div", { class: "sub-title" }, t("최근 업무 보고")),
        recent.map((r) => h("div", { class: "lrow", style: "align-items:flex-start" }, h("span", { class: r.cls }, r.icon + " " + r.text, h("div", { class: "muted" }, r.sub))))),
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
    // 업무 기록 구역 = 대분류(굵은 선, .sec). 안의 일지·일정·기록함 제목은 소분류(연한 밑줄, .sub-title)
    const head = (label, extra, first) => h("div", { class: "sec-head sub-title", style: first ? "margin-top:0" : null }, h("b", null, label), extra);
    return h("div", { class: "sec" },
      head(t("📝 오늘 업무 일지 ({n}명 작성)", { n: `${logs.length}${people.length ? " / " + people.length : ""}` }), null, true),
      logs.length ? logs.map((l) => h("details", { style: "margin:8px 0;padding:2px 12px;border:1px solid var(--line);border-radius:var(--r-md)" },
        h("summary", { style: "padding:8px 0;cursor:pointer" }, h("b", null, `${sname(l.store_id)} ${l.author_name}`), h("span", { class: "muted" }, "  " + (l.done || l.plan || "").split("\n")[0].slice(0, 40))),
        l.done && h("div", { style: "white-space:pre-wrap;margin:4px 0 8px" }, h("b", null, t("한 일") + "  "), l.done),
        l.plan && h("div", { style: "white-space:pre-wrap;margin:4px 0 8px" }, h("b", null, t("내일") + "  "), l.plan),
        l.blockers && h("div", { class: "err", style: "white-space:pre-wrap;margin:4px 0 8px" }, t("막힌 점") + "  " + l.blockers))) : h("p", { class: "muted", style: "margin:4px 0" }, t("오늘 작성된 일지가 아직 없어요")),
      missing.length > 0 && people.length > 0 && h("p", { class: "muted", style: "margin:4px 0" }, t("미작성: {names}", { names: missing.slice(0, 12).map((p) => p.display_name).join(", ") }) + (missing.length > 12 ? " " + t("외 {n}명", { n: missing.length - 12 }) : "")),
      head(t("📅 다가오는 일정"), overdue ? h("span", { class: "err" }, t("결과 없이 지난 일정 {n}건", { n: overdue })) : null),
      upcoming.length ? upcoming.map((e) => h("div", { class: "lrow" }, h("span", null, `${labelMD(e.ev_date)}${e.end_date && e.end_date !== e.ev_date ? "~" + labelMD(e.end_date) : ""}${e.ev_time ? " " + e.ev_time : ""} · ${e.title}`), h("span", { class: "muted" }, `${sname(e.store_id)} ${e.author_name}`))) : h("p", { class: "muted", style: "margin:4px 0" }, t("예정된 일정이 없어요")),
      head(t("🗂 최근 기록함"), null),
      notes.length ? notes.map((n) => h("div", { class: "lrow" }, h("span", null, n.title, n.tags ? h("span", { class: "muted" }, "  " + n.tags.split(",").map((x) => "#" + x.trim()).filter((x) => x.length > 1).join(" ")) : null), h("span", { class: "muted" }, `${sname(n.store_id)} ${n.author_name}`))) : h("p", { class: "muted", style: "margin:4px 0" }, t("기록이 없어요")),
      h("button", { class: "btn ghost slim", style: "margin-top:8px", onclick: () => { wkOpen = true; draw(); } }, t("🗂 전체 업무 기록 열기")));
  }

  function allView() {
    const totalBad = ov.stores.reduce((s, st) => s + needs(st).filter(([, c]) => c === "bad").length, 0);
    return h("div", null,
      // 대분류 3칸(굵은 선): 오늘 현황 / 업무 기록(wkBoard 안) / 사업장별 현황. 칸 안의 항목은 연한 선
      h("section", { class: "sec", style: "margin-top:0" }, h("h2", { class: "sec-title" }, t("오늘 한눈에")),
        totalBad > 0 ? h("p", { class: "alert", style: "margin:0 0 12px" }, t("확인이 필요한 항목 {n}건", { n: totalBad })) : h("p", { class: "muted" }, t("지금 밀린 항목이 없어요 👍")),
        board()),
      // 핵심 버튼(레드 채움)은 말로 업무지시 하나. 나머지 이동은 한 덩어리 행 목록(.rowlist + .chev)
      h("button", { class: "btn primary", style: "width:100%;margin-top:20px", onclick: () => { aiOpen = true; draw(); } }, t("🗣 말로 업무지시 (AI)")),
      h("div", { class: "rowlist", style: "margin:8px 0" },
        h("button", { class: "item", onclick: () => { tkOpen = true; draw(); } }, t("📌 업무지시 (전 직원)"), h("span", { class: "chev", "aria-hidden": "true" })),
        h("button", { class: "item", onclick: () => { libOpen = true; draw(); } }, t("📁 서식·자료함"), h("span", { class: "chev", "aria-hidden": "true" })),
        h("button", { class: "item", onclick: () => { pjOpen = true; draw(); } }, "📂 " + t("프로젝트"), h("span", { class: "chev", "aria-hidden": "true" }))),
      h("div", { class: "list sec" }, ov.stores.map(card)),
      // 대표(마스터)만: 모든 사업장 계정을 한 곳에서 관리 (부대표는 전체 소속)
      profile.role === "owner" && h("button", { class: "btn ghost", style: "margin-top:12px", onclick: () => { accountsOpen = true; draw(); } }, t("👤 전체 계정 관리 (사업장·부대표 포함)")),
      // 건의함은 대표만(부대표도 못 봄)
      profile.role === "owner" && h("button", { class: "btn ghost", style: "margin-top:8px", onclick: () => { sgOpen = true; draw(); } }, t("💌 건의함") + (sgNew > 0 ? ` (${t("새 건의 {n}", { n: sgNew })})` : "")));
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
    }).catch((e) => holder.replaceChildren(h("p", { class: "err", style: "padding:16px" }, t("프로젝트 화면을 불러오지 못했어요: {msg}", { msg: errText(e.message) }))));
    return holder;
  }

  function aiView() {
    const holder = h("div");
    import("./ai-task.js").then((m) => m.renderAiTask(holder, { onBack: () => { aiOpen = false; draw(); } }))
      .catch((e) => holder.replaceChildren(h("p", { class: "err", style: "padding:16px" }, t("말로 업무지시 화면을 불러오지 못했어요: {msg}", { msg: errText(e.message) }))));
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

  // 하위 화면(업무지시·자료함·프로젝트 등)을 열 때 보던 자리를 기억해 두었다가, "← 목록"으로 돌아오면 그 자리로 되돌린다
  let boardY = 0, wasSub = false, wasSel = sel;
  function draw() {
    let y = scrollY;
    const sub = sel === "all" && (pjOpen || aiOpen || libOpen || wkOpen || tkOpen || sgOpen || accountsOpen);
    if (sub && !wasSub && wasSel === "all") { boardY = y; y = 0; } // 새 화면은 맨 위에서 시작(예전에는 그리는 도중 짧아졌다 늘어나며 저절로 맨 위가 됐다)
    else if (!sub && wasSub && sel === "all" && wasSel === "all") y = boardY;
    wasSub = sub; wasSel = sel;
    if (sel === "all") api.setStore(null);
    root.replaceChildren(h("div", { class: "page", style: "padding-bottom:0" }, chips()),
      // 알림을 눌러 들어온 프로젝트는 다른 자료가 늦거나 실패해도 바로 열린다
      pjOpen && sel === "all" ? pjView()
        : err ? h("div", { class: "page" }, h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: errText(err) })), h("button", { class: "btn ghost", onclick: load }, t("다시 시도")))
        : !ov ? h("div", { class: "page" }, h("p", { class: "muted" }, t("불러오는 중…")))
        : sel === "all" ? (aiOpen ? aiView() : pjOpen ? pjView() : libOpen ? libView() : wkOpen ? wkView() : tkOpen ? tkView() : sgOpen ? sgView() : accountsOpen ? accountsView() : h("div", { class: "page" }, noticeHost, allView())) : storeView());
    scrollTo(0, y);
  }

  draw();
  await load();
  void toast;
}
