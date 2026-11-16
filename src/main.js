import { api, isDemo } from "./lib/api.js";
import { h, toast, passwordField, promptPassword } from "./lib/ui.js";
import { renderManager } from "./screens/manager-report.js";
import { renderOwner } from "./screens/owner.js";
import { renderAttendance } from "./screens/attendance.js";
import { renderClaims } from "./screens/claims.js";
import { renderCeo } from "./screens/ceo.js";
import { renderAttendanceAdmin } from "./screens/attendance-admin.js";
import { renderChecklist } from "./screens/checklist.js";
import { renderTasks } from "./screens/tasks.js";
import { renderFinance } from "./screens/finance.js";
import { renderShip } from "./screens/ship.js";
import { renderWork } from "./screens/work.js";
import { renderSuggest } from "./screens/suggest.js";
import { renderLibrary } from "./screens/library.js";
import { renderChecklistAdmin } from "./screens/checklist-admin.js";
import { lang, setLang, savedLang, t } from "./lib/i18n.js";
import { openLangSettings } from "./screens/lang-settings.js";

// 앱 종류: 우아한게장(기본)·CK·F&B·대표 총괄. 각 앱의 index.html 이 window.APP 로 알려 준다.
const APP = window.APP ?? { key: "gejang", name: "우아한게장" };

const app = document.getElementById("app");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 카톡 앱 안 브라우저에서는 푸시·홈 화면 추가가 안 되므로 기본 브라우저로 열도록 안내
// 화면 언어가 정해진 뒤(boot)에 그리고, 언어를 바꾸면 다시 그린다
let kakaoBanner = null;
function drawKakaoBanner() {
  kakaoBanner?.remove();
  kakaoBanner = null;
  if (!/KAKAOTALK/i.test(navigator.userAgent)) return;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  kakaoBanner = h("div", { class: "banner", style: "margin:0;border-radius:0;justify-content:center;text-align:center" },
    isIOS ? t("카톡 안에서는 설치가 안 돼요. Safari로 열어 주세요.") : t("카톡 안에서는 알림·설치가 안 돼요. 크롬으로 열어 주세요."),
    h("button", { class: "linkbtn", onclick: () => { location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href.split("#")[0]); } }, t("기본 브라우저로 열기")));
  document.body.prepend(kakaoBanner);
}

const ROLE_LABEL = { owner: "대표", deputy: "부대표", manager: "매니저", supervisor: "중간관리자", staff: "직원" };
// 역할 이름(화면 언어로). 모르는 역할이면 빈 글자
const roleLabel = (r) => (ROLE_LABEL[r] ? t(ROLE_LABEL[r]) : "");

async function logout() { await api.signOut(); langKeep = null; resumeTab = null; boot(); }

// 언어를 바꿔 화면을 다시 그릴 때 보던 탭으로 돌아오기 위한 기억
let curTab = null, resumeTab = null;

// 화면 언어 바꾸기: 서버(내 계정)에 저장하고 이 기기에도 기억한 뒤 화면을 다시 그린다. 서버가 아직 준비 전이어도 이 기기에서는 바뀐다
// 서버에 저장하지 못했으면 이번 접속 동안은 서버 값을 무시하고(boot 가 되돌리지 않게) 알려 준다
let langKeep = null;
async function changeLang() {
  const l = await openLangSettings();
  if (!l || l === lang()) return;
  let saved = true;
  try { await api.setMyLang(l); langKeep = null; } catch (e) { saved = false; langKeep = l; console.warn("언어를 서버에 저장하지 못했어요(이 기기에만 바뀜):", e?.message); }
  await setLang(l);
  resumeTab = curTab; // 보던 탭을 그대로 연다
  await boot();
  if (!saved) toast(t("이 기기에서만 바뀌었어요. 나중에 다시 해 주세요"), 5000);
}

