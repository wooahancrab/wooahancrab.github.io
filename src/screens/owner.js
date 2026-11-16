import { api, isDemo } from "../lib/api.js";
import { h, toast, copyText, seg, confirmDialog, promptPassword, passwordField, modal } from "../lib/ui.js";
import { todayKST, addDays, labelMD, monthKey, monthLabel } from "../lib/kst.js";
import { t, tx, lang, locale } from "../lib/i18n.js";
import { renderAttendanceAdmin } from "./attendance-admin.js";
import { renderClaims } from "./claims.js";
import { renderChecklistAdmin } from "./checklist-admin.js";
import { renderTasksAdmin } from "./tasks-admin.js";
import { renderSettle } from "./settle.js";
import { renderSales } from "./sales.js";
import { canViewFinance } from "../lib/recon18.js";
import { renderShip } from "./ship.js";
import { renderWork } from "./work.js";
import { claimItems, kakaoText, summarize, normalize, TRASH } from "../lib/report.js";

// 서버·기기가 준 한국어 오류 문구를 화면 언어로(한국어일 때는 그대로). 값이 붙는 문구는 틀을 찾아 값을 채운다.
const ROLE_NAME = { owner: "대표", deputy: "부대표", manager: "매니저", supervisor: "중간관리자", staff: "직원" };
const ERR_PATTERNS = [
  [/^계정 확인에 실패했어요: ([\s\S]*)$/, "계정 확인에 실패했어요: {msg}", ["msg"]],
  [/^대표만 사용할 수 있어요 \(현재 역할: ([\s\S]*)\)$/, "대표만 사용할 수 있어요 (현재 역할: {role})", ["role"]],
];
export function errText(msg) {
  if (lang() === "ko" || typeof msg !== "string") return msg;
  const direct = t(msg);
  if (direct !== msg) return direct; // 사전에 같은 문장이 있으면 그대로 번역
  for (const [re, key, names] of ERR_PATTERNS) {
    const m = re.exec(msg);
    if (m) return t(key, Object.fromEntries(names.map((k, i) => [k, k === "role" && ROLE_NAME[m[i + 1]] ? t(ROLE_NAME[m[i + 1]]) : m[i + 1]])));
  }
  if (!/[가-힣]/.test(msg)) {
    if (/already (been )?registered/i.test(msg)) return t("이미 가입된 이메일이에요"); // 계정 만들기: 이미 있는 이메일(서버가 영어로 돌려줌)
    // DB·네트워크가 던지는 영어 원문은 번역할 수 없어서 알아볼 수 있는 문장으로(toast 와 같은 기준 — 화면에 글로 보이는 오류에도 쓴다)
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return t("서버에 연결하지 못했어요");
    if (/jwt|row-level security|violates|does not exist|permission denied|schema cache/i.test(msg)) return t("처리하지 못했어요");
  }
  return t(msg);
}

// 역할 이름 버튼 글자: 한국어가 아닌 화면에서는 좁은 버튼 안에서 단어가 글자 중간에 끊기지 않게 한다(한국어 화면은 글자 그대로)
const roleOpt = (k) => (lang() === "ko" ? t(k) : h("span", { style: "overflow-wrap:normal;font-size:.88em" }, t(k)));

