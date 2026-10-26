import { api, isDemo } from "../lib/api.js";
import { h, toast, copyText, seg, confirmDialog, promptPassword, passwordField, modal } from "../lib/ui.js";
import { todayKST, addDays, labelMD, monthKey, monthLabel } from "../lib/kst.js";
import { renderAttendanceAdmin } from "./attendance-admin.js";
import { renderClaims } from "./claims.js";
import { renderChecklistAdmin } from "./checklist-admin.js";
import { renderTasksAdmin } from "./tasks-admin.js";
import { renderSettle } from "./settle.js";
import { renderSales } from "./sales.js";
import { attText, claimText, claimItems, checkText, kakaoText, summarize, normalize } from "../lib/report.js";

export async function renderOwner(root, ctx, opts = {}) {
  const today = todayKST();
  // 일일보고는 식당(우아한게장)만 쓴다. CK·F&B 사업장은 클레임·출퇴근·계정만 보인다.
  const hasReport = !opts.store || opts.store.kind === "restaurant";
  let tab = "list"; // list | claims | stats
  let detail = null;
  let rows = [];
  let loading = true;
  let err = null;
  let showAccounts = !!opts.allAccounts; // 총괄 앱의 "전체 계정" 화면이면 처음부터 계정 화면
  let showAtt = false;
  let showSettle = false;
  let showSales = false;
  let showCl = false;
  let showChk = false;
  let showTk = false;
  let clOpen = null;
  let users = [];
  let usersMsg = "";
  let usersBusy = false;
  const bulk = { text: "", role: "staff", busy: false, result: null };
  // 헷갈리는 글자(0/O, 1/l/I)를 뺀 임시 비밀번호
  const genPw = () => {
    const ch = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const a = crypto.getRandomValues(new Uint32Array(10));
    return Array.from(a, (n) => ch[n % ch.length]).join("");
  };
  const newAcc = { name: "", title: "", email: "", password: "", password2: "", role: "manager" };
  // 전체 계정 화면에서 새 계정을 어느 사업장에 넣을지 (부대표는 사업장 없이 전체 소속)
  const pick = { store: opts.stores?.[0]?.id ?? null };
  const storeName = (id) => opts.stores?.find((s) => s.id === id)?.display_name ?? "";
  const storePicker = () => opts.allAccounts && opts.stores?.length
    ? h("div", { class: "stack" }, h("label", { class: "lbl" }, "소속 사업장 (부대표는 전체 소속이라 무시돼요)"),
        seg(opts.stores.map((s) => [s.id, s.display_name || s.name]), pick.store, (v) => { pick.store = v; draw(); }))
    : null;
  const ROLE_KO = { owner: "대표", deputy: "부대표", manager: "매니저", supervisor: "중간관리자", staff: "직원" };
  const isMaster = ctx.role === "owner"; // 부대표는 계정·설정을 바꿀 수 없다

  const draw = () => {
    const y = scrollY;
    if (showTk) {
      const holder = h("div");
      root.replaceChildren(holder);
      renderTasksAdmin(holder, () => { showTk = false; draw(); });
      scrollTo(0, 0);
      return;
    }
    if (showChk) {
      const holder = h("div");
      root.replaceChildren(holder);
      renderChecklistAdmin(holder, () => { showChk = false; draw(); }, { master: isMaster });
      scrollTo(0, 0);
      return;
    }
    if (showCl) {
      const holder = h("div", { class: "page", style: "padding-bottom:0" },
        h("button", { class: "linkbtn back", onclick: () => { showCl = false; loadCl(); draw(); } }, "← 목록"), h("h1", null, "클레임 후속조치"));
      const body = h("div");
      root.replaceChildren(holder, body);
      renderClaims(body);
      scrollTo(0, 0);
      return;
    }
    if (showSales) {
      const holder = h("div");
      root.replaceChildren(holder);
      renderSales(holder, () => { showSales = false; draw(); }, { master: isMaster, onOpenSettle: () => { showSales = false; showSettle = true; draw(); } });
      scrollTo(0, 0);
      return;
    }
    if (showSettle) {
      const holder = h("div");
      root.replaceChildren(holder);
      renderSettle(holder, () => { showSettle = false; draw(); });
      scrollTo(0, 0);
      return;
    }
    if (showAtt) {
      const holder = h("div");
      root.replaceChildren(holder);
      renderAttendanceAdmin(holder, () => { showAtt = false; draw(); }, { master: isMaster });
      scrollTo(0, 0);
      return;
    }
    root.replaceChildren(showAccounts ? accountsView() : detail ? detailView() : main());
    scrollTo(0, showAccounts || detail ? 0 : y);
  };

  async function loadUsers() {
    usersBusy = true; usersMsg = ""; draw();
    try { users = (await api.adminUsers({ action: "list" })).users; } catch (e) { usersMsg = e.message; }
    usersBusy = false; draw();
  }

  async function userAction(body, okMsg) {
    try { await api.adminUsers(body); toast(okMsg); await loadUsers(); return true; } catch (e) { toast(e.message, 5000); return false; }
  }

  const pwHint = h("p", { class: "hint" }, "");
  const matchHint = () => {
    pwHint.textContent = !newAcc.password2 ? "" : newAcc.password === newAcc.password2 ? "✓ 서로 같아요" : "✕ 서로 달라요";
    pwHint.className = "hint " + (newAcc.password === newAcc.password2 ? "ok-text" : "err");
  };

  async function editProfile(u) {
    const name = h("input", { type: "text", class: "inp", placeholder: "이름", value: u.display_name ?? "", maxlength: "30" });
    const title = h("input", { type: "text", class: "inp", placeholder: "직책 (예: 홀 서버, 주방, 매니저)", value: u.job_title ?? "", maxlength: "30" });
    let role = u.role;
    const roleBox = h("div", { class: "stack" });
    const renderRole = () => roleBox.replaceChildren(
      h("label", { class: "lbl" }, "역할 (권한)"),
      seg([["staff", "직원"], ["supervisor", "중간관리자"], ["manager", "매니저"], ["deputy", "부대표"]], role, (v) => { role = v; renderRole(); }),
      h("p", { class: "hint" }, role === "deputy" ? "부대표: 모든 사업장의 출퇴근·클레임·보고를 보고 처리. 계정·비밀번호·매장 설정은 못 바꿈" : role === "supervisor" ? "중간관리자: 자기에게 배정된 직원의 출퇴근·클레임만 관리. 계정·설정은 못 바꿈" : role === "manager" ? "매니저: 일일보고 작성, 매장 직원 출퇴근 기록 조회·수정 가능" : "직원: 본인 출퇴근만 사용"));
    if (u.role !== "owner") renderRole();
    // 담당 관리자 배정 (직원이 누구에게 관리받는지, 관리자가 퇴근한 뒤엔 누가 맡는지)
    const leaders = users.filter((x) => ["supervisor", "manager", "deputy", "owner"].includes(x.role) && x.id !== u.id);
    const pick = (cur) => {
      const s = h("select", { class: "inp" }, h("option", { value: "" }, "지정 안 함"), ...leaders.map((x) => h("option", { value: x.id }, `${x.display_name || x.email} (${ROLE_KO[x.role]})`)));
      s.value = cur ?? "";
      return s;
    };
    const supSel = pick(u.supervisor_id), afterSel = pick(u.after_hours_id);
    const untilInp = h("input", { type: "time", class: "inp", value: u.managed_until || "" });
    const assignBox = h("div", { class: "stack" },
      h("label", { class: "lbl" }, "담당 관리자 (이 직원의 출퇴근·클레임을 관리)"), supSel,
      h("label", { class: "lbl" }, "담당 관리자가 퇴근한 뒤 맡을 사람"), afterSel,
      h("label", { class: "lbl" }, "이 사람이 관리자일 때: 관리 종료 시각 (예 17:00, 비우면 계속 관리)"), untilInp);
    // 정산 자료 올리기 권한: 통장·정산 엑셀을 올리는 수금 대조 탭을 쓸 수 있다 (경리·사무 담당)
    const settleChk = h("input", { type: "checkbox" }); settleChk.checked = !!u.can_settle;
    const settleBox = h("label", { class: "lbl", style: "display:flex;gap:8px;align-items:center" }, settleChk, "정산 자료 올리기 권한 (통장·정산 엑셀, 수금 대조)");
    const content = h("div", { class: "stack" }, h("p", { class: "muted" }, u.email), name, title, u.role !== "owner" && roleBox, u.role !== "owner" && u.role !== "deputy" && assignBox, u.role !== "owner" && u.role !== "deputy" && settleBox);
    for (;;) {
      if (!(await modal("이름·직책·역할 수정", content, "저장", "취소"))) return;
      if (!name.value.trim()) { toast("이름을 입력해 주세요"); continue; }
      const body = { action: "update_profile", user_id: u.id, display_name: name.value, job_title: title.value };
      if (u.role !== "owner" && role !== u.role) body.role = role;
      if (u.role !== "owner" && u.role !== "deputy") { body.can_settle = settleChk.checked; body.supervisor_id = supSel.value; body.after_hours_id = afterSel.value; body.managed_until = untilInp.value; }
      if (await userAction(body, role !== u.role ? "역할을 바꿨어요. 다시 로그인하면 적용돼요" : "저장했어요")) return;
    }
  }

  // 여러 명 한 번에: 한 줄에 "이름 직책(선택)". 이메일은 사업장키+번호로 자동, 비밀번호는 자동 생성
  async function bulkAdd() {
    const key = (opts.allAccounts ? opts.stores?.find((s) => s.id === pick.store)?.app_key : opts.store?.app_key) || "staff";
    const lines = bulk.text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast("이름을 한 줄에 한 명씩 적어 주세요"); return; }
    let n = users.reduce((m, u) => { const x = new RegExp("^" + key + "(\\d+)@woo-ahan\\.com$").exec(u.email ?? ""); return x ? Math.max(m, Number(x[1])) : m; }, 0);
    bulk.busy = true; bulk.result = []; draw();
    for (const line of lines) {
      const [name, ...rest] = line.split(/\s+/);
      const email = `${key}${String(++n).padStart(2, "0")}@woo-ahan.com`;
      const password = genPw();
      try {
        await api.adminUsers({ action: "create", email, password, role: bulk.role, display_name: name, job_title: rest.join(" "), ...(opts.allAccounts && pick.store ? { store_id: pick.store } : {}) });
        bulk.result.push({ name, email, password, ok: true });
      } catch (e) { bulk.result.push({ name, email, ok: false, err: e.message }); }
    }
    bulk.busy = false; bulk.text = "";
    await loadUsers();
  }

  // 소속별로 묶기: 대표·부대표는 "전체", 나머지는 사업장별. (사업장 하나만 보는 화면에서는 한 덩어리)
  function groupedUsers() {
    if (!opts.allAccounts) return [["계정", users]];
    const groups = [["전체 (마스터·부대표)", users.filter((u) => u.role === "owner" || u.role === "deputy")]];
    for (const s of opts.stores ?? []) groups.push([s.display_name || s.name, users.filter((u) => u.role !== "owner" && u.role !== "deputy" && u.store_id === s.id)]);
    const rest = users.filter((u) => u.role !== "owner" && u.role !== "deputy" && !(opts.stores ?? []).some((s) => s.id === u.store_id));
    if (rest.length) groups.push(["소속 없음", rest]);
    return groups;
  }

  function accountsView() {
    matchHint();
    return h("div", { class: "page" },
      h("button", { class: "linkbtn back", onclick: () => { if (opts.allAccounts) opts.onBack?.(); else { showAccounts = false; draw(); } } }, "← 목록"),
      h("h1", null, opts.allAccounts ? "전체 계정 관리" : "계정 관리"),
      h("p", { class: "muted" }, "비밀번호는 저장되지 않아요(자동 생성한 임시 비밀번호는 만든 직후 한 번만 보여요). 잊으면 새로 정해 주세요."),
      usersBusy && h("p", { class: "muted" }, "불러오는 중…"),
      usersMsg && h("p", { class: "err" }, usersMsg),
      ...groupedUsers().map(([label, list]) => [h("h2", { style: "margin-top:14px" }, `${label} (${list.length}명)`), h("div", { class: "list" }, list.map((u) => h("div", { class: "acc" },
        h("div", null, h("b", null, u.display_name || "(이름 없음)"), u.job_title && h("span", { class: "muted" }, " · " + u.job_title), " ", h("span", { class: "badge ok" }, ROLE_KO[u.role] ?? "역할 없음")),
        h("div", { class: "muted" }, u.email),
        u.last_sign_in_at && h("div", { class: "muted" }, "마지막 로그인 " + new Date(u.last_sign_in_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })),
        h("div", { class: "acc-btns" },
          h("button", { class: "btn ghost slim", onclick: () => editProfile(u) }, "이름·직책·역할 수정"),
          h("button", { class: "btn ghost slim", onclick: async () => {
            const pw = await promptPassword((u.display_name || u.email) + " 새 비밀번호");
            if (pw) await userAction({ action: "reset_password", user_id: u.id, password: pw }, "비밀번호를 바꿨어요");
          } }, "비밀번호 변경"),
          u.role !== "owner" && h("button", { class: "btn ghost slim danger", onclick: async () => {
            const go = await confirmDialog("계정을 삭제할까요?", [`${u.display_name || ""} ${u.email}`.trim(), "삭제하면 로그인할 수 없어요 (제출한 보고는 남아요)"], "취소", "삭제");
            if (go) await userAction({ action: "remove", user_id: u.id }, "삭제했어요");
          } }, "삭제")))))]).flat(),
      h("section", { class: "card" }, h("h2", null, "여러 명 한 번에 추가"),
        h("p", { class: "muted" }, "한 줄에 한 명씩 \"이름 직책\"(직책은 생략 가능). 이메일과 임시 비밀번호는 자동으로 만들어요."),
        storePicker(),
        h("textarea", { class: "inp", rows: "4", placeholder: "김철수 주방\n이영희 포장", value: bulk.text, oninput: (e) => (bulk.text = e.target.value) }),
        seg([["staff", "직원"], ["supervisor", "중간관리자"], ["manager", "매니저"], ["deputy", "부대표"]], bulk.role, (v) => { bulk.role = v; draw(); }),
        h("button", { class: "btn primary", disabled: bulk.busy, onclick: bulkAdd }, bulk.busy ? "만드는 중…" : "계정 만들기"),
        bulk.result && bulk.result.length > 0 && !bulk.busy && h("div", { class: "stack" },
          h("p", { class: "ok-text" }, "아래 정보를 직원에게 전달하세요. 비밀번호는 이 화면을 벗어나면 다시 볼 수 없어요."),
          h("pre", { class: "kakao" }, bulk.result.map((r) => r.ok ? `${r.name}\n  이메일: ${r.email}\n  비밀번호: ${r.password}` : `${r.name}: 실패 — ${r.err}`).join("\n\n")),
          h("button", { class: "btn ghost", onclick: async () => toast((await copyText(bulk.result.filter((r) => r.ok).map((r) => `${r.name} / ${r.email} / ${r.password}`).join("\n"))) ? "복사했어요" : "복사 실패") }, "전체 복사"))),
      h("section", { class: "card" }, h("h2", null, "계정 한 명 추가"),
        storePicker(),
        h("input", { type: "text", class: "inp", placeholder: "이름", value: newAcc.name, oninput: (e) => (newAcc.name = e.target.value) }),
        h("input", { type: "text", class: "inp", placeholder: "직책 (예: 홀 서버, 주방, 매니저)", value: newAcc.title, maxlength: "30", oninput: (e) => (newAcc.title = e.target.value) }),
        h("input", { type: "email", class: "inp", placeholder: "이메일 (로그인 ID)", value: newAcc.email, autocomplete: "off", inputmode: "email", oninput: (e) => (newAcc.email = e.target.value) }),
        passwordField("비밀번호 (8자 이상)", { value: newAcc.password, autocomplete: "new-password", oninput: (v) => { newAcc.password = v; matchHint(); } }),
        passwordField("비밀번호 한 번 더", { value: newAcc.password2, autocomplete: "new-password", oninput: (v) => { newAcc.password2 = v; matchHint(); } }),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => { newAcc.password = newAcc.password2 = genPw(); newAcc.shown = newAcc.password; draw(); } }, "🎲 임시 비밀번호 자동 생성"),
        newAcc.shown && newAcc.shown === newAcc.password && h("p", { class: "ok-text" }, "임시 비밀번호: " + newAcc.shown + "  (추가 후에는 다시 볼 수 없어요)"),
        pwHint,
        seg([["manager", "매니저"], ["supervisor", "중간관리자"], ["staff", "직원"], ["deputy", "부대표"]], newAcc.role, (v) => { newAcc.role = v; draw(); }),
        h("button", { class: "btn primary", onclick: async () => {
          if (newAcc.password.length < 8) { toast("비밀번호는 8자 이상이어야 해요"); return; }
          if (newAcc.password !== newAcc.password2) { toast("두 비밀번호가 서로 달라요. 다시 확인해 주세요", 4000); return; }
          const ok = await userAction({ action: "create", email: newAcc.email, password: newAcc.password, role: newAcc.role, display_name: newAcc.name, job_title: newAcc.title, ...(opts.allAccounts && pick.store ? { store_id: pick.store } : {}) }, "계정을 만들었어요");
          if (ok) { newAcc.name = newAcc.title = newAcc.email = newAcc.password = newAcc.password2 = ""; draw(); }
        } }, "추가")));
  }

  async function loadCl() {
    try { clOpen = (await api.clList("open")).claims; } catch { clOpen = null; }
    if (!showAccounts && !showAtt && !showCl && !showChk && !detail) draw();
  }

  async function load() {
    try { rows = hasReport ? await api.listReports(addDays(today, -190)) : []; err = null; } catch (e) { err = e.message; }
    loading = false; draw();
  }

  const byDate = () => Object.fromEntries(rows.map((r) => [r.report_date, r]));
  const badge = (t, cls) => h("span", { class: "badge " + cls }, t);

  function main() {
    return h("div", { class: "page" },
      h("div", { class: "toprow" }, pushBar(),
        hasReport && h("button", { class: "btn ghost slim", onclick: () => { showCl = true; draw(); } }, "📣 클레임"),
        opts.store?.kind === "hq" && h("button", { class: "btn ghost slim", onclick: () => { showTk = true; draw(); } }, "📌 업무지시"),
        opts.store?.kind === "ck" && h("button", { class: "btn ghost slim", onclick: () => { showChk = true; draw(); } }, "📋 점검"),
        h("button", { class: "btn ghost slim", onclick: () => { showAtt = true; draw(); } }, "🕘 출퇴근"),
        opts.store?.app_key === "fnb" && h("button", { class: "btn ghost slim", onclick: () => { showSales = true; draw(); } }, "📊 매출"),
        opts.store?.app_key === "fnb" && h("button", { class: "btn ghost slim", onclick: () => { showSettle = true; draw(); } }, "💰 수금"),
        isMaster && h("button", { class: "btn ghost slim", onclick: () => { showAccounts = true; loadUsers(); } }, "👤 계정")),
      clOpen && clOpen.length > 0 && h("button", { class: "item", style: "margin:4px 0 8px", onclick: () => { showCl = true; draw(); } },
        h("b", null, `처리 안 된 클레임 ${clOpen.length}건`),
        h("span", { class: "badges" }, clOpen.some((c) => c.severity === "severe") ? badge("중대 포함", "bad") : badge("확인 필요", "warn"))),
      isDemo && h("div", { class: "banner" }, "데모 모드 · 샘플 데이터로 화면을 확인할 수 있어요",
        h("button", { class: "linkbtn", onclick: async () => { await api.seedSample(); await load(); toast("샘플 데이터를 채웠어요"); } }, "샘플 채우기"),
        h("button", { class: "linkbtn", onclick: async () => { await api.resetDemo(); await load(); } }, "비우기")),
      hasReport && h("div", { class: "tabs" }, [["list", "최근 30일"], ["claims", "이번 달 클레임만 보기"], ["stats", "월별 집계"]].map(([k, l]) =>
        h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      hasReport && (loading ? h("p", { class: "muted" }, "불러오는 중…") : err ? h("p", { class: "err" }, "불러오기 실패: " + err) :
        tab === "list" ? listView() : tab === "claims" ? claimsView() : statsView()));
  }

  function pushBar() {
    const on = api.pushEnabled();
    return h("button", { class: "btn " + (on ? "ghost" : "primary") + " slim", onclick: async () => {
      try { await api.enablePush(); toast("알림을 켰어요"); draw(); } catch (e) { toast(e.message, 5000); }
    } }, on ? "🔔 알림 켜짐" : "🔔 알림 켜기");
  }

  function listView() {
    const map = byDate();
    const list = [];
    for (let i = 0; i < 30; i++) {
      const date = addDays(today, -i);
      const r = map[date];
      list.push(h("button", { class: "item", onclick: () => { detail = { date, r }; draw(); } },
        h("b", null, labelMD(date) + (i === 0 ? " 오늘" : "")),
        h("span", { class: "badges" },
          r ? badge("제출", "ok") : badge("미제출", "bad"),
          r?.has_claim && badge("클레임 있음", "warn"),
          r?.incomplete && badge("미완료 항목 있음", "warn2"),
          r?.data?.request?.trim() && badge("요청사항", "info"))));
    }
    return h("div", { class: "list" }, list);
  }

  function claimsView() {
    const mk = monthKey(today);
    const cl = rows.filter((r) => r.has_claim && monthKey(r.report_date) === mk);
    return h("div", { class: "list" },
      h("p", { class: "muted" }, `${monthLabel(mk)} 클레임 ${cl.length}건`),
      cl.map((r) => h("button", { class: "item col", onclick: () => { detail = { date: r.report_date, r }; draw(); } },
        h("b", null, labelMD(r.report_date)),
        claimItems(normalize(r.data, r.report_date)).map((x) => h("span", null, x.content, h("span", { class: "muted" }, "  → 처리: " + x.result))))),
      !cl.length && h("p", { class: "muted" }, "이번 달 클레임이 없어요"));
  }

  function statsView() {
    const rowsByM = {};
    for (let i = 0; i < 6; i++) {
      const [y, m] = today.slice(0, 7).split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1 - i, 1));
      rowsByM[dt.toISOString().slice(0, 7)] = { late: 0, absent: 0, subs: 0 };
    }
    for (const r of rows) {
      const m = rowsByM[monthKey(r.report_date)];
      if (m) { m.late += r.late_count; m.absent += r.absent_count; m.subs += 1; }
    }
    return h("table", { class: "stats" },
      h("thead", null, h("tr", null, ["월", "지각", "결원", "보고 제출"].map((t) => h("th", null, t)))),
      h("tbody", null, Object.entries(rowsByM).map(([k, v]) =>
        h("tr", null, h("td", null, monthLabel(k)), h("td", null, v.late + "회"), h("td", null, v.absent + "회"), h("td", null, v.subs + "일")))));
  }

  function detailView() {
    const { date, r } = detail;
    const body = !r ? h("p", { class: "bad-text" }, "이 날은 보고가 제출되지 않았어요.") : (() => {
      const d = normalize(r.data, date), c = checkText(d), s = summarize(d);
      return h("div", null,
        h("div", { class: "badges" }, badge("제출", "ok"), s.has_claim && badge("클레임 있음", "warn"), s.incomplete && badge("미완료: " + s.reasons.join(", "), "warn2")),
        h("section", { class: "card" }, h("h2", null, "1. 근태"), h("p", { class: "plain-pre" }, attText(d))),
        h("section", { class: "card" }, h("h2", null, "2. 클레임·특이사항"), h("p", { class: "plain-pre" }, claimText(d))),
        h("section", { class: "card" }, h("h2", null, "3. 점검"), h("ul", { class: "plain" }, [c.review, c.open, c.yardTrash, c.closing].map((t) => h("li", null, t)))),
        d.request.trim() && h("section", { class: "card" }, h("h2", null, "4. 요청사항"), h("p", { class: "plain-pre" }, d.request.trim())),
        h("p", { class: "muted" }, "제출 시각 " + new Date(r.submitted_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })),
        h("button", { class: "btn ghost", onclick: async () => toast((await copyText(kakaoText(date, d))) ? "복사했어요" : "복사 실패") }, "카톡 양식 복사"));
    })();
    return h("div", { class: "page" }, h("button", { class: "linkbtn back", onclick: () => { detail = null; draw(); } }, "← 목록"), h("h1", null, labelMD(date)), body);
  }

  if (opts.allAccounts) { draw(); await loadUsers(); return; } // 전체 계정 화면: 보고·클레임 불러오기 없이 계정만
  draw();
  if (hasReport) loadCl();
  // 푸시 알림에서 열린 경우 ?d=날짜 상세로
  await load();
  const q = new URLSearchParams(location.search).get("d");
  if (q) { detail = { date: q, r: byDate()[q] }; draw(); }
}