function shell(profile, content) {
  const view = h("main", { id: "view" });
  app.replaceChildren(
    h("header", { class: "top" },
      h("img", { src: "/icons/logo-mark.png", class: "top-logo", alt: "" }),
      h("b", null, APP.key === "ceo" ? APP.name : profile.role === "owner" || profile.role === "deputy" ? APP.name : profile.store_display),
      // 오른쪽 위: 접속한 사람의 이름과 직책(직책을 안 적어 둔 계정은 역할 이름)
      h("span", { class: "who", title: `${profile.display_name ?? ""} ${profile.job_title || roleLabel(profile.role)}`.trim() },
        h("span", { class: "nm" }, profile.display_name || roleLabel(profile.role) || profile.role),
        h("span", { class: "jt" }, `${profile.job_title || roleLabel(profile.role) || profile.role}${isDemo ? " · " + t("데모") : ""}`)),
      h("button", { class: "linkbtn", "aria-label": "언어 · Ngôn ngữ · Language", onclick: changeLang }, "🌐 " + lang().toUpperCase()),
      h("button", { class: "linkbtn", onclick: () => import("./screens/push-check.js").then((m) => m.openPushCheck()).catch((e) => toast(t("알림 점검을 열지 못했어요: {msg}", { msg: t(e.message) }), 5000)) }, t("알림")),
      h("button", { class: "linkbtn", onclick: async () => {
        const pw = await promptPassword(t("내 새 비밀번호"));
        if (!pw) return;
        try { await api.changePassword(pw); toast(t("비밀번호를 바꿨어요")); } catch (e) { toast(t(e.message), 5000); }
      } }, t("비밀번호")),
      h("button", { class: "linkbtn", onclick: logout }, t("로그아웃"))),
    view);
  return view;
}

function loginScreen(msg) {
  const email = h("input", { type: "email", class: "inp", placeholder: t("이메일"), autocomplete: "username", inputmode: "email" });
  const pw = passwordField(t("비밀번호"));
  const errBox = h("p", { class: "err" }, msg ? t(msg) : "");
  const go = async () => {
    errBox.textContent = "";
    try { await api.signIn(email.value.trim(), pw.input.value); boot(); } catch (e) { errBox.textContent = t(e.message); }
  };
  app.replaceChildren(h("div", { class: "page login" },
    h("img", { src: "/icons/logo.png", class: "logo", alt: "우아한게장" }),
    h("p", { class: "muted", style: "margin:0 0 14px" }, APP.key === "ceo" ? t("대표 총괄") : t("{name} · 업무 앱", { name: APP.name })),
    isDemo
      ? h("div", null,
          h("div", { class: "banner" }, t("데모 모드 — 이 기기 안에만 저장돼요")),
          h("button", { class: "btn primary", onclick: async () => { await api.signIn("manager"); boot(); } }, t("매니저로 입장")),
          h("button", { class: "btn ghost", onclick: async () => { await api.signIn("staff"); boot(); } }, t("직원으로 입장")),
          h("button", { class: "btn ghost", onclick: async () => { await api.signIn("owner"); boot(); } }, t("대표로 입장")))
      : h("form", { onsubmit: (e) => { e.preventDefault(); go(); } }, email, pw, errBox,
          h("button", { class: "btn primary", type: "submit" }, t("로그인"))),
    h("button", { class: "linkbtn", type: "button", style: "margin-top:12px", onclick: async () => { const l = await openLangSettings(); if (l && l !== lang()) { await setLang(l); boot(); } } }, "🌐 언어 · Ngôn ngữ · Language")));
}