// 일일보고 상세에 보이는 글: report.js 의 attText·claimText·checkText 와 한국어 결과가 같고, 다른 언어에서는 화면 언어로 푼다.
// (카톡으로 내보내는 글은 report.js 가 그대로 한국어로 만든다)
const filled = (list, key) => list.filter((x) => x[key].trim());
// 직접 쓴 조회 주제는 번역하지 않는다: '보고 항목::이름' 이 사전에 있는 기본 주제만 화면 언어로(한국어에서는 그대로)
const topicText = (x) => { const k = "보고 항목::" + x; const v = t(k); return v === k ? x : v; };
function attLine(d) {
  const a = d.att;
  const parts = [];
  if (a.absent === "has") {
    const l = filled(a.absents, "name").map((x) => `${x.name.trim()}${x.note.trim() ? `(${x.note.trim()})` : ""}`).join(", ");
    parts.push(l ? t("결원 {list}", { list: l }) : t("결원 있음"));
  } else parts.push(a.absent === "none" ? t("결원 없음") : t("결원 미입력"));
  if (a.late === "has") {
    const l = filled(a.lates, "name").map((x) => (x.time ? t("{name} 출근 {time}", { name: x.name.trim(), time: x.time }) : x.name.trim())).join(", ");
    parts.push(l ? t("지각 {list}", { list: l }) : t("지각 있음"));
  } else parts.push(a.late === "none" ? t("지각 없음") : t("지각 미입력"));
  return parts.join(" / ");
}
function claimLine(d) {
  const c = d.claim;
  if (c.state === "none") return tx("보고 상세", "없음");
  if (c.state !== "has") return tx("보고 상세", "미입력");
  const items = claimItems(d);
  if (!items.length) return t("(내용 없음)");
  return items.map((x) => t("{content} → 처리: {result}", { content: x.content.trim() || t("(내용 없음)"), result: x.result.trim() || t("(미입력)") })).join("\n");
}
function checkLines(d) {
  const k = d.chk;
  const topic = k.topic.trim();
  const review = k.reviewDone ? (topic ? t("조회 완료({topic})", { topic: topicText(topic) }) : t("조회 완료")) : t("조회 미완료");
  const open = k.openDone ? t("오픈 체크 완료") : t("오픈 체크 미완료");
  const missing = k.openMissing.length ? " " + t("(빠진 항목: {items})", { items: k.openMissing.map((x) => tx("보고 항목", x)).join(", ") }) : "";
  const yard = k.yard ? t("마당 청소 완료") : t("마당 청소 미완료");
  const trash = k.trash ? t("쓰레기장 물청소 {state}", { state: tx("보고 항목", String(TRASH[k.trash])) }) : t("쓰레기장 물청소 미입력");
  const closing = k.closing ? t("마감 점검 완료") : t("마감 점검 미완료");
  return { review, open: open + missing, yardTrash: `${yard}·${trash}`, closing };
}

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
  let showRecon = false; // 매출-입금 대조(대표·부대표·회장)
  let showSales = false;
  let showShip = false;
  let showWork = false;
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
    ? h("div", { class: "stack" }, h("label", { class: "lbl" }, t("소속 사업장 (부대표는 전체 소속이라 무시돼요)")),
        seg(opts.stores.map((s) => [s.id, s.display_name || s.name]), pick.store, (v) => { pick.store = v; draw(); }))
    : null;
  const ROLE_KO = { owner: "대표", deputy: "부대표", manager: "매니저", supervisor: "중간관리자", staff: "직원" };
  const roleName = (r) => t(ROLE_KO[r] ?? "역할 없음");
  const isMaster = ctx.role === "owner"; // 부대표는 계정·설정을 바꿀 수 없다
  const canFinance = canViewFinance(ctx.role); // 매출-입금 대조: 대표·부대표·회장 (서버 can_view_finance 와 같다)
  // 공지 자리: 사업장 화면 목록 맨 위에만 붙는다(하위·계정·상세 화면에는 안 그림). 처음 한 번만 만들어 다시 그려도 같은 자리를 쓴다.
  // 총괄 앱(ceo.js)이 사업장 칩으로 끼워 넣은(embedded) 화면과 전체 계정 화면은 건너뛴다(총괄 홈에 이미 있어 같은 공지가 두 번 나오지 않게)
  let noticeHost = null;
  if (!opts.embedded && !opts.allAccounts) {
    noticeHost = h("div");
    import("./notices.js").then((m) => m.mountNotices(noticeHost, ctx, { inline: true })).catch((e) => console.warn("[공지] 화면을 불러오지 못했어요:", e?.message));
  }

  // 하위 화면(출퇴근·매출·클레임 등)을 보는 중인가: 늦게 끝난 불러오기가 그 화면을 다시 그려 지우지 않게 한다
  const inSub = () => showTk || showChk || showCl || showSales || showWork || showShip || showSettle || showRecon || showAtt;
  // 지금 그리는 화면 이름(draw 의 분기 순서와 같다). 같은 화면을 다시 그릴 때는 보던 자리를 그대로 두고,
  // 다른 화면으로 가면 맨 위에서, 목록(main)으로 돌아오면 떠나기 전 자리에서 시작한다
  const viewName = () => showTk ? "tk" : showChk ? "chk" : showCl ? "cl" : showSales ? "sales" : showWork ? "work" : showShip ? "ship" : showSettle ? "settle" : showRecon && canFinance ? "recon" : showAtt ? "att" : showAccounts ? "accounts" : detail ? "detail" : "main";
  let lastView = "main", mainY = 0;

  const draw = () => {
    const y = scrollY;
    const now = viewName(), prev = lastView;
    if (now !== prev && prev === "main") mainY = y;
    lastView = now;
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
        h("button", { class: "linkbtn back", onclick: () => { showCl = false; loadCl(); draw(); } }, t("← 목록")), h("h1", null, t("클레임 후속조치")));
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
    if (showWork) {
      const holder = h("div", { class: "page", style: "padding-bottom:0" }, h("button", { class: "linkbtn back", onclick: () => { showWork = false; draw(); } }, t("← 목록")));
      const body = h("div");
      root.replaceChildren(holder, body);
      renderWork(body);
      scrollTo(0, 0);
      return;
    }
    if (showShip) {
      const holder = h("div", { class: "page", style: "padding-bottom:0" }, h("button", { class: "linkbtn back", onclick: () => { showShip = false; draw(); } }, t("← 목록")));
      const body = h("div");
      root.replaceChildren(holder, body);
      renderShip(body);
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
    if (showRecon && canFinance) {
      const holder = h("div");
      root.replaceChildren(holder);
      import("./recon18.js").then((m) => m.renderRecon18(holder, () => { showRecon = false; draw(); }, { profile: ctx }))
        .catch((e) => holder.replaceChildren(h("div", { class: "page" }, h("button", { class: "linkbtn back", onclick: () => { showRecon = false; draw(); } }, t("← 목록")), h("p", { class: "err" }, t("화면을 불러오지 못했어요: {msg}", { msg: errText(e.message) })))));
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
    scrollTo(0, now === prev ? y : now === "main" ? mainY : 0);
  };

  async function loadUsers() {
    usersBusy = true; usersMsg = ""; draw();
    try { users = (await api.adminUsers({ action: "list" })).users; } catch (e) { usersMsg = e.message; }
    usersBusy = false; draw();
  }

  async function userAction(body, okMsg) {
    try { await api.adminUsers(body); toast(okMsg); await loadUsers(); return true; } catch (e) { toast(errText(e.message), 5000); return false; }
  }

  const pwHint = h("p", { class: "hint" }, "");
  const matchHint = () => {
    pwHint.textContent = !newAcc.password2 ? "" : newAcc.password === newAcc.password2 ? t("✓ 서로 같아요") : t("✕ 서로 달라요");
    pwHint.className = "hint " + (newAcc.password === newAcc.password2 ? "ok-text" : "err");
  };

  async function editProfile(u) {
    const name = h("input", { type: "text", class: "inp", placeholder: t("이름"), value: u.display_name ?? "", maxlength: "30" });
    const title = h("input", { type: "text", class: "inp", placeholder: t("직책 (예: 홀 서버, 주방, 매니저)"), value: u.job_title ?? "", maxlength: "30" });
    let role = u.role;
    const roleBox = h("div", { class: "stack" });
    const renderRole = () => roleBox.replaceChildren(
      h("label", { class: "lbl" }, t("역할 (권한)")),
      seg([["staff", roleOpt("직원")], ["supervisor", roleOpt("중간관리자")], ["manager", roleOpt("매니저")], ["deputy", roleOpt("부대표")]], role, (v) => { role = v; renderRole(); }),
      h("p", { class: "hint" }, role === "deputy" ? t("부대표: 모든 사업장의 출퇴근·클레임·보고를 보고 처리. 계정·비밀번호·매장 설정은 못 바꿈") : role === "supervisor" ? t("중간관리자: 자기에게 배정된 직원의 출퇴근·클레임만 관리. 계정·설정은 못 바꿈") : role === "manager" ? t("매니저: 일일보고 작성, 매장 직원 출퇴근 기록 조회·수정 가능") : t("직원: 본인 출퇴근만 사용")));
    if (u.role !== "owner") renderRole();
    // 담당 관리자 배정 (직원이 누구에게 관리받는지, 관리자가 퇴근한 뒤엔 누가 맡는지)
    const leaders = users.filter((x) => ["supervisor", "manager", "deputy", "owner"].includes(x.role) && x.id !== u.id);
    const pick = (cur) => {
      const s = h("select", { class: "inp" }, h("option", { value: "" }, t("지정 안 함")), ...leaders.map((x) => h("option", { value: x.id }, `${x.display_name || x.email} (${roleName(x.role)})`)));
      s.value = cur ?? "";
      return s;
    };
    const supSel = pick(u.supervisor_id), afterSel = pick(u.after_hours_id);
    const untilInp = h("input", { type: "time", class: "inp", value: u.managed_until || "" });
    const assignBox = h("div", { class: "stack" },
      h("label", { class: "lbl" }, t("담당 관리자 (이 직원의 출퇴근·클레임을 관리)")), supSel,
      h("label", { class: "lbl" }, t("담당 관리자가 퇴근한 뒤 맡을 사람")), afterSel,
      h("label", { class: "lbl" }, t("이 사람이 관리자일 때: 관리 종료 시각 (예 17:00, 비우면 계속 관리)")), untilInp);
    // 정산 자료 올리기 권한: 통장·정산 엑셀을 올리는 수금 대조 탭을 쓸 수 있다 (경리·사무 담당)
    const settleChk = h("input", { type: "checkbox" }); settleChk.checked = !!u.can_settle;
    const settleBox = h("label", { class: "lbl", style: "display:flex;gap:8px;align-items:center" }, settleChk, t("정산 자료 올리기 권한 (통장·정산 엑셀, 수금 대조)"));
    // 화면 언어 기본값: 베트남 직원은 베트남어로(직원 본인도 앱 위쪽 🌐 에서 바꿀 수 있다)
    let langPick = u.lang ?? null; // null = 아직 안 정함(그 사람 폰의 언어로 보임)
    const langBox = h("div", { class: "stack" });
    const renderLang = () => langBox.replaceChildren(
      h("label", { class: "lbl" }, t("화면 언어 (이 사람이 앱을 보는 언어)") + (langPick ? "" : " — " + t("아직 안 정함: 폰 언어대로 보여요"))),
      seg([["ko", "한국어"], ["vi", "Tiếng Việt"], ["en", "English"]], langPick, (v) => { langPick = v; renderLang(); }));
    renderLang();
    const content = h("div", { class: "stack" }, h("p", { class: "muted" }, u.email), name, title, langBox, u.role !== "owner" && roleBox, u.role !== "owner" && u.role !== "deputy" && assignBox, u.role !== "owner" && u.role !== "deputy" && settleBox);
    for (;;) {
      if (!(await modal(t("이름·직책·역할 수정"), content, t("저장"), t("취소")))) return;
      if (!name.value.trim()) { toast(t("이름을 입력해 주세요")); continue; }
      const body = { action: "update_profile", user_id: u.id, display_name: name.value, job_title: title.value };
      if (langPick && langPick !== u.lang) body.lang = langPick;
      if (u.role !== "owner" && role !== u.role) body.role = role;
      if (u.role !== "owner" && u.role !== "deputy") { body.can_settle = settleChk.checked; body.supervisor_id = supSel.value; body.after_hours_id = afterSel.value; body.managed_until = untilInp.value; }
      if (await userAction(body, role !== u.role ? t("역할을 바꿨어요. 다시 로그인하면 적용돼요") : t("저장했어요"))) return;
    }
  }

  // 여러 명 한 번에: 한 줄에 "이름 직책(선택)". 이메일은 사업장키+번호로 자동, 비밀번호는 자동 생성
  async function bulkAdd() {
    const key = (opts.allAccounts ? opts.stores?.find((s) => s.id === pick.store)?.app_key : opts.store?.app_key) || "staff";
    const lines = bulk.text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast(t("이름을 한 줄에 한 명씩 적어 주세요")); return; }
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
    if (!opts.allAccounts) return [[t("계정"), users]];
    const groups = [[t("전체 (마스터·부대표)"), users.filter((u) => u.role === "owner" || u.role === "deputy")]];
    for (const s of opts.stores ?? []) groups.push([s.display_name || s.name, users.filter((u) => u.role !== "owner" && u.role !== "deputy" && u.store_id === s.id)]);
    const rest = users.filter((u) => u.role !== "owner" && u.role !== "deputy" && !(opts.stores ?? []).some((s) => s.id === u.store_id));
    if (rest.length) groups.push([t("소속 없음"), rest]);
    return groups;
  }

  function accountsView() {
    matchHint();
    return h("div", { class: "page" },
      h("button", { class: "linkbtn back", onclick: () => { if (opts.allAccounts) opts.onBack?.(); else { showAccounts = false; draw(); } } }, t("← 목록")),
      h("h1", null, opts.allAccounts ? t("전체 계정 관리") : t("계정 관리")),
      h("p", { class: "muted" }, t("비밀번호는 저장되지 않아요(자동 생성한 임시 비밀번호는 만든 직후 한 번만 보여요). 잊으면 새로 정해 주세요.")),
      usersBusy && !users.length && h("p", { class: "muted" }, t("불러오는 중…")), // 목록이 이미 있으면(저장 뒤 다시 불러올 때) 줄을 끼워 넣지 않아 보던 자리가 밀리지 않는다
      usersMsg && h("p", { class: "err" }, errText(usersMsg)),
      ...groupedUsers().map(([label, list]) => [h("h2", { class: "cat-title" }, tx("계정 관리", "{label} ({n}명)", { label, n: list.length })), list.length > 0 && h("div", { class: "rowlist" }, list.map((u) => h("div", { class: "acc" },
        h("div", null, h("b", null, u.display_name || t("(이름 없음)")), u.job_title && h("span", { class: "muted" }, " · " + u.job_title), " ", h("span", { class: "badge" }, roleName(u.role))),
        h("div", { class: "muted" }, u.email),
        u.last_sign_in_at && h("div", { class: "muted" }, t("마지막 로그인 {when}", { when: new Date(u.last_sign_in_at).toLocaleString(locale(), { timeZone: "Asia/Seoul" }) })),
        h("div", { class: "acc-btns" },
          h("button", { class: "btn ghost slim", onclick: () => editProfile(u) }, t("이름·직책·역할 수정")),
          h("button", { class: "btn ghost slim", onclick: async () => {
            const pw = await promptPassword(t("{name} 새 비밀번호", { name: u.display_name || u.email }));
            if (pw) await userAction({ action: "reset_password", user_id: u.id, password: pw }, t("비밀번호를 바꿨어요"));
          } }, t("비밀번호 변경")),
          u.role !== "owner" && h("button", { class: "btn ghost slim danger", onclick: async () => {
            const go = await confirmDialog(t("계정을 삭제할까요?"), [`${u.display_name || ""} ${u.email}`.trim(), t("삭제하면 로그인할 수 없어요 (제출한 보고는 남아요)")], t("취소"), t("삭제"));
            if (go) await userAction({ action: "remove", user_id: u.id }, t("삭제했어요"));
          } }, t("삭제"))))))]).flat(),
      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("여러 명 한 번에 추가")),
        h("p", { class: "muted" }, t("한 줄에 한 명씩 \"이름 직책\"(직책은 생략 가능). 이메일과 임시 비밀번호는 자동으로 만들어요.")),
        storePicker(),
        h("textarea", { class: "inp", rows: "4", placeholder: t("김철수 주방\n이영희 포장"), value: bulk.text, oninput: (e) => (bulk.text = e.target.value) }),
        seg([["staff", roleOpt("직원")], ["supervisor", roleOpt("중간관리자")], ["manager", roleOpt("매니저")], ["deputy", roleOpt("부대표")]], bulk.role, (v) => { bulk.role = v; draw(); }),
        h("button", { class: "btn primary", disabled: bulk.busy, onclick: bulkAdd }, bulk.busy ? t("만드는 중…") : t("계정 만들기")),
        bulk.result && bulk.result.length > 0 && !bulk.busy && h("div", { class: "stack" },
          h("p", { class: "ok-text" }, t("아래 정보를 직원에게 전달하세요. 비밀번호는 이 화면을 벗어나면 다시 볼 수 없어요.")),
          h("pre", { class: "kakao" }, bulk.result.map((r) => r.ok ? `${r.name}\n  ${t("이메일")}: ${r.email}\n  ${t("비밀번호")}: ${r.password}` : `${r.name}: ${tx("계정 관리", "실패")} — ${errText(r.err)}`).join("\n\n")),
          h("button", { class: "btn ghost", onclick: async () => toast((await copyText(bulk.result.filter((r) => r.ok).map((r) => `${r.name} / ${r.email} / ${r.password}`).join("\n"))) ? t("복사했어요") : t("복사 실패")) }, t("전체 복사")))),
      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("계정 한 명 추가")),
        storePicker(),
        h("input", { type: "text", class: "inp", placeholder: t("이름"), value: newAcc.name, oninput: (e) => (newAcc.name = e.target.value) }),
        h("input", { type: "text", class: "inp", placeholder: t("직책 (예: 홀 서버, 주방, 매니저)"), value: newAcc.title, maxlength: "30", oninput: (e) => (newAcc.title = e.target.value) }),
        h("input", { type: "email", class: "inp", placeholder: t("이메일 (로그인 ID)"), value: newAcc.email, autocomplete: "off", inputmode: "email", oninput: (e) => (newAcc.email = e.target.value) }),
        passwordField(t("비밀번호 (8자 이상)"), { value: newAcc.password, autocomplete: "new-password", oninput: (v) => { newAcc.password = v; matchHint(); } }),
        passwordField(t("비밀번호 한 번 더"), { value: newAcc.password2, autocomplete: "new-password", oninput: (v) => { newAcc.password2 = v; matchHint(); } }),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => { newAcc.password = newAcc.password2 = genPw(); newAcc.shown = newAcc.password; draw(); } }, t("🎲 임시 비밀번호 자동 생성")),
        newAcc.shown && newAcc.shown === newAcc.password && h("p", { class: "ok-text" }, t("임시 비밀번호: {pw}  (추가 후에는 다시 볼 수 없어요)", { pw: newAcc.shown })),
        pwHint,
        seg([["manager", roleOpt("매니저")], ["supervisor", roleOpt("중간관리자")], ["staff", roleOpt("직원")], ["deputy", roleOpt("부대표")]], newAcc.role, (v) => { newAcc.role = v; draw(); }),
        h("button", { class: "btn primary", onclick: async () => {
          if (newAcc.password.length < 8) { toast(t("비밀번호는 8자 이상이어야 해요")); return; }
          if (newAcc.password !== newAcc.password2) { toast(t("두 비밀번호가 서로 달라요. 다시 확인해 주세요"), 4000); return; }
          const ok = await userAction({ action: "create", email: newAcc.email, password: newAcc.password, role: newAcc.role, display_name: newAcc.name, job_title: newAcc.title, ...(opts.allAccounts && pick.store ? { store_id: pick.store } : {}) }, t("계정을 만들었어요"));
          if (ok) { newAcc.name = newAcc.title = newAcc.email = newAcc.password = newAcc.password2 = ""; draw(); }
        } }, t("추가"))));
  }

  async function loadCl() {
    try { clOpen = (await api.clList("open")).claims; } catch { clOpen = null; }
    if (!showAccounts && !detail && !inSub()) draw();
  }

  async function load() {
    try { rows = hasReport ? await api.listReports(addDays(today, -190)) : []; err = null; } catch (e) { err = e.message; }
    loading = false; if (!inSub()) draw(); // 하위 화면(매출-입금 대조 등)을 보는 중이면 다시 그려서 입력·위치를 지우지 않는다(돌아오면 그때 그린다)
  }

  const byDate = () => Object.fromEntries(rows.map((r) => [r.report_date, r]));
  // wrap=true: 목록이 길어질 수 있는 배지(한국어 아닌 화면에서만 줄바꿈을 허용해 화면 밖으로 잘리지 않게 한다)
  const badge = (label, cls, wrap) => h("span", { class: "badge " + cls, style: wrap && lang() !== "ko" ? "white-space:normal" : null }, label);

  function main() {
    return h("div", { class: "page" },
      noticeHost,
      h("div", { class: "toprow" }, pushBar(),
        hasReport && h("button", { class: "btn ghost slim", onclick: () => { showCl = true; draw(); } }, "📣 " + t("클레임")),
        opts.store?.kind === "hq" && h("button", { class: "btn ghost slim", onclick: () => { showTk = true; draw(); } }, t("📌 업무지시")),
        opts.store?.kind === "ck" && h("button", { class: "btn ghost slim", onclick: () => { showChk = true; draw(); } }, "📋 " + t("점검")),
        h("button", { class: "btn ghost slim", onclick: () => { showAtt = true; draw(); } }, "🕘 " + t("출퇴근")),
        ["fnb", "gejang"].includes(opts.store?.app_key) && h("button", { class: "btn ghost slim", onclick: () => { showSales = true; draw(); } }, t("📊 매출·지출")),
        ["fnb", "gejang"].includes(opts.store?.app_key) && h("button", { class: "btn ghost slim", onclick: () => { showSettle = true; draw(); } }, t("💰 통장·수금")),
        canFinance && ["fnb", "gejang"].includes(opts.store?.app_key) && h("button", { class: "btn ghost slim", onclick: () => { showRecon = true; draw(); } }, t("🧮 매출-입금 대조")),
        opts.store?.app_key === "fnb" && h("button", { class: "btn ghost slim", onclick: () => { showShip = true; draw(); } }, "📦 " + t("송장")),
        opts.store?.kind === "hq" && h("button", { class: "btn ghost slim", onclick: () => { showWork = true; draw(); } }, t("🗂 업무 기록")),
        isMaster && h("button", { class: "btn ghost slim", onclick: () => { showAccounts = true; loadUsers(); } }, "👤 " + t("계정"))),
      clOpen && clOpen.length > 0 && h("button", { class: "item", style: "margin:4px 0 8px", onclick: () => { showCl = true; draw(); } },
        h("b", { style: lang() === "ko" ? "margin-right:auto" : "margin-right:auto;overflow-wrap:normal" }, t("처리 안 된 클레임 {n}건", { n: clOpen.length })), // 한국어가 아니면 단어가 글자 중간에서 끊기지 않게(한국어 화면은 그대로)
        h("span", { class: "badges" }, clOpen.some((c) => c.severity === "severe") ? badge(t("중대 포함"), "bad") : badge(t("확인 필요"), "warn")),
        h("span", { class: "chev", "aria-hidden": "true" })),
      isDemo && h("div", { class: "banner" }, t("데모 모드 · 샘플 데이터로 화면을 확인할 수 있어요"),
        h("button", { class: "linkbtn", onclick: async () => { await api.seedSample(); await load(); toast(t("샘플 데이터를 채웠어요")); } }, t("샘플 채우기")),
        h("button", { class: "linkbtn", onclick: async () => { await api.resetDemo(); await load(); } }, t("비우기"))),
      hasReport && h("div", { class: "tabs" }, [["list", t("최근 30일")], ["claims", t("이번 달 클레임만 보기")], ["stats", t("월별 집계")]].map(([k, l]) =>
        h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      hasReport && (loading ? h("p", { class: "muted" }, t("불러오는 중…")) : err ? h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: errText(err) })) :
        tab === "list" ? listView() : tab === "claims" ? claimsView() : statsView()));
  }

  function pushBar() {
    const on = api.pushEnabled();
    return h("button", { class: "btn " + (on ? "ghost" : "weak") + " slim", onclick: async () => {
      try { await api.enablePush(); toast(t("알림을 켰어요")); draw(); } catch (e) { toast(errText(e.message), 5000); }
    } }, on ? "🔔 " + t("알림 켜짐") : "🔔 " + t("알림 켜기"));
  }

  function listView() {
    const map = byDate();
    const list = [];
    for (let i = 0; i < 30; i++) {
      const date = addDays(today, -i);
      const r = map[date];
      list.push(h("button", { class: "item", onclick: () => { detail = { date, r }; draw(); } },
        h("b", { style: lang() === "ko" ? "margin-right:auto" : "margin-right:auto;overflow-wrap:normal" }, labelMD(date) + (i === 0 ? " " + t("오늘") : "")), // 날짜가 글자 중간에서 끊기지 않게(띄어쓰기에서만 줄바꿈), 오른쪽 배지와 겹치지 않게(한국어 화면은 그대로)
        h("span", { class: "badges" },
          r ? badge(t("제출"), "ok") : badge(t("미제출"), "bad"),
          r?.has_claim && badge(t("클레임 있음"), "warn"),
          r?.incomplete && badge(t("미완료 항목 있음"), "warn2"),
          r?.data?.request?.trim() && badge(t("요청사항"), "info")),
        h("span", { class: "chev", "aria-hidden": "true" })));
    }
    return h("div", { class: "rowlist" }, list);
  }

  function claimsView() {
    const mk = monthKey(today);
    const cl = rows.filter((r) => r.has_claim && monthKey(r.report_date) === mk);
    return h("div", { class: "list" },
      h("p", { class: "muted" }, t("{month} 클레임 {n}건", { month: monthLabel(mk), n: cl.length })),
      cl.map((r) => h("button", { class: "item col", onclick: () => { detail = { date: r.report_date, r }; draw(); } },
        h("b", null, labelMD(r.report_date)),
        claimItems(normalize(r.data, r.report_date)).map((x) => h("span", null, x.content, h("span", { class: "muted" }, "  " + t("→ 처리: {result}", { result: x.result })))))),
      !cl.length && h("p", { class: "muted" }, t("이번 달 클레임이 없어요")));
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
    const cs = lang() === "ko" ? null : "overflow-wrap:normal"; // 칸이 좁을 때 단어가 글자 중간에서 끊기지 않게(한국어 화면은 그대로)
    return h("table", { class: "stats" },
      h("thead", null, h("tr", null, [tx("월별 집계", "월"), tx("월별 집계", "지각"), tx("월별 집계", "결원"), tx("월별 집계", "보고 제출")].map((x) => h("th", { style: cs }, x)))),
      h("tbody", null, Object.entries(rowsByM).map(([k, v]) =>
        h("tr", null, h("td", { style: cs }, monthLabel(k)), h("td", { style: cs }, tx("월별 집계", "{n}회", { n: v.late })), h("td", { style: cs }, tx("월별 집계", "{n}회", { n: v.absent })), h("td", { style: cs }, tx("월별 집계", "{n}일", { n: v.subs }))))));
  }

  function detailView() {
    const { date, r } = detail;
    const body = !r ? h("p", { class: "bad-text" }, t("이 날은 보고가 제출되지 않았어요.")) : (() => {
      const d = normalize(r.data, date), c = checkLines(d), s = summarize(d);
      return h("div", null,
        h("div", { class: "badges" }, badge(t("제출"), "ok"), s.has_claim && badge(t("클레임 있음"), "warn"), s.incomplete && badge(t("미완료: {list}", { list: s.reasons.map((x) => tx("보고 항목", x)).join(", ") }), "warn2", true)),
        h("section", { class: "sec" }, h("h2", { class: "sec-title" }, t("1. 근태")), h("p", { class: "plain-pre" }, attLine(d))),
        h("section", { class: "sec" }, h("h2", { class: "sec-title" }, t("2. 클레임·특이사항")), h("p", { class: "plain-pre" }, claimLine(d))),
        h("section", { class: "sec" }, h("h2", { class: "sec-title" }, t("3. 점검")), h("ul", { class: "plain" }, [c.review, c.open, c.yardTrash, c.closing].map((x) => h("li", null, x)))),
        d.request.trim() && h("section", { class: "sec" }, h("h2", { class: "sec-title" }, t("4. 요청사항")), h("p", { class: "plain-pre" }, d.request.trim())),
        h("p", { class: "muted" }, t("제출 시각 {when}", { when: new Date(r.submitted_at).toLocaleString(locale(), { timeZone: "Asia/Seoul" }) })),
        h("button", { class: "btn ghost", onclick: async () => toast((await copyText(kakaoText(date, d))) ? t("복사했어요") : t("복사 실패")) }, t("카톡 양식 복사")));
    })();
    return h("div", { class: "page" }, h("button", { class: "linkbtn back", onclick: () => { detail = null; draw(); } }, t("← 목록")), h("h1", null, labelMD(date)), body);
  }

  if (opts.allAccounts) { draw(); await loadUsers(); return; } // 전체 계정 화면: 보고·클레임 불러오기 없이 계정만
  draw();
  if (hasReport) loadCl();
  // 푸시 알림에서 열린 경우 ?d=날짜 상세로
  await load();
  const q = new URLSearchParams(location.search).get("d");
  if (q) { detail = { date: q, r: byDate()[q] }; if (!inSub()) draw(); } // 하위 화면(매출-입금 대조 등)을 보는 중이면 다시 그려서 입력을 지우지 않는다
}
