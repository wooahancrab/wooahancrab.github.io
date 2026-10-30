// 프로젝트 아카이브 — 목록 · 프로젝트 화면 틀 · 참여자 탭 · 새 프로젝트/설정 창 (supabase/projects.sql, src/lib/pj-api.js)
// 피드·파일 탭은 눌렀을 때 project-feed.js / project-files.js 를 불러온다(그 파일에 문제가 있어도 목록·참여자는 그대로 동작).
// 사용자가 쓴 글자(이름·설명·파일 이름 등)는 모두 h() 로 글자로만 넣는다(innerHTML 안 씀).
import { api } from "../lib/api.js";
import { h, toast, modal, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD } from "../lib/kst.js";

const NOTICE = "대표·부대표는 모든 프로젝트를 볼 수 있어요. 고객 개인정보·급여·통장 자료는 올리지 마세요";
const MEMBERS_NOTE = "대표·부대표는 명단에 없어도 모든 프로젝트를 볼 수 있어요";
const COLORS = [
  ["#c8402a", "빨강"], ["#d9822b", "주황"], ["#c9a227", "노랑"], ["#2e8b57", "초록"],
  ["#14919b", "청록"], ["#3b6fb6", "파랑"], ["#7b5ea7", "보라"], ["#6b7280", "회색"],
];
const TABS = [["feed", "피드"], ["files", "파일"], ["members", "참여자"]];

const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c ?? "")) ? String(c) : COLORS[0][0]);
const msgOf = (e) => String((e && e.message) || "").trim() || "처리하지 못했어요";
const fmtDay = (iso) => { try { return labelMD(dateOf(iso)); } catch { return ""; } };
const timeOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
// 저장 공간 표시용: 바이트 → MB (10 MB 미만은 소수 한 자리)
const fmtMB = (bytes) => {
  const mb = bytes / 1048576;
  return mb.toLocaleString("ko-KR", { maximumFractionDigits: mb < 10 ? 1 : 0 });
};

// 알림은 카카오톡·네이버 같은 앱 안의 브라우저에서는 켤 수 없다
const IN_APP_RE = /KAKAOTALK|NAVER\(inapp|Instagram|FB_IAB|FBAN|FBAV|DaumApps|\bLine\//i;
const inAppBrowser = () => { try { return IN_APP_RE.test(navigator.userAgent || ""); } catch { return false; } };
const IN_APP_HINT = "카카오톡·네이버 같은 앱 안의 화면에서는 알림을 켤 수 없어요. 오른쪽 위 메뉴에서 [다른 브라우저로 열기]를 눌러 Chrome(안드로이드)이나 Safari(아이폰)에서 열어 주세요";
// api.enablePush() 의 오류를 알아보기 쉬운 안내로 바꾼다
function pushErrText(e) {
  const m = msgOf(e);
  if (/허용되지 않/.test(m)) return "알림이 막혀 있어요. 주소창 옆 자물쇠(또는 설정)에서 알림을 [허용]으로 바꾼 뒤 다시 눌러 주세요";
  if (/지원하지 않/.test(m)) {
    return inAppBrowser() ? IN_APP_HINT
      : "이 브라우저에서는 알림을 켤 수 없어요. Chrome(안드로이드)이나 Safari(아이폰)에서 열어 주세요. 아이폰은 Safari의 [공유 → 홈 화면에 추가]로 설치한 앱에서만 알림이 와요";
  }
  if (/VAPID/i.test(m)) return "알림 설정이 아직 끝나지 않았어요. 담당자에게 알려 주세요";
  return /[가-힣]/.test(m) ? m : `알림을 켜지 못했어요 (${m.slice(0, 80)})`;
}

// 칸을 비우고 새로 채운다. h() 와 같이 null·false 는 건너뛰고, 배열은 펼친다(replaceChildren 은 false 를 "false" 글자로 넣어서 쓰지 않음)
function put(el, ...kids) {
  el.replaceChildren();
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

// 탭이 맡긴 '떠날 때 할 일'을 실행한다. 던지지 않고, 끝나면(실패해도) 풀리는 약속을 돌려준다
const callSafe = (fn) => { try { return Promise.resolve(fn()).catch(() => {}); } catch { return Promise.resolve(); } };

/* ---------------- 스타일 (이 파일 전용, 한 번만) ---------------- */
const CSS = `
.pj-top{display:flex;align-items:center;gap:8px;margin:2px 0 6px}
.pj-top h1{flex:1;min-width:0;margin:.3em 0}
.pj-mini{flex:none;min-height:40px;padding:0 12px;border:2px solid var(--line);background:#fff;border-radius:12px;font-weight:700;font-size:.85rem;cursor:pointer}
.pj-mini:disabled{opacity:.6}
.pj-chips{display:flex;gap:8px;overflow-x:auto;padding:8px 0 6px;scrollbar-width:none}
.pj-chips::-webkit-scrollbar{display:none}
.pj-chips .chip{flex:none;min-height:42px;padding:0 18px;font-weight:700}
.pj-chips .chip.on{background:var(--red);border-color:var(--red);color:#fff}
.pj-empty{margin:18px 4px;line-height:1.6}
.pj-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px}
.pj-card{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0;min-height:132px;padding:0 12px 12px;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;cursor:pointer}
.pj-card:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.pj-card-bar{height:8px;margin:0 -12px 8px;background:var(--pj-c,#c8402a);flex:none}
.pj-card-name{font-weight:800;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}
.pj-card.has-new .pj-card-name{padding-right:30px}
.pj-card-meta{font-size:.8rem;color:var(--muted)}
.pj-new{position:absolute;top:14px;right:8px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--bad);color:#fff;font-size:.72rem;font-weight:800;display:grid;place-items:center}
.pj-tag{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background:#f3e9e2;color:var(--muted);font-size:.72rem;font-weight:700}
.pj-card.dim{background:#f6f1ec}
.pj-card.dim .pj-card-bar,.pj-card.dim .pj-card-name,.pj-card.dim .pj-card-meta{opacity:.55}
.pj-card .btn.pj-join{margin:8px 0 0;min-height:38px;font-size:.85rem;padding:0 8px}
.pj-head{margin:2px 0 4px}
.pj-head-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pj-head-row .grow{flex:1}
.pj-title{display:flex;align-items:center;gap:10px;margin-top:8px}
.pj-title h1{margin:0;font-size:1.25rem;min-width:0;word-break:keep-all;overflow-wrap:anywhere}
.pj-dot{flex:none;width:14px;height:14px;border-radius:50%}
.pj-descr{margin:4px 0 0;font-size:.9rem;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.pj-descr.open{display:block}
.pj-meta{margin-top:4px}
.pj-banner{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0 0;padding:10px 12px;background:#fff1e0;border:1px solid #f0cf9f;border-radius:12px;font-size:.85rem}
.pj-banner span{flex:1;min-width:60%}
.pj-tabs{display:flex;gap:6px;overflow-x:auto;margin:10px 0 6px;padding-bottom:2px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.pj-tabs::-webkit-scrollbar{display:none}
.pj-tab{flex:1 0 auto;min-height:46px;padding:0 16px;border:2px solid var(--line);background:#fff;border-radius:12px;font-weight:700;font-size:.9rem;cursor:pointer;white-space:nowrap}
.pj-tab.on{background:var(--red);border-color:var(--red);color:#fff}
.pj-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}
.pj-sec-head h2{margin:0}
.pj-mem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:14px}
.pj-mem-main{flex:1;min-width:40%}
.pj-mem-name{font-weight:700;overflow-wrap:anywhere}
.pj-mem-acts{display:flex;gap:10px;flex-wrap:wrap;width:100%}
.pj-role{flex:none;padding:3px 9px;border-radius:12px;font-size:.72rem;font-weight:700;white-space:nowrap}
.pj-role.admin{background:#3b6fb6;color:#fff}
.pj-role.member{background:#f3e9e2;color:var(--muted)}
.pj-swatches{display:flex;gap:10px;flex-wrap:wrap}
.pj-sw{flex:none;width:40px;height:40px;padding:0;border-radius:50%;border:3px solid #fff;background:var(--c);box-shadow:0 0 0 1px var(--line);cursor:pointer}
.pj-sw.on{box-shadow:0 0 0 3px var(--ink)}
.pj-check{display:flex;gap:10px;align-items:flex-start;font-size:.9rem}
.pj-check input,.pj-pick-row input,.pj-pick-head input{flex:none;width:22px;height:22px;margin:0}
.pj-pick{max-height:240px;overflow:auto;padding:6px 8px;border:1px solid var(--line);border-radius:10px}
.pj-pick-head{display:flex;align-items:center;gap:10px;min-height:40px;font-weight:700}
.pj-pick-row{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 4px 0 8px}
.pj-pick-row.off,.pj-pick-group.off{display:none}
.pj-danger{margin-top:6px;padding-top:8px;border-top:1px solid var(--line)}
.pj-danger .btn{margin:6px 0 0}
.pj-push{margin:0 0 6px}
.pj-push .err{margin:6px 2px 0;font-size:.85rem;line-height:1.5}
.pj-usage{margin:0 2px 4px;font-size:.8rem}
.pj-push:empty,.pj-usage:empty{display:none}
.pj-bell-row{margin-top:8px}
.pj-mini.off{background:#f6f1ec;color:var(--muted)}
`;

function ensureStyle() {
  if (document.getElementById("pj-main-style")) return;
  const st = document.createElement("style");
  st.id = "pj-main-style";
  st.textContent = CSS;
  document.head.append(st);
}

/* ---------------- 목록 위 숫자 (main.js 의 탭 배지용, 절대 던지지 않음) ---------------- */
// 내가 참여한 진행 중(active) 프로젝트 수와 그 안의 새 글 합계
export async function pjSummary() {
  try {
    if (typeof api.pj !== "function") return { joined: 0, newPosts: 0 };
    const pj = await api.pj();
    const rows = await pj.overview();
    let joined = 0, newPosts = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.my_role || r.status !== "active") continue;
      joined++;
      newPosts += Number(r.new_posts) || 0;
    }
    return { joined, newPosts };
  } catch {
    return { joined: 0, newPosts: 0 };
  }
}