async function boot() {
  drawKakaoBanner();
  let profile;
  try { profile = await api.getProfile(); } catch (e) { loginScreen(e.message); return; }
  if (!profile) return loginScreen();
  // 서버에 저장된 내 언어가 우선(대표가 정한 기본값 또는 내가 바꾼 값). 비어 있으면(아직 안 정함) 이 기기의 언어를 그대로 쓴다
  const want = langKeep ?? profile.lang;
  if (want && want !== lang()) { await setLang(want); drawKakaoBanner(); }
  const view = shell(profile);
  if (profile.role === "manager") {
    const tabs = [["cl", t("클레임"), renderClaims], ["att", t("내 출퇴근"), renderAttendance]];
    if (profile.store_kind === "restaurant") tabs.unshift(["report", t("일일보고"), renderManager]); // 일일보고는 식당만
    tabbedHome(view, profile, tabs);
  } else if (profile.role === "supervisor") {
    // 중간관리자: 배정된 직원만 보고, 클레임과 내 출퇴근을 쓴다. 식당(게장)은 일일보고도 작성한다.
    const tabs = [
      ["team", t("담당 직원"), (pane) => renderAttendanceAdmin(pane, null, { master: false, title: t("담당 직원 출퇴근") })],
      ["cl", t("클레임"), renderClaims], ["att", t("내 출퇴근"), renderAttendance]];
    if (profile.store_kind === "restaurant") tabs.unshift(["report", t("일일보고"), renderManager]);
    tabbedHome(view, profile, tabs);
  } else if (profile.role === "owner" || profile.role === "deputy") { // 부대표는 같은 화면, 계정·설정만 막힘
    if (APP.key === "ceo") { await renderCeo(view, profile); return; }
    const store = (await api.listStores()).find((s) => s.app_key === APP.key);
    if (!store) { view.append(h("p", { class: "err", style: "padding:16px" }, t("이 앱에 연결된 사업장을 찾지 못했어요"))); return; }
    api.setStore(store);
    await renderOwner(view, profile, { store });
  }
  else tabbedHome(view, profile, [["cl", t("클레임"), renderClaims], ["att", t("출퇴근"), renderAttendance]]);
}