/* ---------------- 직원 고르기 (사업장별 묶음 체크) ---------------- */
// people: pj.people() 행들. skip: 이미 참여 중이라 빼는 user_id 모음. 돌려주는 picked() 는 체크한 user_id 배열
function peoplePicker(people, skip) {
  const list = (Array.isArray(people) ? people : []).filter((p) => p && p.user_id && !(skip && skip.has(p.user_id)));
  if (!list.length) return { el: h("p", { class: "muted" }, "추가할 수 있는 직원이 없어요"), picked: () => [], empty: true };
  const groups = new Map();
  for (const p of list) {
    const g = String(p.store_name ?? "").trim() || "소속 없음";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const count = h("div", { class: "hint" });
  const all = [];
  const gs = [];
  const updateCount = () => {
    const n = all.filter((k) => k.cb.checked).length;
    count.textContent = n ? `${n}명 선택` : "";
  };
  for (const [gname, ps] of groups) {
    const head = h("input", { type: "checkbox", "aria-label": `${gname} 전체 선택` });
    const kids = ps.map((p) => {
      const cb = h("input", { type: "checkbox", value: p.user_id });
      const who = h("span", null, p.display_name || "(이름 없음)", p.job_title ? h("span", { class: "muted" }, " " + p.job_title) : null);
      const k = { cb, p, off: false, label: h("label", { class: "pj-pick-row" }, cb, who) };
      all.push(k);
      return k;
    });
    const sync = () => {
      const n = kids.filter((k) => k.cb.checked).length;
      head.checked = n > 0 && n === kids.length;
      head.indeterminate = n > 0 && n < kids.length;
      updateCount();
    };
    head.addEventListener("change", () => {
      for (const k of kids) if (!k.off) k.cb.checked = head.checked;
      sync();
    });
    for (const k of kids) k.cb.addEventListener("change", sync);
    const title = h("label", { class: "pj-pick-head" }, head, h("span", null, gname, h("span", { class: "muted" }, ` ${ps.length}명`)));
    gs.push({ kids, el: h("div", { class: "pj-pick-group" }, title, kids.map((k) => k.label)) });
  }
  const filter = h("input", { class: "inp", type: "search", placeholder: "이름 검색", "aria-label": "직원 이름 검색", autocomplete: "off" });
  filter.addEventListener("input", () => {
    const key = filter.value.trim().toLowerCase();
    for (const g of gs) {
      let any = false;
      for (const k of g.kids) {
        const hit = !key || `${k.p.display_name ?? ""} ${k.p.job_title ?? ""}`.toLowerCase().includes(key);
        k.off = !hit;
        k.label.classList.toggle("off", !hit);
        if (hit) any = true;
      }
      g.el.classList.toggle("off", !any);
    }
  });
  const el = h("div", { class: "stack" }, filter, h("div", { class: "pj-pick" }, gs.map((g) => g.el)), count);
  return { el, picked: () => all.filter((k) => k.cb.checked).map((k) => k.cb.value), empty: false };
}

/* ---------------- 새 프로젝트 / 설정 창 ---------------- */
// project 가 없으면 새로 만들기, 있으면 설정. 돌려주는 값: { changed, createdId?, deleted? }
async function projectForm({ pj, prof, isTop, project }) {
  const edit = !!project;
  const name = h("input", { class: "inp", type: "text", maxlength: "60", placeholder: "프로젝트 이름 (예: 신제품 출시)", "aria-label": "프로젝트 이름", autocomplete: "off" });
  name.value = project?.name ?? "";
  const descr = h("textarea", { class: "inp", rows: "3", maxlength: "500", placeholder: "설명 (선택)", "aria-label": "프로젝트 설명" });
  descr.value = project?.descr ?? "";

  let color = safeColor(project?.color ?? COLORS[0][0]);
  const swatches = COLORS.map(([c, nm]) => {
    const b = h("button", { type: "button", class: "pj-sw", style: `--c:${c}`, title: nm, "aria-label": `${nm} 색` });
    b.dataset.c = c;
    b.addEventListener("click", () => { color = c; paintSw(); });
    return b;
  });
  function paintSw() {
    for (const b of swatches) {
      const on = b.dataset.c.toLowerCase() === color.toLowerCase();
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  paintSw();

  const ai = h("input", { type: "checkbox" });
  ai.checked = edit ? project.ai_ok !== false : true;

  // 새 프로젝트일 때만 참여자 고르기(설정에서는 참여자 탭에서 관리)
  let picker = null, pickNote = "";
  if (!edit) {
    let people = [];
    try { people = await pj.people(); } catch (e) { pickNote = "직원 명단을 불러오지 못했어요: " + msgOf(e); }
    picker = peoplePicker(people, new Set([prof.user_id]));
  }

  // 설정 창의 보관/삭제 버튼: 누르면 할 일을 적어 두고 창의 [저장] 을 눌러 닫는다(아래 for 루프가 이어서 처리)
  let action = null;
  const okBtn = () => {
    const d = content.closest(".dialog");
    return d ? [...d.children].find((el) => el.tagName === "BUTTON" && el.classList.contains("primary")) : null;
  };
  const trigger = (a) => {
    action = a;
    const b = okBtn();
    if (b) b.click();
  };
  let danger = null;
  if (edit) {
    const archived = project.status === "archived";
    danger = h("div", { class: "pj-danger" },
      h("div", { class: "lbl" }, "프로젝트 관리"),
      h("button", { type: "button", class: "btn ghost slim", onclick: () => trigger(archived ? "reopen" : "archive") }, archived ? "다시 열기" : "보관하기"),
      prof.role === "owner" && h("button", { type: "button", class: "btn ghost slim danger", onclick: () => trigger("delete") }, "프로젝트 삭제 (대표만)"));
  }

  const content = h("div", { class: "stack pj-form" },
    h("label", { class: "lbl" }, "이름"), name,
    h("label", { class: "lbl" }, "설명"), descr,
    h("div", { class: "lbl" }, "색"), h("div", { class: "pj-swatches" }, swatches),
    isTop && h("label", { class: "pj-check" }, ai, h("span", null, "AI 질문에 이 프로젝트 글이 쓰여도 돼요")),
    picker && h("div", { class: "lbl" }, "참여자 (나중에 추가해도 돼요)"),
    pickNote && h("p", { class: "err" }, pickNote),
    picker && picker.el,
    h("p", { class: "hint" }, NOTICE),
    danger);

  // 보관/다시 열기/삭제. 끝났으면 결과 객체, 취소하거나 실패하면 null(창을 다시 연다)
  async function runAction(a) {
    if (a === "archive" || a === "reopen") {
      const toArch = a === "archive";
      const items = [project.name, toArch ? "보관하면 읽기만 되고, 새 글·댓글·파일을 올릴 수 없어요" : "다시 글·댓글·파일을 올릴 수 있어요"];
      if (!(await confirmDialog(toArch ? "프로젝트를 보관할까요?" : "프로젝트를 다시 열까요?", items, "취소", toArch ? "보관하기" : "다시 열기"))) return null;
      try {
        await pj.updateProject(project.id, { status: toArch ? "archived" : "active" });
        toast(toArch ? "보관했어요" : "다시 열었어요", 2000);
        return { changed: true };
      } catch (e) {
        toast(msgOf(e), 5000);
        return null;
      }
    }
    if (a === "delete") {
      if (!(await confirmDialog("프로젝트를 지울까요?", [project.name, "글·댓글·사진·파일이 모두 지워지고 되돌릴 수 없어요"], "취소", "계속"))) return null;
      // 두 번째 확인은 이름을 직접 써야 넘어간다. 확인창 두 개가 같은 자리에 같은 단추를 띄워서, 연달아 두 번 눌러도 지워지는 일을 막는다
      const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
      const typed = h("input", { class: "inp", type: "text", placeholder: "프로젝트 이름을 그대로 입력", "aria-label": "지울 프로젝트 이름 확인", autocomplete: "off" });
      const sure = h("div", { class: "stack" },
        h("p", null, "마지막 확인이에요. 지운 뒤에는 되돌릴 방법이 없어요"),
        h("p", { style: "font-weight:800;overflow-wrap:anywhere" }, project.name),
        h("p", { class: "hint" }, "위 이름을 똑같이 입력하고 [영구 삭제] 를 눌러 주세요"),
        typed);
      for (;;) {
        if (!(await modal("정말 지울까요?", sure, "영구 삭제", "취소"))) return null;
        if (norm(typed.value) === norm(project.name)) break;
        toast("프로젝트 이름이 달라요. 똑같이 입력해 주세요", 3000);
      }
      toast("지우는 중이에요. 파일이 많으면 시간이 걸려요", 20000);
      try {
        await pj.deleteProject(project.id);
        toast("프로젝트를 지웠어요", 2500);
        return { changed: true, deleted: true };
      } catch (e) {
        toast(msgOf(e), 7000);
        return null;
      }
    }
    return null;
  }

  for (;;) {
    action = null;
    if (!(await modal(edit ? "프로젝트 설정" : "새 프로젝트", content, edit ? "저장" : "만들기", "취소"))) return { changed: false };
    if (action) {
      const r = await runAction(action);
      if (r) return r;
      continue;
    }
    const nm = name.value.trim();
    if (!nm) { toast("프로젝트 이름을 넣어 주세요"); continue; }
    const ds = descr.value.trim();
    try {
      if (!edit) {
        const id = await pj.createProject({ name: nm, descr: ds, color, ai_ok: isTop ? ai.checked : true, member_ids: picker ? picker.picked() : [] });
        toast("프로젝트를 만들었어요", 2000);
        return { changed: true, createdId: id };
      }
      const patch = {};
      if (nm !== project.name) patch.name = nm;
      if (ds !== String(project.descr ?? "")) patch.descr = ds;
      if (color.toLowerCase() !== String(project.color ?? "").toLowerCase()) patch.color = color;
      if (isTop && ai.checked !== (project.ai_ok !== false)) patch.ai_ok = ai.checked;
      if (!Object.keys(patch).length) return { changed: false };
      await pj.updateProject(project.id, patch);
      toast("저장했어요", 1800);
      return { changed: true };
    } catch (e) {
      // 프로젝트는 만들어졌는데 참여자 추가만 실패한 경우: 프로젝트는 남기고 그 화면으로 보낸다
      if (e && e.projectId) { toast(msgOf(e), 7000); return { changed: true, createdId: e.projectId }; }
      toast(msgOf(e), 6000);
    }
  }
}

/* ---------------- 참여자 탭 ---------------- */
async function renderMembers({ pane, ctx, live, onLeft }) {
  const pj = ctx.pj;
  const state = { list: [], err: "", loading: true };

  async function load() {
    try { state.list = await pj.members(ctx.project.id); state.err = ""; } catch (e) { state.err = msgOf(e); }
    state.loading = false;
    if (live()) draw();
  }

  function rowEl(m, me) {
    const mine = m.user_id === me;
    const admin = m.role === "admin";
    const acts = ctx.canAdmin && !mine
      ? h("div", { class: "pj-mem-acts" },
        h("button", { type: "button", class: "linkbtn", onclick: () => toggleRole(m) }, admin ? "임직원으로 변경" : "관리자로 지정"),
        h("button", { type: "button", class: "linkbtn bad-text", onclick: () => kick(m) }, "내보내기"))
      : null;
    return h("div", { class: "pj-mem" },
      h("div", { class: "pj-mem-main" },
        h("div", { class: "pj-mem-name" }, m.user_name || "(이름 없음)", mine ? h("span", { class: "muted" }, " (나)") : null),
        m.job_title ? h("div", { class: "muted" }, m.job_title) : null),
      h("span", { class: "pj-role " + (admin ? "admin" : "member") }, admin ? "프로젝트 관리자" : "임직원"),
      acts);
  }

  function draw() {
    const y = scrollY;
    const me = ctx.profile?.user_id;
    const list = [...state.list].sort((a, b) =>
      (a.role === b.role ? 0 : a.role === "admin" ? -1 : 1) || String(a.user_name ?? "").localeCompare(String(b.user_name ?? ""), "ko"));
    let body;
    if (state.loading) body = h("p", { class: "muted" }, "불러오는 중…");
    else if (state.err) {
      body = h("div", null,
        h("p", { class: "err" }, "불러오기 실패: " + state.err),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => { state.loading = true; state.err = ""; draw(); load(); } }, "다시 시도"));
    } else if (!list.length) body = h("p", { class: "muted" }, "참여자가 없어요");
    else body = h("div", { class: "list" }, list.map((m) => rowEl(m, me)));
    put(pane,
      h("div", { class: "pj-sec-head" },
        h("h2", null, state.loading ? "참여자" : `참여자 ${state.list.length}명`),
        ctx.canAdmin ? h("button", { type: "button", class: "pj-mini", onclick: () => addPeople() }, "+ 참여자 추가") : null),
      body,
      ctx.myRole ? h("button", { type: "button", class: "btn ghost slim danger", style: "margin-top:14px", onclick: () => leave() }, "프로젝트 나가기") : null,
      h("p", { class: "hint", style: "margin-top:10px" }, MEMBERS_NOTE));
    scrollTo(0, y);
  }

  // 다시 불러오고, 머리줄의 참여 인원도 새로 고친다
  async function refresh() {
    await load();
    ctx.reloadProject();
  }

  async function addPeople() {
    let people = [];
    try { people = await pj.people(); } catch (e) { toast(msgOf(e), 5000); return; }
    const picker = peoplePicker(people, new Set(state.list.map((m) => m.user_id)));
    const content = h("div", { class: "stack" }, picker.el, h("p", { class: "hint" }, NOTICE));
    for (;;) {
      if (!(await modal("참여자 추가", content, "추가", "취소"))) return;
      const ids = picker.picked();
      if (!ids.length) { toast("추가할 사람을 골라 주세요"); continue; }
      try {
        const n = await pj.addMembers(ctx.project.id, ids);
        toast(n ? `${n}명을 추가했어요` : "이미 모두 참여 중이에요", 2200);
        await refresh();
        return;
      } catch (e) {
        toast(msgOf(e), 5000);
      }
    }
  }

  async function toggleRole(m) {
    const to = m.role === "admin" ? "member" : "admin";
    const items = [m.user_name || "(이름 없음)", to === "admin" ? "참여자 추가·내보내기, 남의 글 삭제, 상단고정을 할 수 있어요" : "프로젝트 관리 권한이 없어져요"];
    if (!(await confirmDialog(to === "admin" ? "프로젝트 관리자로 지정할까요?" : "임직원으로 바꿀까요?", items, "취소", "바꾸기"))) return;
    try {
      await pj.setRole(ctx.project.id, m.user_id, to);
      toast("역할을 바꿨어요", 1800);
      await refresh();
    } catch (e) { toast(msgOf(e), 5000); }
  }

  async function kick(m) {
    if (!(await confirmDialog("내보낼까요?", [m.user_name || "(이름 없음)", "올린 글과 파일은 그대로 남아요"], "취소", "내보내기"))) return;
    try {
      await pj.removeMember(ctx.project.id, m.user_id);
      toast("내보냈어요", 1800);
      await refresh();
    } catch (e) { toast(msgOf(e), 5000); }
  }

  async function leave() {
    const adminN = state.list.filter((m) => m.role === "admin").length;
    const lastAdmin = ctx.myRole === "admin" && !ctx.isTop && adminN <= 1;
    const items = [ctx.project.name, "나가도 내가 쓴 글과 파일은 그대로 남아요"];
    if (lastAdmin) items.push("내가 마지막 프로젝트 관리자예요. 나가면 대표·부대표만 참여자를 관리할 수 있어요");
    if (!(await confirmDialog("프로젝트에서 나갈까요?", items, "취소", "나가기"))) return;
    try {
      await pj.leave(ctx.project.id);
      toast("프로젝트에서 나왔어요", 2000);
      onLeft();
    } catch (e) { toast(msgOf(e), 5000); }
  }

  draw();
  await load();
}

/* ---------------- 화면 본체 ---------------- */
// root: 그릴 칸. opts: { onBack?, openId?, postId? }
export async function renderProjects(root, opts = {}) {
  ensureStyle();
  let seen = false, gone = false;     // 화면이 붙은 적이 있는지 / 사라졌는지
  let view = "list";                  // "list" | "project"
  let rows = [], err = "", loading = true, loadSeq = 0, lastLoadAt = 0;
  let chip = "joined", chipAuto = false, q = "";
  let shell = null;                   // 목록 화면의 칩 줄·격자 칸
  let cur = null;                     // 열려 있는 프로젝트 세션
  let pushed = false;                 // 안드로이드 뒤로가기용 history 항목을 내가 하나 쌓았는가
  let histTok = "";                   // 내가 쌓은 항목의 표식(리스너 실행 순서에 기대지 않고 '내 항목으로 돌아온 것'을 알아보려는 것)
  let backing = false;                // 목록으로 돌아가는 중(뒤로가기 처리 대기)
  let listY = 0;                     // 목록 스크롤 위치(프로젝트에서 돌아올 때 복원)
  let pj = null, prof = null, isTop = false;
  let pushHint = "";                  // [알림 켜기] 가 실패했을 때 목록 위에 남겨 두는 안내
  let usageText = "", usageAt = 0, usageBusy = false; // 저장 공간 줄(대표·부대표만)
  let watchTimer = 0;                 // 화면이 떨어졌는지 1초마다 살피는 타이머(메인 탭 전환 등은 알려 주는 곳이 없다)

  // 화면이 아직 살아 있나. 한 번 붙은 뒤 떨어졌으면(다른 탭으로 갔거나 다시 그려짐) 끝난 것으로 보고 리스너를 거둔다
  function alive() {
    if (gone) return false;
    if (root.isConnected) { seen = true; return true; }
    if (seen) { gone = true; teardown(); return false; }
    return true; // 아직 붙기 전(부른 쪽이 나중에 붙이는 경우)
  }
  function teardown() {
    clearInterval(watchTimer);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("popstate", onPop);
    runLeave(cur); // 화면째 떨어질 때도 열려 있던 탭의 마무리(읽음 전송)를 시킨다
  }
  // 프로젝트 탭이 ctx.onLeave 로 맡긴(또는 render 함수가 돌려준) 마무리를 한 번씩 실행하고 비운다
  function runLeave(session) {
    const hooks = session && session.leaveHooks ? session.leaveHooks.splice(0) : [];
    return Promise.all(hooks.map(callSafe));
  }
  function onVis() {
    if (!alive()) return;
    if (document.visibilityState !== "visible" || view !== "list") return;
    if (Date.now() - lastLoadAt < 3000) return;
    loadList({ silent: true });
  }
  function onPop(e) {
    if (!alive()) return;
    // 내 항목으로 되돌아온 것이면 그 위에 있던 것(큰 사진 보기)이 빠진 것이므로 화면은 그대로 둔다
    if (e && e.state && e.state.pjScreen === histTok) return;
    if (view === "project" && pushed) { pushed = false; showList(); }
  }
  function pushHist() {
    if (pushed) return;
    try {
      const tok = Math.random().toString(36).slice(2) + Date.now().toString(36);
      history.pushState({ pjScreen: tok }, "");
      histTok = tok;
      pushed = true;
    } catch { pushed = false; }
  }
  // 프로젝트 화면 → 목록. 쌓아 둔 history 항목이 있으면 되돌려서(popstate 가 목록을 그림) 뒤로가기와 같게 맞춘다
  function backToList() {
    if (view !== "project" || backing) return; // 연타해도 history.back() 은 한 번만
    backing = true;
    if (pushed) {
      const s = cur;
      try {
        history.back();
        // popstate 가 오지 않는 드문 경우를 대비해 잠시 뒤에도 그대로면 직접 목록으로
        setTimeout(() => { if (alive() && view === "project" && cur === s) { pushed = false; showList(); } }, 500);
        return;
      } catch { /* 아래에서 직접 목록으로 */ }
    }
    pushed = false;
    showList();
  }

  const outerBack = () => (opts.onBack ? h("button", { type: "button", class: "linkbtn back", onclick: () => opts.onBack() }, "← 목록") : null);

  root.replaceChildren(h("div", { class: "page" }, outerBack(), h("p", { class: "muted" }, "불러오는 중…")));
  try {
    if (typeof api.pj !== "function") throw new Error("프로젝트 기능을 쓸 수 없어요");
    pj = await api.pj();
    prof = await pj.profile();
  } catch (e) {
    if (!alive()) return;
    const m = String((e && e.message) || "");
    const text = /[가-힣]/.test(m) ? m : "프로젝트를 불러오지 못했어요" + (m ? ` (${m.slice(0, 100)})` : "");
    root.replaceChildren(h("div", { class: "page" }, outerBack(), h("h1", null, "📋 프로젝트"), h("p", { class: "err" }, text)));
    return;
  }
  if (!alive()) return;
  isTop = prof.role === "owner" || prof.role === "deputy";
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("popstate", onPop);
  watchTimer = setInterval(alive, 1000);

  /* ----- 목록 ----- */
  const joinedActive = (r) => !!r.my_role && r.status === "active";

  // 처음 한 번: 대표·부대표가 참여한 프로젝트가 하나도 없으면 [전체] 칩으로 시작
  function pickDefaultChip() {
    if (chipAuto || !rows.length) return;
    chipAuto = true;
    if (isTop && !rows.some(joinedActive) && rows.some((r) => r.status === "active")) chip = "all";
  }

  function drawListShell() {
    const search = h("input", { class: "inp", type: "search", placeholder: "프로젝트 이름 검색", "aria-label": "프로젝트 이름 검색", autocomplete: "off" });
    search.value = q;
    search.addEventListener("input", () => { q = search.value; drawGrid(); });
    const chipsBox = h("div", { class: "pj-chips" });
    const gridBox = h("div");
    const pushBox = h("div", { class: "pj-push" });
    const usageBox = h("div", { class: "muted pj-usage" });
    shell = { chipsBox, gridBox, pushBox, usageBox };
    root.replaceChildren(h("div", { class: "page" },
      outerBack(),
      h("div", { class: "pj-top" },
        h("h1", null, "📋 프로젝트"),
        h("button", { type: "button", class: "pj-mini", onclick: () => { usageAt = 0; loadUsage(); loadList({ manual: true }); } }, "↻ 새로고침")),
      usageBox,
      pushBox,
      search,
      chipsBox,
      h("button", { type: "button", class: "btn primary", onclick: () => newProject() }, "+ 새 프로젝트"),
      gridBox));
    drawPushBox();
    drawUsage();
    drawChips();
    drawGrid();
  }

  // 이 기기에서 알림이 꺼져 있을 때만 [알림 켜기] 를 보인다
  function drawPushBox() {
    if (!shell || !shell.pushBox) return;
    let need = false;
    try { need = typeof api.pushEnabled === "function" && !api.pushEnabled(); } catch { need = false; }
    if (!need) { put(shell.pushBox); return; }
    put(shell.pushBox,
      h("div", { class: "pj-banner" },
        h("span", null, "새 글 알림을 받으려면 알림을 켜 주세요"),
        h("button", { type: "button", class: "pj-mini", onclick: (ev) => turnOnPush(ev.currentTarget) }, "🔔 알림 켜기")),
      pushHint ? h("p", { class: "err" }, pushHint) : null);
  }

  async function turnOnPush(btn) {
    if (inAppBrowser()) {
      pushHint = IN_APP_HINT;
      drawPushBox();
      return;
    }
    btn.disabled = true;
    try {
      await api.enablePush();
      pushHint = "";
      toast("알림을 켰어요", 2000);
    } catch (e) {
      console.warn("[projects] 알림 켜기 실패:", e);
      pushHint = pushErrText(e);
      toast("알림을 켜지 못했어요", 2500);
    }
    if (alive() && view === "list") drawPushBox();
  }

  function drawUsage() {
    if (shell && shell.usageBox) put(shell.usageBox, usageText || null);
  }

  // 대표·부대표만. 실패하거나 값이 없으면 줄을 숨긴다. 1분 안에는 다시 묻지 않는다
  async function loadUsage() {
    if (!isTop || typeof pj.usage !== "function" || usageBusy) return;
    if (usageText && Date.now() - usageAt < 60000) return;
    usageBusy = true;
    try {
      const u = await pj.usage();
      const bytes = u ? Number(u.bytes) : NaN;
      if (Number.isFinite(bytes) && bytes >= 0) {
        usageText = `저장 공간 약 ${fmtMB(bytes)} MB 사용`;
        usageAt = Date.now();
      } else usageText = "";
    } catch {
      usageText = "";
    }
    usageBusy = false;
    if (alive() && view === "list") drawUsage();
  }

  function drawChips() {
    if (!shell) return;
    const defs = [["joined", "참여 중"], ...(isTop ? [["all", "전체"]] : []), ["arch", "보관"]];
    put(shell.chipsBox, defs.map(([k, label]) =>
      h("button", { type: "button", class: "chip" + (chip === k ? " on" : ""), "aria-pressed": chip === k ? "true" : "false", onclick: () => { chip = k; drawChips(); drawGrid(); } }, label)));
  }

  function emptyText(key) {
    if (key) return "찾는 프로젝트가 없어요";
    if (chip === "arch") return "보관한 프로젝트가 없어요";
    if (chip === "joined" && !isTop) return "참여 중인 프로젝트가 없어요. [+ 새 프로젝트]로 만들거나, 만든 사람에게 참여를 요청해 주세요";
    if (chip === "joined" && rows.some((r) => r.status === "active")) return "참여 중인 프로젝트가 없어요. [전체]에서 프로젝트를 열어 [참여하기]를 눌러 보세요";
    return "아직 프로젝트가 없어요. [+ 새 프로젝트]로 만들어 보세요";
  }

  function drawGrid() {
    if (!shell || view !== "list" || !alive()) return;
    const box = shell.gridBox;
    if (loading && !rows.length) { put(box, h("p", { class: "muted" }, "불러오는 중…")); return; }
    if (err && !rows.length) {
      put(box,
        h("p", { class: "err" }, "불러오기 실패: " + err),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => loadList({ manual: true }) }, "다시 시도"));
      return;
    }
    const key = q.trim().toLowerCase();
    const list = rows.filter((r) => {
      const arch = r.status === "archived";
      const inChip = chip === "joined" ? (!!r.my_role && !arch) : chip === "all" ? !arch : arch;
      return inChip && (!key || String(r.name ?? "").toLowerCase().includes(key));
    }).sort((a, b) =>
      (Number(b.new_posts) || 0) - (Number(a.new_posts) || 0) ||
      timeOf(b.last_post_at || b.created_at) - timeOf(a.last_post_at || a.created_at));
    if (!list.length) { put(box, h("p", { class: "muted pj-empty" }, emptyText(key))); return; }
    put(box, h("div", { class: "pj-grid" }, list.map(card)));
  }

  function card(r) {
    const member = !!r.my_role;
    const n = member ? Number(r.new_posts) || 0 : 0;
    const cls = "pj-card" + (member ? "" : " dim") + (n > 0 ? " has-new" : "");
    const open = () => openProject(r.id);
    const el = h("div", {
      class: cls, role: "button", tabindex: "0", style: `--pj-c:${safeColor(r.color)}`,
      onclick: open,
      onkeydown: (ev) => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === el) { ev.preventDefault(); open(); } },
    },
    h("div", { class: "pj-card-bar" }),
    n > 0 ? h("span", { class: "pj-new", "aria-label": `새 글 ${n}개` }, n > 99 ? "99+" : String(n)) : null,
    h("div", { class: "pj-card-name" }, r.name),
    h("div", { class: "pj-card-meta" }, `👥 ${Number(r.members) || 0}명`, r.status === "archived" ? h("span", { class: "pj-tag" }, "보관됨") : null),
    h("div", { class: "pj-card-meta" }, r.last_post_at ? `최근 글 ${fmtDay(r.last_post_at)}` : "아직 글이 없어요"),
    member ? null : h("button", { type: "button", class: "btn ghost pj-join", onclick: (ev) => { ev.stopPropagation(); joinFromCard(r, ev.currentTarget); } }, "참여하기"));
    return el;
  }

  // silent: 앱이 다시 보일 때의 조용한 새로고침, manual: 버튼으로 누른 새로고침
  async function loadList({ silent = false, manual = false } = {}) {
    const seq = ++loadSeq;
    if (!rows.length) { loading = true; err = ""; drawGrid(); }
    try {
      const data = await pj.overview();
      if (seq !== loadSeq || !alive()) return;
      rows = Array.isArray(data) ? data : [];
      err = "";
      lastLoadAt = Date.now();
      pickDefaultChip();
      drawChips();
    } catch (e) {
      if (seq !== loadSeq || !alive()) return;
      if (!rows.length) err = msgOf(e);
      else if (manual && !silent) toast(msgOf(e), 4000);
    }
    loading = false;
    drawGrid();
  }

  async function joinFromCard(r, btn) {
    btn.disabled = true;
    try {
      await pj.join(r.id);
      toast("참여했어요", 1800);
      await loadList({ manual: true });
    } catch (e) {
      toast(msgOf(e), 5000);
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function newProject() {
    const res = await projectForm({ pj, prof, isTop, project: null });
    if (!res.createdId || !alive() || view !== "list") return;
    openProject(res.createdId);
  }

  function showList() {
    const old = cur;
    const fromMember = !!(old && old.ctx && old.ctx.myRole); // 읽은 글을 서버에 알리는 중일 수 있다
    const left = runLeave(old); // 피드가 모아 둔 '읽음'을 지금 보내게 한다(cur 를 비우기 전에)
    cur = null;
    view = "list";
    backing = false;
    pickDefaultChip();
    drawListShell();
    scrollTo(0, listY);
    listY = 0;
    loadUsage();
    if (!fromMember) { loadList({ silent: true }); return; }
    // 읽음 전송이 끝나면(오래 걸려도 1.5초) 새 글 숫자를 받는다
    Promise.race([left, new Promise((r) => setTimeout(r, 1500))]).then(() => {
      if (alive() && view === "list") loadList({ silent: true });
    });
    // 탭이 마무리를 맡기지 않은 경우를 위한 예비: 잠시 뒤 한 번 더 새로 고쳐 새 글 숫자를 맞춘다
    setTimeout(() => { if (alive() && view === "list") loadList({ silent: true }); }, 2200);
  }

  /* ----- 프로젝트 화면 ----- */
  const mine = (session) => cur === session && view === "project" && alive();

  // 최신 프로젝트 행. 목록 캐시도 같이 새로 고친다
  async function fetchProject(pid) {
    const all = await pj.overview();
    rows = Array.isArray(all) ? all : [];
    lastLoadAt = Date.now();
    const row = rows.find((r) => r.id === pid);
    if (!row) throw Object.assign(new Error("프로젝트를 찾을 수 없어요. 지워졌거나 볼 수 없는 프로젝트예요"), { gone: true });
    return row;
  }

  function openProject(pid, o = {}) {
    if (!alive()) return;
    if (view === "list") listY = scrollY;
    view = "project";
    backing = false;
    const session = { pid, tab: o.tab || "feed", postId: o.postId || null, ctx: null, lastRead: null, muted: false, muteBusy: false, leaveHooks: [], pane: null, head: null, tabsBox: null, body: null };
    cur = session;
    pushHist();
    scrollTo(0, 0);
    drawSkeleton();
    enter(session);
  }

  function drawSkeleton() {
    root.replaceChildren(h("div", { class: "page pj-page" },
      h("div", { class: "pj-head-row" }, h("button", { type: "button", class: "pj-mini", onclick: () => backToList() }, "← 목록")),
      h("p", { class: "muted" }, "불러오는 중…")));
  }

  async function enter(session) {
    let row;
    try {
      row = await fetchProject(session.pid);
      if (!mine(session)) return;
      if (row.my_role) {
        // 열었다고 모두 읽음 처리하지 않는다(글별 읽음은 피드가 보이는 글만 표시). last_read_at 은 기준 시각일 뿐
        const mem = await pj.myMembership(session.pid);
        if (!mine(session)) return;
        session.lastRead = (mem && mem.last_read_at) || null;
        session.muted = !!(mem && mem.muted);
      }
    } catch (e) {
      if (!mine(session)) return;
      root.replaceChildren(h("div", { class: "page pj-page" },
        h("div", { class: "pj-head-row" }, h("button", { type: "button", class: "pj-mini", onclick: () => backToList() }, "← 목록")),
        h("p", { class: "err" }, "불러오기 실패: " + msgOf(e)),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => { drawSkeleton(); enter(session); } }, "다시 시도")));
      return;
    }
    buildCtx(session, row);
    drawProject(session);
  }

  // 피드·파일 탭에 넘기는 ctx. 같은 객체를 계속 고쳐 쓰므로 탭 코드가 ctx.canWrite 등을 나중에 읽어도 최신이다
  function buildCtx(session, row) {
    if (!session.ctx) {
      session.ctx = {
        pj, profile: prof, isTop, postId: session.postId,
        reloadProject: async () => {
          const r = await syncProject(session);
          if (r.ok && r.changed && mine(session)) showTab(session);
        },
        goFiles: () => switchTab(session, "files"),
        goFeed: () => switchTab(session, "feed"),
        goTab: (k) => switchTab(session, k),
        // 탭이 화면을 떠날 때(탭 전환·목록으로·화면 닫힘) 한 번 실행할 마무리를 맡긴다(예: 모아 둔 읽음 전송). 이미 떠났으면 바로 실행
        onLeave: (fn) => {
          if (typeof fn !== "function") return;
          if (mine(session)) session.leaveHooks.push(fn);
          else callSafe(fn);
        },
        // 파일 탭의 '글로 이동': 피드로 옮기며 ctx.postId 로 그 글을 찾아 달라고 알린다(switchTab 은 postId 를 지우므로 쓰지 않음)
        goPost: (postId) => {
          if (!mine(session) || !postId) return;
          session.postId = String(postId);
          session.ctx.postId = session.postId;
          session.tab = "feed";
          drawTabs(session);
          showTab(session);
        },
      };
    }
    const ctx = session.ctx;
    const myRole = row.my_role || null;
    ctx.project = row;
    ctx.myRole = myRole;
    ctx.canWrite = !!myRole && row.status === "active";
    ctx.canAdmin = myRole === "admin" || isTop;
    ctx.lastRead = myRole ? session.lastRead : null; // 예전 호환용(NEW 표시는 이제 글별 읽음으로 판단)
    ctx.muted = myRole ? !!session.muted : false;
    return ctx;
  }

  // 프로젝트 행·권한을 새로 받아 머리줄만 다시 그린다(탭 안은 건드리지 않음). 권한이 바뀌었으면 changed
  async function syncProject(session) {
    try {
      const row = await fetchProject(session.pid);
      if (!mine(session)) return { ok: false, changed: false };
      const old = session.ctx;
      const before = old ? `${old.myRole}|${old.project.status}|${old.canAdmin}` : "";
      const ctx = buildCtx(session, row);
      drawHead(session);
      return { ok: true, changed: before !== `${ctx.myRole}|${ctx.project.status}|${ctx.canAdmin}` };
    } catch (e) {
      if (!mine(session)) return { ok: false, changed: false };
      toast(msgOf(e), 4000);
      if (e && e.gone) backToList();
      return { ok: false, changed: false };
    }
  }

  async function refreshAll(session) {
    if (!mine(session)) return;
    const r = await syncProject(session);
    if (r.ok && mine(session)) showTab(session);
  }

  function drawProject(session) {
    session.head = h("div", { class: "pj-head" });
    session.tabsBox = h("div", { class: "pj-tabs", role: "tablist", "aria-label": "프로젝트 메뉴" });
    session.body = h("div", { class: "pj-body" });
    root.replaceChildren(h("div", { class: "page pj-page" }, session.head, session.tabsBox, session.body));
    drawHead(session);
    drawTabs(session);
    showTab(session);
  }

  function drawHead(session) {
    const ctx = session.ctx;
    const p = ctx.project;
    const descr = h("p", { class: "pj-descr", title: "눌러서 펼치기" }, p.descr);
    descr.addEventListener("click", () => descr.classList.toggle("open"));
    const banners = [];
    if (!ctx.myRole) {
      banners.push(h("div", { class: "pj-banner" },
        h("span", null, "이 프로젝트에는 참여하지 않았어요. 보기만 할 수 있어요."),
        h("button", { type: "button", class: "pj-mini", onclick: (ev) => joinHere(session, ev.currentTarget) }, "참여하기")));
    }
    if (p.status === "archived") {
      banners.push(h("div", { class: "pj-banner" }, h("span", null, "보관된 프로젝트예요. 읽기만 할 수 있고 새 글·댓글·파일은 올릴 수 없어요.")));
    }
    // 참여자만, 알림이 가는 진행 중 프로젝트에서만
    const bell = ctx.myRole && p.status === "active"
      ? h("div", { class: "pj-bell-row" },
        h("button", {
          type: "button", class: "pj-mini" + (session.muted ? " off" : ""), disabled: !!session.muteBusy,
          onclick: (ev) => toggleMute(session, ev.currentTarget),
        }, session.muted ? "🔕 이 프로젝트 알림 켜기" : "🔔 이 프로젝트 알림 끄기"))
      : null;
    put(session.head,
      h("div", { class: "pj-head-row" },
        h("button", { type: "button", class: "pj-mini", onclick: () => backToList() }, "← 목록"),
        h("span", { class: "grow" }),
        h("button", { type: "button", class: "pj-mini", onclick: () => refreshAll(session) }, "↻ 새로고침"),
        ctx.canAdmin ? h("button", { type: "button", class: "pj-mini", onclick: () => openSettings(session) }, "⚙ 설정") : null),
      h("div", { class: "pj-title" },
        h("span", { class: "pj-dot", style: `background:${safeColor(p.color)}` }),
        h("h1", null, p.name)),
      p.descr ? descr : null,
      h("div", { class: "muted pj-meta" }, `👥 참여 ${Number(p.members) || 0}명`),
      bell,
      banners);
  }

  // 이 프로젝트 새 글 알림 끄기/켜기(참여자 본인 설정)
  async function toggleMute(session, btn) {
    if (!mine(session) || session.muteBusy) return;
    session.muteBusy = true;
    btn.disabled = true;
    const to = !session.muted;
    try {
      await pj.setMuted(session.pid, to);
      session.muted = to;
      if (session.ctx) session.ctx.muted = to;
      toast(to ? "이 프로젝트 알림을 껐어요" : "이 프로젝트 알림을 켰어요", 1800);
    } catch (e) {
      toast(msgOf(e), 5000);
    }
    session.muteBusy = false;
    if (mine(session)) drawHead(session);
  }

  function drawTabs(session) {
    put(session.tabsBox, TABS.map(([k, label]) =>
      h("button", {
        type: "button", role: "tab", "aria-selected": session.tab === k ? "true" : "false",
        class: "pj-tab" + (session.tab === k ? " on" : ""), onclick: () => switchTab(session, k),
      }, label)));
  }

  function switchTab(session, k) {
    if (!mine(session) || session.tab === k || !TABS.some((t) => t[0] === k)) return;
    session.tab = k;
    session.postId = null; // 알림에서 열린 글 이동은 처음 피드 그림에만
    if (session.ctx) session.ctx.postId = null;
    drawTabs(session);
    showTab(session);
  }

  // 탭 안을 새로 그린다. 탭마다 새 칸을 만들어, 떠난 탭의 늦게 끝난 그리기가 지금 화면을 덮어쓰지 못하게 한다
  async function showTab(session) {
    if (!mine(session)) return;
    runLeave(session); // 떠나는 탭이 맡긴 마무리(읽음 전송 등)를 칸을 바꾸기 전에 실행
    const tab = session.tab;
    const pane = h("div", { class: "pj-pane" }, h("p", { class: "muted" }, "불러오는 중…"));
    session.pane = pane;
    put(session.body, pane);
    const live = () => cur === session && session.pane === pane && alive();
    try {
      if (tab === "members") {
        pane.replaceChildren();
        await renderMembers({ pane, ctx: session.ctx, live, onLeft: () => backToList() });
        return;
      }
      const mod = tab === "files" ? await import("./project-files.js") : await import("./project-feed.js");
      if (!live()) return;
      pane.replaceChildren();
      // 탭이 정리 함수를 돌려주면 떠날 때 실행한다(ctx.onLeave 로 이미 맡겼다면 필요 없음)
      const off = tab === "files" ? await mod.renderFiles(pane, session.ctx) : await mod.renderFeed(pane, session.ctx);
      if (typeof off === "function") {
        if (live()) session.leaveHooks.push(off);
        else callSafe(off);
      }
    } catch (e) {
      if (!live()) return;
      console.error("[projects] 탭을 그리지 못했어요:", tab, e);
      put(pane,
        h("p", { class: "err" }, "이 화면을 불러오지 못했어요. 앱을 새로고침한 뒤 다시 시도해 주세요."),
        h("p", { class: "muted" }, String((e && e.message) || e).slice(0, 160)),
        h("button", { type: "button", class: "btn ghost slim", onclick: () => showTab(session) }, "다시 시도"));
    }
  }

  async function joinHere(session, btn) {
    btn.disabled = true;
    try {
      await pj.join(session.pid);
      const mem = await pj.myMembership(session.pid);
      if (!mine(session)) return;
      // 방금 참여했으니 옛 글은 모두 읽은 것으로 본다(서버가 정한 시각을 기준으로)
      session.lastRead = (mem && mem.last_read_at) || new Date().toISOString();
      session.muted = !!(mem && mem.muted);
      toast("참여했어요", 1800);
      await refreshAll(session);
    } catch (e) {
      toast(msgOf(e), 5000);
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function openSettings(session) {
    if (!mine(session)) return;
    const res = await projectForm({ pj, prof, isTop, project: session.ctx.project });
    if (!mine(session)) return;
    if (res.deleted) {
      rows = rows.filter((r) => r.id !== session.pid);
      backToList();
      return;
    }
    if (res.changed) await refreshAll(session);
  }

  /* ----- 시작 ----- */
  if (opts.openId) openProject(String(opts.openId), { postId: opts.postId ? String(opts.postId) : null });
  else showList();
}