// 역할별 탭 화면: tabs = [[키, 이름, 그리는 함수]]
function tabbedHome(view, profile, tabs) {
  // 클레임은 식당(홀)만 받는다. CK·F&B 직원 화면에는 클레임 탭을 두지 않는다.
  if (profile.store_kind !== "restaurant") tabs = tabs.filter((t) => t[0] !== "cl");
  // F&B(본사 사무직): 업무지시를 받는 "업무" 탭
  // 업무지시는 대표·부대표가 전 직원에게 개별로 내린다 → 모든 직원에게 "업무" 탭. 기록(일지·일정)은 F&B 본사만.
  if (profile.store_kind === "hq") tabs = [["tk", t("업무"), renderTasks], ["wk", t("기록"), renderWork], ...tabs];
  else tabs = [...tabs, ["tk", t("업무"), renderTasks], ["wk", t("기록"), renderWork]]; // 식당·CK 직원은 기존 첫 화면(출퇴근·보고·점검)을 그대로 두고 맨 뒤에
  // 정산 자료 올리기 권한이 있는 직원(경리·사무): 통장·정산 엑셀을 올리는 수금 대조 탭
  // 게장·F&B 두 사업장의 매출·지출, 통장·수금을 모두 본다(사업장 선택은 재무 탭 안에서)
  if (profile.can_settle && profile.store_kind === "hq") tabs = [...tabs, ["st", t("재무"), renderFinance], ["ship", t("송장"), renderShip]];
  // CK: 작업자 점검 탭, 관리자(중간관리자·매니저)는 점검 현황 탭도
  if (profile.store_kind === "ck") {
    const extra = [["chk", t("점검"), renderChecklist]];
    if (profile.role === "supervisor" || profile.role === "manager") extra.push(["chkb", t("점검 현황"), (pane) => renderChecklistAdmin(pane, null, { master: false, itemsView: false })]);
    tabs = [...extra, ...tabs];
  }
  // 말로 업무지시(AI): 매니저·중간관리자는 내 담당 직원에게만(서버가 정함)
  if (profile.role === "manager" || profile.role === "supervisor") tabs = [...tabs, ["ai", t("AI지시"), (pane) => import("./screens/ai-task.js").then((m) => m.renderAiTask(pane, {})).catch((e) => pane.replaceChildren(h("p", { class: "err", style: "padding:16px" }, t("화면을 불러오지 못했어요: {msg}", { msg: t(e.message) }))))]];
  tabs = [...tabs, ["lib", t("자료"), renderLibrary], ["sg", t("건의"), renderSuggest]]; // 자료함(서식·파일), 건의함: 모든 직원
  let tab = resumeTab && tabs.some((x) => x[0] === resumeTab) ? resumeTab : tabs[0][0];
  resumeTab = null;
  const body = h("div", { id: "mbody" });
  const bar = h("div", { class: "page", style: "padding-bottom:0" });
  // 탭 줄은 다시 그릴 때마다 새로 만들어져 옆으로 밀어 둔 위치가 처음으로 돌아간다 → 위치를 보존하고, 고른 탭이 화면 안에 오게 한다
  const drawBar = () => {
    const x = bar.querySelector(".tabs")?.scrollLeft ?? 0;
    bar.replaceChildren(h("div", { class: "tabs" }, tabs.map(([k, l]) =>
      h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; show(); } }, l))));
    const row = bar.querySelector(".tabs");
    row.scrollLeft = x;
    // 고른 탭이 줄 안에 보이게 옆으로만 민다. scrollIntoView 는 세로로도 움직여서, 아래로 내려 본 뒤 탭이 늦게 추가되면 화면이 맨 위로 올라갔다
    const on = bar.querySelector(".tab.on");
    if (on) {
      const rr = row.getBoundingClientRect(), tr = on.getBoundingClientRect();
      if (tr.left < rr.left) row.scrollLeft += tr.left - rr.left;
      else if (tr.right > rr.right) row.scrollLeft += tr.right - rr.right;
    }
  };
  const show = async () => {
    curTab = tab;
    drawBar();
    // 탭마다 새 컨테이너: 탭을 떠난 화면의 타이머·늦게 끝난 그리기가 지금 화면을 덮어쓰지 못하게 한다
    const pane = h("div");
    body.replaceChildren(pane);
    if (tab !== "st") api.setStore(null); // 재무 탭에서 고른 사업장이 다른 탭(내 출퇴근 등)에 남지 않게
    await tabs.find((t) => t[0] === tab)[2](pane, profile);
  };
  // 공지: 탭 줄 위. 공지가 없으면 자리는 비어 있다(높이 0). 불러오기가 실패해도 다른 화면에는 영향이 없다
  const nt = h("div", { id: "notices" });
  view.append(nt, bar, body);
  import("./screens/notices.js").then((m) => m.mountNotices(nt, profile)).catch((e) => console.warn("[공지] 화면을 불러오지 못했어요:", e?.message));
  show();
  // 프로젝트 탭: 모든 직원에게 보인다(새 프로젝트도 직원이 직접 만든다). ?p=프로젝트&post=글 주소로 바로 열기도 한다.
  const dl = new URLSearchParams(location.search);
  let pjOpts = { openId: dl.get("p") || null, postId: dl.get("post") || null };
  import("./screens/projects.js").then(async (m) => {
    const s = await m.pjSummary();
    if (tabs.some((t) => t[0] === "pj")) return; // 모든 직원이 프로젝트를 만들고 쓸 수 있어서 탭은 항상 보인다
    const at = tabs.findIndex((t) => t[0] === "lib");
    const label = s.newPosts > 0 ? t("프로젝트 {n}", { n: s.newPosts > 99 ? "99+" : s.newPosts }) : t("프로젝트");
    tabs.splice(at < 0 ? tabs.length : at, 0, ["pj", label, (pane) => {
      const o = pjOpts; pjOpts = {};
      if (o.openId) { try { history.replaceState(history.state, "", location.pathname); } catch { /* 무시 */ } }
      return m.renderProjects(pane, o);
    }]);
    if (pjOpts.openId) { tab = "pj"; show(); } else drawBar(); // 주소로 들어왔을 때만 화면을 바꾼다
  }).catch(() => { /* 프로젝트 화면 문제는 다른 화면에 영향을 주지 않는다 */ });
}
// 첫 화면(로그인)도 기억해 둔 언어로: 이 기기에 저장된 언어 → 베트남어 폰이면 베트남어 → 한국어
setLang(savedLang(), { persist: false }).finally(() => boot());
