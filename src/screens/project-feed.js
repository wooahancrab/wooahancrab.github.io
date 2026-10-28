// 프로젝트 피드 탭: 글쓰기·검색·태그·고정 글·사진 격자·댓글 (supabase/projects.sql, src/lib/pj-api.js, src/lib/img.js)
// 글·이름·파일 이름은 모두 글자로만 화면에 넣는다(innerHTML 안 씀). 피드 영역만 다시 그려서 열어 둔 댓글칸이 남는다.
import { h, toast, modal, confirmDialog, copyText } from "../lib/ui.js";
import { dateOf, fmtHM, labelMD, todayKST } from "../lib/kst.js";
import { ALLOWED_EXT, checkFile, isImage, openLightbox } from "../lib/img.js";

const PAGE = 20;
const MAX_PHOTOS = 10;
const MAX_DOCS = 5;
const IMG_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);
const DOC_ACCEPT = [...ALLOWED_EXT].filter((e) => !IMG_EXTS.has(e)).map((e) => "." + e).join(",");
// 본문 속 http(s) 주소: 영문·숫자·주소 기호만 (한글 조사가 주소에 붙지 않게)
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:\/?#[\]@!$&'()*+,;=%]+/gi;

/* ---------------- 작은 도우미 ---------------- */

// 시각 → 밀리초. 서버가 주는 마이크로초(소수 6자리)는 브라우저마다 읽는 방식이 달라 3자리로 줄여서 읽는다
const ts = (s) => { const t = Date.parse(String(s ?? "").replace(/(\.\d{3})\d+/, "$1")); return Number.isNaN(t) ? 0 : t; };
const clip = (s, n) => { const a = [...String(s ?? "")]; return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round((n || 0) / 1024)) + "KB");
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
const iconOf = (f) => {
  const n = String(f.file_name || "").toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "📊";
  if (/\.(docx?|hwp|hwpx)$/.test(n)) return "📄";
  if (/\.pdf$/.test(n)) return "📕";
  if (/\.pptx?$/.test(n)) return "📙";
  if (/\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return "🖼";
  if (/\.zip$/.test(n)) return "🗜";
  return "📎";
};

// 한국시간 표시: 올해가 아니면 연도(두 자리)를 앞에 붙인다
function fmtWhen(iso) {
  try {
    const d = dateOf(iso);
    const yy = d.slice(0, 4) === todayKST().slice(0, 4) ? "" : d.slice(2, 4) + "년 ";
    return `${yy}${labelMD(d)} ${fmtHM(iso)}`;
  } catch { return ""; }
}

// 글자 속 http(s) 주소를 <a> 로 바꾼 노드 배열 (innerHTML 없이 DOM 으로만)
function linkify(text) {
  const s = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]'*]+$/, "");
    if (url.length < 9) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    last = m.index + url.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// 링크·NAS 경로: http 로 시작하면 링크, 아니면 경로 + 복사 버튼 (work.js locs() 와 같은 규칙)
function locs(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  return h("div", { class: "pj-fd-locs" }, lines.map((s) => {
    if (/^https?:\/\//i.test(s)) return h("div", { class: "pj-fd-loc" }, h("a", { href: s, target: "_blank", rel: "noopener noreferrer" }, "🔗 " + s));
    const copy = async () => { toast((await copyText(s)) ? "경로를 복사했어요. 탐색기 주소창에 붙여넣으세요" : "복사하지 못했어요", 3000); };
    return h("div", { class: "pj-fd-loc" }, "📁 " + s + " ", h("button", { type: "button", class: "linkbtn", onclick: copy }, "복사"));
  }));
}

// 회의록 양식: 일시·참석자·안건·결정사항·할 일
function minutesParts() {
  const d = todayKST();
  const dw = labelMD(d).replace(/^[^(]*/, ""); // "(월)"
  const ymd = d.replace(/-/g, ".");
  const when = `${ymd}${dw} ${fmtHM(new Date().toISOString())}`;
  const body = ["■ 일시: " + when, "■ 참석자: ", "", "■ 안건", "1. ", "", "■ 결정사항", "- ", "", "■ 할 일 (담당자 / 기한)", "- "].join("\n");
  return { ymd, body };
}

// 임시저장(localStorage): 못 쓰는 환경에서도 글쓰기는 그대로 된다
function readDraft(key) {
  try {
    const d = JSON.parse(localStorage.getItem(key) || "null");
    if (d && typeof d === "object" && (String(d.title || "").trim() || String(d.body || "").trim() || String(d.links || "").trim())) return d;
  } catch { /* 저장소를 못 쓰면 임시저장만 빠진다 */ }
  return null;
}
function writeDraft(key, d) {
  try {
    if (!d.title.trim() && !d.body.trim() && !d.links.trim()) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(d));
  } catch { /* ignore */ }
}
function dropDraft(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// 기다려 달라는 창 (저장·삭제 중에 다른 곳을 못 누르게 막는다)
function progressDlg(title, text) {
  const line = h("p", { class: "pj-fd-prog", role: "status", "aria-live": "polite" }, text);
  const sub = h("p", { class: "muted pj-fd-prog-sub" });
  const ov = h("div", { class: "overlay" },
    h("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-busy": "true" },
      h("h2", null, title), line, sub, h("p", { class: "hint" }, "창을 닫지 말고 기다려 주세요")));
  document.body.append(ov);
  return {
    set(t, s = "") { line.textContent = t; sub.textContent = s; },
    close() { ov.remove(); },
  };
}

// 알림 창 (확인 버튼 하나)
function notice(title, lines) {
  return new Promise((resolve) => {
    const close = () => { ov.remove(); resolve(); };
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, title),
        h("ul", null, lines.map((l) => h("li", null, l))),
        h("button", { class: "btn primary", onclick: close }, "확인")));
    document.body.append(ov);
  });
}

// 줄이 길어 잘렸는지는 화면에 붙은 뒤에야 알 수 있어서, 붙인 다음 바로 한 번, 화면이 그려진 뒤 한 번 더 잰다
function checkClamps(scope) {
  const run = () => {
    for (const el of scope.querySelectorAll(".pj-fd-body")) if (el._chk) el._chk();
  };
  run();
  requestAnimationFrame(run);
}

/* ---------------- 점 세 개 메뉴 (한 번에 하나) ---------------- */

let menu = null;
function closeMenu() {
  if (!menu) return;
  const m = menu;
  menu = null;
  document.removeEventListener("pointerdown", m.down, true);
  document.removeEventListener("keydown", m.key, true);
  window.removeEventListener("scroll", m.close, true);
  window.removeEventListener("resize", m.close, true);
  m.el.remove();
}
function openMenu(btn, items) {
  if (menu && menu.btn === btn) { closeMenu(); return; }
  closeMenu();
  const el = h("div", { class: "pj-fd-menu", role: "menu" }, items.map((it) =>
    h("button", { type: "button", role: "menuitem", class: "pj-fd-mi" + (it.danger ? " danger" : ""), onclick: () => { closeMenu(); it.run(); } }, it.label)));
  document.body.append(el);
  const r = btn.getBoundingClientRect();
  const mh = el.offsetHeight, mw = el.offsetWidth;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  el.style.top = top + "px";
  el.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
  menu = {
    el, btn,
    down: (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closeMenu(); },
    key: (e) => { if (e.key === "Escape") closeMenu(); },
    close: () => closeMenu(),
  };
  document.addEventListener("pointerdown", menu.down, true);
  document.addEventListener("keydown", menu.key, true);
  window.addEventListener("scroll", menu.close, true);
  window.addEventListener("resize", menu.close, true);
}

/* ---------------- 스타일 (이 파일이 쓰는 pj-fd- 클래스만) ---------------- */

const CSS = `
.pj-fd{display:block;scroll-margin-top:64px}
.pj-fd [hidden]{display:none!important}
.pj-fd-bar .btn{margin:6px 0}
.pj-fd-bar .inp{margin:4px 0}
.pj-fd-chips{display:flex;gap:8px;overflow-x:auto;padding:6px 0 8px;scrollbar-width:none}
.pj-fd-chips::-webkit-scrollbar{display:none}
.pj-fd-chip{flex:none;min-height:40px;padding:0 14px;border:2px solid var(--line);background:#fff;border-radius:20px;font-weight:600;font-size:.82rem;cursor:pointer;white-space:nowrap}
.pj-fd-chip.on{background:var(--red);border-color:var(--red);color:#fff}
.pj-fd-chips .linkbtn{flex:none;font-size:.82rem;white-space:nowrap}
.pj-fd-sec{margin:12px 2px 0;font-size:.9rem;font-weight:800;color:var(--red)}
.pj-fd-pinrow{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:8px 12px;margin:8px 0;background:#fff8ee;border:1px solid #f0cf9f;border-radius:14px;text-align:left;cursor:pointer}
.pj-fd-pinmain{flex:1;min-width:0;display:flex;flex-direction:column}
.pj-fd-pintitle{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pj-fd-pinmeta{font-size:.75rem;color:var(--muted)}
.pj-fd-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px 14px;margin:10px 0;display:flex;flex-direction:column;gap:8px;min-width:0}
.pj-fd-card.new{border-left:5px solid var(--red)}
.pj-fd-card.pinned{background:#fffdf8;border-color:#f0cf9f}
.pj-fd-card.hl{box-shadow:0 0 0 3px #f0cf9f}
.pj-fd-head{display:flex;align-items:center;gap:6px;min-width:0}
.pj-fd-who{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}
.pj-fd-name{font-weight:800;font-size:.95rem;overflow-wrap:anywhere}
.pj-fd-time{font-size:.78rem;color:var(--muted)}
.pj-fd-new{flex:none;font-size:.68rem;font-weight:800;color:#fff;background:var(--red);border-radius:10px;padding:2px 7px}
.pj-fd-menubtn{flex:none;width:44px;height:44px;border:0;background:none;font-size:1.4rem;line-height:1;border-radius:10px;cursor:pointer}
.pj-fd-menubtn:active{background:#f3e9e2}
.pj-fd-title{margin:0;font-size:1.05rem;word-break:break-word;overflow-wrap:anywhere}
.pj-fd-body{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-size:.95rem}
.pj-fd-body.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.pj-fd-body a,.pj-fd-loc a,.pj-fd-c-body a{color:#2a5db0;text-decoration:underline;word-break:break-all}
.pj-fd-morebtn{align-self:flex-start;color:var(--muted);font-size:.85rem}
.pj-fd-tags{display:flex;flex-wrap:wrap;gap:6px}
.pj-fd-tag{border:0;background:#f3e9e2;border-radius:12px;padding:3px 10px;font-size:.8rem;font-weight:600;cursor:pointer}
.pj-fd-locs{display:flex;flex-direction:column;gap:4px;font-size:.85rem}
.pj-fd-loc{word-break:break-all;overflow-wrap:anywhere}
.pj-fd-ph{display:grid;grid-template-columns:1fr 1fr;gap:3px;border-radius:12px;overflow:hidden}
.pj-fd-ph.n1{grid-template-columns:1fr}
.pj-fd-pt{position:relative;display:block;width:100%;padding:0;border:0;background:#f3e9e2;cursor:pointer;overflow:hidden;aspect-ratio:1/1}
.pj-fd-ph.n1 .pj-fd-pt{aspect-ratio:4/3;max-height:420px}
.pj-fd-ph.n3 .pj-fd-pt:first-child{grid-column:1/-1;aspect-ratio:2/1}
.pj-fd-pt img{display:block;width:100%;height:100%;object-fit:cover;color:transparent}
.pj-fd-pt.broken img{display:none}
.pj-fd-pt.broken::after{content:"🖼";position:absolute;inset:0;display:grid;place-items:center;font-size:1.6rem;opacity:.45}
.pj-fd-plus{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.5);color:#fff;font-size:1.5rem;font-weight:800}
.pj-fd-files{display:flex;flex-direction:column;gap:6px}
.pj-fd-file{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:6px 10px;border:1px solid var(--line);background:#faf5f0;border-radius:10px;text-align:left;cursor:pointer}
.pj-fd-file .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.88rem}
.pj-fd-file .sz{flex:none;color:var(--muted);font-size:.75rem}
.pj-fd-foot{display:flex;align-items:center}
.pj-fd-cmbtn{min-height:40px;padding:0 12px;border:1px solid var(--line);background:#fff;border-radius:20px;font-size:.85rem;font-weight:600;cursor:pointer}
.pj-fd-cmbtn[aria-expanded=true]{background:#fff1e0;border-color:var(--warn)}
.pj-fd-cm{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:8px}
.pj-fd-cm-list{display:flex;flex-direction:column;gap:8px}
.pj-fd-cm-list p{margin:0}
.pj-fd-c{background:#faf5f0;border-radius:10px;padding:8px 10px}
.pj-fd-c-head{display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px;font-size:.85rem}
.pj-fd-c-head .linkbtn{margin-left:auto;font-size:.8rem}
.pj-fd-c-body{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-size:.92rem;margin-top:2px}
.pj-fd-cm-form{display:flex;gap:8px;align-items:flex-end}
.pj-fd-cm-form .inp{margin:0;flex:1;min-width:0;min-height:48px}
.pj-fd-send{flex:none;min-height:48px;padding:0 16px;border:0;border-radius:12px;background:var(--red);color:#fff;font-weight:700;cursor:pointer}
.pj-fd-send:disabled{opacity:.6}
.pj-fd-menu{position:fixed;z-index:22;min-width:150px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.2);padding:4px;display:flex;flex-direction:column}
.pj-fd-mi{min-height:46px;padding:0 14px;border:0;background:none;text-align:left;border-radius:8px;font-size:.95rem;cursor:pointer;white-space:nowrap}
.pj-fd-mi:active{background:#f3e9e2}
.pj-fd-mi.danger{color:var(--bad)}
.pj-fd-lbl{font-size:.82rem;color:var(--muted);margin-top:4px;display:block}
.pj-fd-lbl[hidden]{display:none}
.pj-fd-lblrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pj-fd-mini{flex:none;min-height:38px;padding:0 12px;border:2px solid var(--line);background:#fff;border-radius:10px;font-weight:600;font-size:.85rem;cursor:pointer}
.pj-fd-picks{display:flex;flex-direction:column;gap:4px}
.pj-fd-pick{display:flex;align-items:center;gap:6px;padding:2px 4px 2px 10px;background:#faf5f0;border:1px solid var(--line);border-radius:10px;font-size:.85rem;min-height:40px}
.pj-fd-pick .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pj-fd-pick .sz{flex:none;color:var(--muted);font-size:.75rem}
.pj-fd-pick .x{width:36px;height:36px;font-size:1rem}
.pj-fd-pick.gone .nm{text-decoration:line-through;opacity:.5}
.pj-fd-chk{display:flex;gap:8px;align-items:center;min-height:44px;font-weight:600}
.pj-fd-chk input{width:22px;height:22px}
.pj-fd-prog{font-weight:700;margin:6px 0}
.pj-fd-prog-sub{margin:0 0 8px;word-break:break-all}
`;

function injectStyle() {
  if (document.getElementById("pj-feed-style")) return;
  const st = document.createElement("style");
  st.id = "pj-feed-style";
  st.textContent = CSS;
  document.head.append(st);
}

/* ---------------- 피드 ---------------- */

// root: 피드가 들어갈 칸, ctx: projects.js 가 넘겨 주는 { pj, project, profile, myRole, isTop, canWrite, canAdmin, lastRead, reloadProject, goFiles? }
export async function renderFeed(root, ctx) {
  injectStyle();
  const { pj, project } = ctx;
  const pid = project.id;
  const meId = (ctx.profile && ctx.profile.user_id) || "";
  const lastRead = ctx.lastRead ? ts(ctx.lastRead) : 0;

  // 화면에 보이는 값: 검색·필터, 불러온 글(rows)과 고정 글(pinned), 다음 쪽 기준(cursor)
  const st = { q: "", tag: "", mine: false, rows: [], pinned: [], tags: [], hasMore: false, cursor: null, loading: true, reloading: false, err: "", moreBusy: false, seq: 0 };
  const recs = new Map(); // 글 id -> { post, el, where, expanded, bodyOpen, cm } : 다시 그려도 열어 둔 댓글칸·펼침 상태가 남는다
  let focusId = ctx.postId || null; ctx.postId = null;
  let searchTimer = 0;

  const searchIn = h("input", { class: "inp", type: "search", placeholder: "검색 (제목·내용)", "aria-label": "글 검색", enterkeyhint: "search", autocomplete: "off" });
  const chipsBox = h("div", { class: "pj-fd-chips" });
  const pinBox = h("div", { class: "pj-fd-pins", hidden: true });
  const listBox = h("div", { class: "pj-fd-list" });
  const moreBox = h("div", { class: "pj-fd-moreBox" });
  const composeBtn = ctx.canWrite ? h("button", { type: "button", class: "btn primary", onclick: () => compose() }, "✏️ 글쓰기") : null;
  const wrap = h("div", { class: "pj-fd" }, h("div", { class: "pj-fd-bar" }, joinHint(), composeBtn, searchIn), chipsBox, pinBox, listBox, moreBox);
  // 이 피드가 아직 화면에 있나. 탭을 바꾸면 projects.js 가 칸(root)째 문서에서 떼어 내므로 wrap 이 root 안에 남아 있어도 isConnected 는 false 가 된다.
  // 같은 칸에 새로 그렸거나, 화면에 붙었다가 떨어졌으면 끝난 것(늦게 온 응답·타이머는 버린다). 아직 한 번도 안 붙은 칸은 그대로 그린다
  const token = {};
  root.__pjFeed = token;
  let seen = false;
  const alive = () => {
    if (root.__pjFeed !== token) return false;
    if (wrap.isConnected) seen = true;
    else if (seen) return false;
    return true;
  };

  searchIn.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 400); });
  searchIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); applySearch(); } });

  /* ----- 맨 위 안내 ----- */
  function joinHint() {
    if (ctx.canWrite) return null;
    if (project.status === "archived") return h("div", { class: "banner" }, "보관된 프로젝트예요. 글과 댓글은 읽기만 할 수 있어요");
    if (!ctx.myRole && ctx.isTop) {
      return h("div", { class: "banner" }, h("span", null, "이 프로젝트에 참여하면 글과 댓글을 쓸 수 있어요"),
        h("button", { type: "button", class: "linkbtn", onclick: joinNow }, "참여하기"));
    }
    return null;
  }
  async function joinNow() {
    try {
      await pj.join(pid);
      toast("참여했어요", 1800);
      if (ctx.reloadProject) await ctx.reloadProject();
    } catch (e) { toast(e.message, 5000); }
  }

  /* ----- 검색·필터·칩 ----- */
  function filtered() {
    return !!(st.q || st.tag || st.mine);
  }

  function applySearch() {
    if (!alive()) return;
    const v = searchIn.value.trim();
    if (v === st.q) return;
    st.q = v;
    renderChips();
    load({ tags: false });
  }
  function setFilter(patch) {
    Object.assign(st, patch);
    renderChips();
    if (wrap.getBoundingClientRect().top < 0) wrap.scrollIntoView({ block: "start" });
    load({ tags: false });
  }
  function resetFilters() {
    st.q = ""; st.tag = ""; st.mine = false;
    searchIn.value = "";
    clearTimeout(searchTimer);
    renderChips();
  }
  function chip(label, on, fn) {
    return h("button", { type: "button", class: "pj-fd-chip" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", onclick: fn }, label);
  }
  function renderChips() {
    const top = st.tags.slice(0, 10);
    const kids = [chip("내 글만", st.mine, () => setFilter({ mine: !st.mine }))];
    for (const t of top) kids.push(chip("#" + t.tag, st.tag === t.tag, () => setFilter({ tag: st.tag === t.tag ? "" : t.tag })));
    if (st.tag && !top.some((t) => t.tag === st.tag)) kids.push(chip("#" + st.tag, true, () => setFilter({ tag: "" })));
    if (filtered()) kids.push(chip("✕ 해제", false, () => { resetFilters(); load({ tags: false }); }));
    if (typeof ctx.goFiles === "function") kids.push(h("button", { type: "button", class: "linkbtn", onclick: () => ctx.goFiles() }, "📁 파일 모아보기"));
    chipsBox.replaceChildren(...kids);
  }
  async function refreshTags() {
    if (!alive()) return;
    try {
      const tg = await pj.tags(pid);
      if (alive()) { st.tags = tg; renderChips(); }
    } catch { /* 태그 칩은 없어도 글은 보인다 */ }
  }

  /* ----- 불러오기 ----- */
  // opts.quiet: 화면을 비우지 않고 새 내용으로 바꾼다(저장 뒤). 이미 불러온 만큼(최대 100개) 다시 받아서 아래로 내려 본 자리가 줄지 않게 한다.
  // opts.tags === false: 태그 목록은 다시 안 받는다
  async function load(opts = {}) {
    if (!alive()) return;
    const quiet = !!opts.quiet;
    const my = ++st.seq;
    const y = window.scrollY;
    const want = quiet ? Math.max(PAGE, st.rows.length) : PAGE;
    st.err = "";
    st.reloading = true; // 다시 받는 동안은 '이전 글 더 보기'를 막는다(옛 cursor 로 받으면 중간이 비어 보인다)
    if (!quiet) {
      st.rows = []; st.pinned = []; st.hasMore = false; st.cursor = null; st.loading = true;
      drawList();
    } else {
      drawMore();
    }
    try {
      const f = filtered();
      const [pg, pins, tg] = await Promise.all([
        pj.posts(pid, { q: st.q, tag: st.tag, mine: st.mine, limit: want }),
        f ? Promise.resolve([]) : pj.pinnedPosts(pid),
        opts.tags === false ? Promise.resolve(null) : pj.tags(pid).catch(() => null),
      ]);
      if (my !== st.seq || !alive()) return;
      st.rows = pg.rows;
      st.hasMore = pg.hasMore;
      st.cursor = pg.rows.length ? pg.rows[pg.rows.length - 1].created_at : null;
      st.pinned = pins;
      if (tg) st.tags = tg;
    } catch (e) {
      if (my !== st.seq || !alive()) return;
      if (quiet && st.rows.length) toast(e.message, 4000);
      else st.err = e.message;
    }
    st.loading = false;
    st.reloading = false;
    renderChips();
    drawList();
    if (quiet && alive()) window.scrollTo(0, y);
    if (focusId) { const id = focusId; focusId = null; focusPost(id); }
  }

  async function more() {
    if (!alive() || st.moreBusy || st.reloading || !st.hasMore || !st.cursor) return;
    st.moreBusy = true;
    drawMore();
    const my = st.seq;
    try {
      const pg = await pj.posts(pid, { before: st.cursor, q: st.q, tag: st.tag, mine: st.mine, limit: PAGE });
      if (my === st.seq && alive()) {
        const have = new Set(st.rows.map((r) => r.id));
        const add = pg.rows.filter((r) => !have.has(r.id));
        st.rows = st.rows.concat(add);
        st.hasMore = pg.hasMore;
        if (pg.rows.length) st.cursor = pg.rows[pg.rows.length - 1].created_at;
        const pinIds = new Set((filtered() ? [] : st.pinned).map((p) => p.id));
        const els = add.filter((r) => !pinIds.has(r.id)).map((r) => cardFor(recOf(r), "list"));
        listBox.append(...els);
        afterInsert(listBox);
      }
    } catch (e) { toast(e.message, 4000); }
    st.moreBusy = false;
    if (alive()) drawMore();
  }

  function focusPost(id) {
    const r = recs.get(id);
    if (!r || !r.el || !r.el.isConnected) return;
    if (r.where === "pin" && !r.expanded) { r.expanded = true; refresh(r); }
    r.el.classList.add("hl");
    r.el.scrollIntoView({ block: "center" });
  }

  /* ----- 그리기 ----- */
  function recOf(post) {
    let r = recs.get(post.id);
    if (!r) { r = { post, el: null, where: "list", expanded: false, bodyOpen: false, cm: null, cmBtn: null, cmHost: null }; recs.set(post.id, r); }
    else r.post = post;
    return r;
  }
  function cardFor(rec, where) {
    rec.where = where;
    rec.el = where === "pin" && !rec.expanded ? buildPinRow(rec) : buildCard(rec);
    return rec.el;
  }
  function refresh(rec) {
    const old = rec.el;
    const neu = cardFor(rec, rec.where);
    if (old && old.parentNode) old.replaceWith(neu);
    afterInsert(neu);
  }
  function afterInsert(scope) {
    fillThumbs(scope);
    checkClamps(scope);
  }

  function drawMore() {
    moreBox.replaceChildren();
    if (st.loading || st.err || !st.hasMore) return;
    moreBox.append(h("button", { type: "button", class: "btn ghost slim", disabled: st.moreBusy || st.reloading, onclick: more }, st.moreBusy ? "불러오는 중…" : "이전 글 더 보기"));
  }

  function drawList() {
    if (!alive()) return;
    closeMenu();
    const pins = filtered() ? [] : st.pinned;
    const pinIds = new Set(pins.map((p) => p.id));
    if (pins.length) {
      pinBox.hidden = false;
      pinBox.replaceChildren(h("div", { class: "pj-fd-sec" }, "📌 고정된 글"), ...pins.map((p) => cardFor(recOf(p), "pin")));
    } else {
      pinBox.hidden = true;
      pinBox.replaceChildren();
    }
    if (st.loading && !st.rows.length) {
      listBox.replaceChildren(h("p", { class: "muted" }, "불러오는 중…"));
    } else if (st.err) {
      listBox.replaceChildren(h("p", { class: "err" }, "불러오기 실패: " + st.err), h("button", { type: "button", class: "btn ghost slim", onclick: () => load() }, "다시 시도"));
    } else {
      const shown = st.rows.filter((r) => !pinIds.has(r.id));
      if (shown.length) listBox.replaceChildren(...shown.map((p) => cardFor(recOf(p), "list")));
      else if (pins.length) listBox.replaceChildren();
      else listBox.replaceChildren(h("p", { class: "muted" }, filtered() ? "찾는 글이 없어요" : ctx.canWrite ? "아직 글이 없어요. 첫 글을 남겨 보세요." : "아직 글이 없어요"));
    }
    drawMore();
    afterInsert(wrap);
  }

  function isNewPost(p) {
    return !!lastRead && p.author_id !== meId && ts(p.created_at) > lastRead;
  }

  // 접어 둔 고정 글 한 줄
  function buildPinRow(rec) {
    const p = rec.post;
    const first = String(p.title || p.body || "").split("\n")[0].trim();
    return h("button", { type: "button", class: "pj-fd-pinrow", "aria-expanded": "false", onclick: () => { rec.expanded = true; refresh(rec); } },
      h("span", null, "📌"),
      h("span", { class: "pj-fd-pinmain" },
        h("span", { class: "pj-fd-pintitle" }, clip(first, 60) || "(내용 없음)"),
        h("span", { class: "pj-fd-pinmeta" }, `${p.author_name || ""} · ${fmtWhen(p.created_at)}`)),
      isNewPost(p) && h("span", { class: "pj-fd-new" }, "NEW"),
      h("span", { class: "muted" }, "▾"));
  }

  function cmLabel(p) {
    return Number(p.comment_count) > 0 ? `💬 댓글 ${p.comment_count}` : "💬 댓글";
  }
  function updateCmBtn(rec) {
    if (rec.cmBtn) rec.cmBtn.textContent = cmLabel(rec.post);
  }

  // 글 카드
  function buildCard(rec) {
    const p = rec.post;
    const isNew = isNewPost(p);
    const files = Array.isArray(p.files) ? p.files : [];
    const imgs = files.filter((f) => f.kind === "image");
    const docs = files.filter((f) => f.kind !== "image");
    const edited = ts(p.updated_at) - ts(p.created_at) > 1000;

    const menuBtn = h("button", { type: "button", class: "pj-fd-menubtn", "aria-label": "글 메뉴", "aria-haspopup": "menu", onclick: () => openMenu(menuBtn, menuItems(rec)) }, "⋯");
    const who = h("div", { class: "pj-fd-who" },
      h("span", { class: "pj-fd-name" }, p.author_name || "이름 없음"),
      h("span", { class: "pj-fd-time" }, fmtWhen(p.created_at) + (edited ? " (수정됨)" : "")));
    const head = h("div", { class: "pj-fd-head" },
      p.pinned && h("span", { title: "고정된 글" }, "📌"),
      who,
      isNew && h("span", { class: "pj-fd-new" }, "NEW"),
      rec.where === "pin" && h("button", { type: "button", class: "linkbtn", onclick: () => { rec.expanded = false; refresh(rec); } }, "접기"),
      menuBtn);

    const kids = [head];
    if (p.title) kids.push(h("h3", { class: "pj-fd-title" }, p.title));
    if (p.body) {
      const bodyEl = h("div", { class: "pj-fd-body" + (rec.bodyOpen ? "" : " clamp") }, linkify(p.body));
      const moreBtn = h("button", { type: "button", class: "linkbtn pj-fd-morebtn", hidden: true }, rec.bodyOpen ? "접기" : "더 보기");
      moreBtn.onclick = () => {
        rec.bodyOpen = !rec.bodyOpen;
        bodyEl.classList.toggle("clamp", !rec.bodyOpen);
        moreBtn.textContent = rec.bodyOpen ? "접기" : "더 보기";
      };
      bodyEl._chk = () => {
        if (rec.bodyOpen) { moreBtn.hidden = false; return; }
        const over = bodyEl.clientHeight > 0 ? bodyEl.scrollHeight > bodyEl.clientHeight + 2 : (p.body.length > 240 || p.body.split("\n").length > 6);
        moreBtn.hidden = !over;
      };
      kids.push(bodyEl, moreBtn);
    }
    if (p.tags && p.tags.length) {
      kids.push(h("div", { class: "pj-fd-tags" }, p.tags.map((t) => h("button", { type: "button", class: "pj-fd-tag", onclick: () => setFilter({ tag: t }) }, "#" + t))));
    }
    const lc = locs(p.links);
    if (lc) kids.push(lc);
    if (imgs.length) kids.push(photoGrid(imgs));
    if (docs.length) kids.push(h("div", { class: "pj-fd-files" }, docs.map((f) => fileChip(f))));

    const cmBtn = h("button", { type: "button", class: "pj-fd-cmbtn", "aria-expanded": rec.cm && rec.cm.open ? "true" : "false", onclick: () => toggleComments(rec) }, cmLabel(p));
    const cmHost = h("div", { class: "pj-fd-cmhost" });
    rec.cmBtn = cmBtn;
    rec.cmHost = cmHost;
    if (rec.cm && rec.cm.open) cmHost.append(rec.cm.el);
    kids.push(h("div", { class: "pj-fd-foot" }, cmBtn), cmHost);

    return h("article", { class: "pj-fd-card" + (isNew ? " new" : "") + (rec.where === "pin" ? " pinned" : ""), "data-post": p.id }, kids);
  }

  /* ----- 사진·파일 ----- */
  // 1장 크게 / 2장 나란히 / 3장 이상 2열(네 칸까지, 넘으면 +N)
  function photoGrid(imgs) {
    const n = imgs.length;
    const shown = imgs.slice(0, n === 1 ? 1 : 4);
    const cls = "pj-fd-ph " + (n === 1 ? "n1" : n === 2 ? "n2" : n === 3 ? "n3" : "n4");
    return h("div", { class: cls }, shown.map((f, i) => {
      const img = h("img", { alt: f.file_name || "사진", "data-path": f.thumb_path || f.path, decoding: "async", draggable: "false" });
      const btn = h("button", { type: "button", class: "pj-fd-pt", "aria-label": `사진 ${i + 1} 크게 보기`, onclick: () => viewPhotos(imgs, i) },
        img, i === 3 && n > 4 && h("span", { class: "pj-fd-plus" }, "+" + (n - 4)));
      if (n === 1 && f.width > 0 && f.height > 0) btn.style.aspectRatio = String(Math.min(1.8, Math.max(0.8, f.width / f.height)));
      return btn;
    }));
  }

  function viewPhotos(imgs, i) {
    openLightbox(imgs, i, async (row, fresh) => {
      const m = await pj.urls([row.path], !!fresh);
      const u = m.get(row.path);
      if (!u) throw new Error("사진 주소를 받지 못했어요");
      return u;
    });
  }

  function fileChip(f) {
    return h("button", { type: "button", class: "pj-fd-file", onclick: () => openDoc(f) },
      h("span", null, iconOf(f)), h("span", { class: "nm" }, f.file_name || "파일"), h("span", { class: "sz" }, kb(f.size)));
  }

  // 팝업 차단을 피하려고 창을 먼저 열고 주소를 받아 옮긴다 (library.js 와 같은 방식)
  async function openDoc(f) {
    const w = window.open("", "_blank");
    try {
      const m = await pj.urls([f.path]);
      const u = m.get(f.path);
      if (!u) throw new Error("파일 주소를 받지 못했어요");
      if (w) w.location = u; else location.href = u;
    } catch (e) {
      try { if (w) w.close(); } catch { /* ignore */ }
      toast(e.message || "파일을 열지 못했어요", 5000);
    }
  }

  // 작은 판 사진 주소를 한 번에 받아 채운다. 안 열리면 새 주소로 한 번만 다시
  async function fillThumbs(scope) {
    if (!alive()) return;
    const imgs = [...scope.querySelectorAll("img[data-path]:not([data-done])")];
    if (!imgs.length) return;
    for (const im of imgs) im.setAttribute("data-done", "1");
    let m;
    try { m = await pj.urls(imgs.map((im) => im.dataset.path)); } catch { imgs.forEach(markBroken); return; }
    for (const im of imgs) {
      const u = m.get(im.dataset.path);
      if (!u) { markBroken(im); continue; }
      im.onerror = () => retryImg(im);
      im.src = u;
    }
  }
  function markBroken(im) {
    im.onerror = null;
    if (im.parentNode) im.parentNode.classList.add("broken");
  }
  async function retryImg(im) {
    if (im.dataset.retry) { markBroken(im); return; }
    im.dataset.retry = "1";
    try {
      const path = im.dataset.path;
      const m = await pj.urls([path], true);
      const u = m.get(path);
      if (u) im.src = u; else markBroken(im);
    } catch { markBroken(im); }
  }

  /* ----- 점 세 개 메뉴 동작 ----- */
  function menuItems(rec) {
    const p = rec.post;
    const mine = !!meId && p.author_id === meId;
    const items = [];
    if (ctx.canAdmin) items.push({ label: p.pinned ? "📌 고정 해제" : "📌 맨 위에 고정", run: () => togglePin(rec) });
    if (mine && ctx.canWrite) items.push({ label: "✏️ 수정", run: () => compose(rec) });
    if (mine || ctx.canAdmin) items.push({ label: "🗑 삭제", danger: true, run: () => removePost(rec) });
    items.push({ label: "🔗 링크 복사", run: () => copyLink(p) });
    return items;
  }

  function postLink(p) {
    try {
      const u = new URL(location.origin + location.pathname);
      u.searchParams.set("p", pid);
      u.searchParams.set("post", p.id);
      return u.toString();
    } catch { return `${location.pathname}?p=${pid}&post=${p.id}`; }
  }
  async function copyLink(p) {
    toast((await copyText(postLink(p))) ? "글 링크를 복사했어요" : "복사하지 못했어요", 2200);
  }

  // 고정·해제: 불러온 글 목록은 그대로 두고 표시만 바꾸고, 고정 글 목록(최대 5개)만 다시 받는다 (아래로 내려 본 자리가 안 줄어든다)
  async function togglePin(rec) {
    const id = rec.post.id;
    const on = !rec.post.pinned;
    try {
      await pj.pin(id, on);
    } catch (e) { toast(e.message, 5000); return; }
    toast(on ? "맨 위에 고정했어요" : "고정을 풀었어요", 1800);
    if (!alive()) return;
    const my = st.seq;
    rec.post.pinned = on;
    for (const r of st.rows) if (r.id === id) r.pinned = on;
    if (!filtered()) {
      // 먼저 손으로 맞춰 두고(받기에 실패해도 화면은 맞게), 서버가 아는 순서로 다시 받아 바꾼다
      if (!on) st.pinned = st.pinned.filter((p) => p.id !== id);
      else if (!st.pinned.some((p) => p.id === id)) st.pinned = [rec.post, ...st.pinned];
      try { st.pinned = await pj.pinnedPosts(pid); } catch (e) { toast(e.message, 4000); }
    }
    if (my !== st.seq || !alive()) return; // 그 사이 목록을 새로 받기 시작했으면 그쪽이 그린다
    const y = window.scrollY;
    drawList();
    window.scrollTo(0, y);
  }

  async function removePost(rec) {
    const p = rec.post;
    const name = clip(String(p.title || p.body || "").split("\n")[0], 40) || "이 글";
    if (!(await confirmDialog("글을 지울까요?", [name, "사진·파일·댓글도 함께 지워지고 되돌릴 수 없어요"], "취소", "지우기"))) return;
    const prog = progressDlg("지우는 중", "글과 첨부를 지우는 중…");
    try {
      await pj.deletePost(p);
    } catch (e) {
      prog.close();
      toast(e.message, 6000);
      return;
    }
    prog.close();
    recs.delete(p.id);
    st.rows = st.rows.filter((r) => r.id !== p.id);
    st.pinned = st.pinned.filter((r) => r.id !== p.id);
    if (!alive()) return;
    const y = window.scrollY;
    drawList();
    window.scrollTo(0, y);
    toast("지웠어요", 1800);
    refreshTags();
  }

  /* ----- 댓글 (그 글 아래에서만 다시 그린다) ----- */
  function cmOf(rec) {
    if (rec.cm) return rec.cm;
    const cm = { open: false, rows: null, loading: false, err: "", token: 0, list: h("div", { class: "pj-fd-cm-list" }), el: null };
    let form = null;
    if (ctx.canWrite) {
      const ta = h("textarea", { class: "inp", rows: "2", maxlength: "2000", placeholder: "댓글을 입력하세요", "aria-label": "댓글" });
      const send = h("button", { type: "button", class: "pj-fd-send" }, "등록");
      send.onclick = () => postComment(rec, ta, send);
      form = h("div", { class: "pj-fd-cm-form" }, ta, send);
    }
    cm.el = h("div", { class: "pj-fd-cm" }, cm.list, form);
    rec.cm = cm;
    return cm;
  }

  function toggleComments(rec) {
    const cm = cmOf(rec);
    cm.open = !cm.open;
    if (rec.cmBtn) rec.cmBtn.setAttribute("aria-expanded", cm.open ? "true" : "false");
    if (rec.cmHost) rec.cmHost.replaceChildren(...(cm.open ? [cm.el] : []));
    if (cm.open) loadComments(rec);
  }

  async function loadComments(rec) {
    const cm = cmOf(rec);
    const my = ++cm.token;
    cm.loading = true;
    cm.err = "";
    renderCmList(rec);
    try {
      const rows = await pj.comments(rec.post.id);
      if (my !== cm.token) return;
      cm.rows = rows;
      rec.post.comment_count = rows.length;
      updateCmBtn(rec);
    } catch (e) {
      if (my !== cm.token) return;
      cm.err = e.message;
    }
    cm.loading = false;
    renderCmList(rec);
  }

  function renderCmList(rec) {
    const cm = rec.cm;
    if (!cm.rows && cm.loading) {
      cm.list.replaceChildren(h("p", { class: "muted" }, "댓글 불러오는 중…"));
    } else if (!cm.rows && cm.err) {
      cm.list.replaceChildren(h("p", { class: "err" }, "불러오기 실패: " + cm.err), h("button", { type: "button", class: "linkbtn", onclick: () => loadComments(rec) }, "다시 시도"));
    } else if (!cm.rows || !cm.rows.length) {
      cm.list.replaceChildren(h("p", { class: "muted" }, "아직 댓글이 없어요"));
    } else {
      cm.list.replaceChildren(...cm.rows.map((c) => commentRow(rec, c)));
    }
  }

  function commentRow(rec, c) {
    const canDel = (!!meId && c.author_id === meId) || ctx.canAdmin;
    return h("div", { class: "pj-fd-c" },
      h("div", { class: "pj-fd-c-head" },
        h("b", null, c.author_name || "이름 없음"),
        h("span", { class: "muted" }, fmtWhen(c.created_at)),
        canDel && h("button", { type: "button", class: "linkbtn", onclick: () => delComment(rec, c) }, "삭제")),
      h("div", { class: "pj-fd-c-body" }, linkify(c.body)));
  }

  async function postComment(rec, ta, send) {
    const body = ta.value.trim();
    if (!body) { toast("댓글 내용을 넣어 주세요"); return; }
    const cm = rec.cm;
    send.disabled = true;
    try {
      const row = await pj.addComment(pid, rec.post.id, body);
      ta.value = "";
      if (cm.rows) { cm.rows.push(row); rec.post.comment_count = cm.rows.length; }
      else rec.post.comment_count = (Number(rec.post.comment_count) || 0) + 1;
      renderCmList(rec);
      updateCmBtn(rec);
    } catch (e) { toast(e.message, 5000); }
    send.disabled = false;
  }

  async function delComment(rec, c) {
    if (!(await confirmDialog("댓글을 지울까요?", [clip(c.body, 40)], "취소", "지우기"))) return;
    try {
      await pj.deleteComment(c.id);
      const cm = rec.cm;
      if (cm.rows) { cm.rows = cm.rows.filter((x) => x.id !== c.id); rec.post.comment_count = cm.rows.length; }
      renderCmList(rec);
      updateCmBtn(rec);
    } catch (e) { toast(e.message, 5000); }
  }

  /* ----- 글쓰기·수정 창 ----- */
  // rec 가 있으면 그 글을 고친다. 글을 먼저 저장하고 → 사진·파일을 한 장씩 올린다(일부 실패해도 글은 남는다)
  async function compose(rec) {
    const post = rec ? rec.post : null;
    const editing = !!post;
    // 임시저장은 계정마다 따로(폰 하나를 여러 명이 쓰므로). 계정을 모르면 임시저장을 끈다
    const draftKey = "pj-draft:" + meId + ":" + pid;
    let draftOn = !editing && !!meId;
    const existing = editing ? (Array.isArray(post.files) ? post.files.slice() : []) : [];
    const removeIds = new Set();   // 수정 중 지우기로 표시한 기존 첨부
    const photos = [];             // 새로 고른 사진
    const docs = [];               // 새로 고른 파일
    const keptImgs = () => existing.filter((f) => f.kind === "image" && !removeIds.has(f.id)).length;
    const keptDocs = () => existing.filter((f) => f.kind !== "image" && !removeIds.has(f.id)).length;

    const lbl = (t) => h("span", { class: "pj-fd-lbl" }, t);
    const titleIn = h("input", { class: "inp", maxlength: "100", placeholder: "제목 (선택)", "aria-label": "제목", autocomplete: "off" });
    const bodyIn = h("textarea", { class: "inp", rows: "8", maxlength: "10000", placeholder: "내용을 적어 주세요. #단어를 쓰면 태그가 돼요", "aria-label": "내용" });
    const linksIn = h("textarea", { class: "inp", rows: "3", maxlength: "2000", placeholder: "링크나 NAS 경로를 한 줄에 하나씩\n예) https://…  또는  \\\\NAS\\영업\\단가표.xlsx", "aria-label": "링크·NAS 경로" });
    const pinCb = h("input", { type: "checkbox" });
    pinCb.checked = editing ? !!post.pinned : false;
    const pinRow = ctx.canAdmin ? h("label", { class: "pj-fd-chk" }, pinCb, "맨 위에 고정하기 (프로젝트당 5개까지)") : null;

    if (editing) {
      titleIn.value = post.title || "";
      bodyIn.value = post.body || "";
      linksIn.value = post.links || "";
    } else if (draftOn) {
      const d = readDraft(draftKey);
      if (d) {
        titleIn.value = String(d.title || "").slice(0, 100);
        bodyIn.value = String(d.body || "").slice(0, 10000);
        linksIn.value = String(d.links || "").slice(0, 2000);
        toast("쓰던 글을 불러왔어요", 2500);
      }
    }

    // 임시저장: 새 글일 때만, 입력이 멈춘 0.5초 뒤에
    let draftTimer = 0;
    const flushDraft = () => {
      clearTimeout(draftTimer);
      if (draftOn) writeDraft(draftKey, { title: titleIn.value, body: bodyIn.value, links: linksIn.value });
    };
    const onEdit = () => { clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 500); };
    for (const el of [titleIn, bodyIn, linksIn]) el.addEventListener("input", onEdit);
    const clearDraft = () => { clearTimeout(draftTimer); draftOn = false; dropDraft(draftKey); };

    function fillTemplate() {
      const t = minutesParts();
      const cur = bodyIn.value.trim();
      bodyIn.value = cur ? cur + "\n\n" + t.body : t.body;
      if (!titleIn.value.trim()) titleIn.value = "회의록 " + t.ymd;
      onEdit();
      bodyIn.focus();
    }
    const tplBtn = h("button", { type: "button", class: "pj-fd-mini", onclick: fillTemplate }, "📝 회의록 양식");

    // 사진·파일 고르기
    const photoIn = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none", tabindex: "-1" });
    const docIn = h("input", { type: "file", accept: DOC_ACCEPT, multiple: true, style: "display:none", tabindex: "-1" });
    const photoBtn = h("button", { type: "button", class: "pj-fd-mini", onclick: () => photoIn.click() }, "＋ 사진 추가");
    const docBtn = h("button", { type: "button", class: "pj-fd-mini", onclick: () => docIn.click() }, "＋ 파일 추가");
    const photoLbl = lbl("");
    const docLbl = lbl("");
    const existLbl = lbl("올려 둔 첨부 (지울 것을 고르세요)");
    const existBox = h("div", { class: "pj-fd-picks" });
    const photoBox = h("div", { class: "pj-fd-picks" });
    const docBox = h("div", { class: "pj-fd-picks" });

    const pickRow = (icon, name, size, rightBtn, gone) =>
      h("div", { class: "pj-fd-pick" + (gone ? " gone" : "") }, h("span", { class: "nm" }, icon + " " + (name || "파일")), size ? h("span", { class: "sz" }, size) : null, rightBtn);

    function toggleExisting(f) {
      if (removeIds.has(f.id)) {
        const full = f.kind === "image" ? photos.length + keptImgs() >= MAX_PHOTOS : docs.length + keptDocs() >= MAX_DOCS;
        if (full) { toast("개수 제한 때문에 되돌릴 수 없어요. 새로 고른 것을 먼저 빼 주세요", 4000); return; }
        removeIds.delete(f.id);
      } else {
        removeIds.add(f.id);
      }
      renderPicks();
    }

    function renderPicks() {
      existLbl.hidden = !existing.length;
      existBox.replaceChildren(...existing.map((f) => {
        const gone = removeIds.has(f.id);
        const b = h("button", { type: "button", class: "linkbtn", onclick: () => toggleExisting(f) }, gone ? "되돌리기" : "지우기");
        return pickRow(f.kind === "image" ? "🖼" : iconOf(f), f.file_name, kb(f.size), b, gone);
      }));
      photoLbl.textContent = `사진 (${photos.length + keptImgs()}/${MAX_PHOTOS}장)`;
      docLbl.textContent = `파일 (${docs.length + keptDocs()}/${MAX_DOCS}개, 20MB까지)`;
      photoBox.replaceChildren(...photos.map((f, i) => pickRow("🖼", f.name, kb(f.size),
        h("button", { type: "button", class: "x", "aria-label": "빼기", onclick: () => { photos.splice(i, 1); renderPicks(); } }, "✕"), false)));
      docBox.replaceChildren(...docs.map((f, i) => pickRow(iconOf({ file_name: f.name }), f.name, kb(f.size),
        h("button", { type: "button", class: "x", "aria-label": "빼기", onclick: () => { docs.splice(i, 1); renderPicks(); } }, "✕"), false)));
    }

    const warn = (errs) => {
      if (errs.length) toast(errs.slice(0, 2).join(" / ") + (errs.length > 2 ? ` 외 ${errs.length - 2}건` : ""), 5000);
    };
    photoIn.addEventListener("change", () => {
      const errs = [];
      for (const f of [...photoIn.files]) {
        if (!isImage(f)) { errs.push(`${clip(f.name, 24)}: 사진이 아니에요`); continue; }
        const bad = checkFile(f);
        if (bad) { errs.push(bad); continue; }
        if (photos.length + keptImgs() >= MAX_PHOTOS) { errs.push(`사진은 글 하나에 ${MAX_PHOTOS}장까지 올릴 수 있어요`); break; }
        if (photos.some((x) => sameFile(x, f))) continue;
        photos.push(f);
      }
      photoIn.value = "";
      renderPicks();
      warn(errs);
    });
    docIn.addEventListener("change", () => {
      const errs = [];
      for (const f of [...docIn.files]) {
        if (isImage(f)) { errs.push(`${clip(f.name, 24)}: 사진은 '사진 추가'로 올려 주세요`); continue; }
        const bad = checkFile(f);
        if (bad) { errs.push(bad); continue; }
        if (docs.length + keptDocs() >= MAX_DOCS) { errs.push(`파일은 글 하나에 ${MAX_DOCS}개까지 올릴 수 있어요`); break; }
        if (docs.some((x) => sameFile(x, f))) continue;
        docs.push(f);
      }
      docIn.value = "";
      renderPicks();
      warn(errs);
    });
    renderPicks();

    const content = h("div", { class: "stack" },
      lbl("제목 (선택)"), titleIn,
      h("div", { class: "pj-fd-lblrow" }, lbl("내용"), tplBtn),
      bodyIn,
      existLbl, existBox,
      h("div", { class: "pj-fd-lblrow" }, photoLbl, photoBtn), photoBox, photoIn,
      h("div", { class: "pj-fd-lblrow" }, docLbl, docBtn), docBox, docIn,
      lbl("링크·NAS 경로 (한 줄에 하나씩)"), linksIn,
      pinRow);

    for (;;) {
      const ok = await modal(editing ? "글 수정" : "글쓰기", content, "저장", "취소");
      if (!ok) { flushDraft(); return; }
      const t = titleIn.value.trim();
      const b = bodyIn.value.trim();
      if (!t && !b) { toast("제목이나 내용을 입력해 주세요"); continue; }

      const upList = [...photos.map((f) => ({ f, photo: true })), ...docs.map((f) => ({ f, photo: false }))];
      const prog = progressDlg("저장 중", "글을 저장하는 중…");
      let saved = null;
      const failed = [];   // 올리거나 지우지 못한 첨부 { name, msg }
      const asFile = [];   // 사진으로 줄일 수 없어 파일로 올라간 것
      let files = existing.slice();
      try {
        try {
          saved = await pj.savePost(pid, { id: editing ? post.id : undefined, title: t, body: b, links: linksIn.value, pinned: ctx.canAdmin ? pinCb.checked : undefined });
        } catch (e) {
          prog.close();
          toast(e.message, 6000);
          continue; // 글이 저장되지 않았으니 쓰던 내용 그대로 창을 다시 연다
        }
        if (!editing) clearDraft();

        // 수정 중 지우기로 표시한 기존 첨부
        for (const f of existing.filter((x) => removeIds.has(x.id))) {
          prog.set("첨부를 지우는 중…", f.file_name || "");
          try {
            await pj.deleteFile(f);
            files = files.filter((x) => x.id !== f.id);
          } catch (e) { failed.push({ name: f.file_name || "파일", msg: "지우지 못했어요: " + e.message }); }
        }

        // 새 사진·파일은 한 장씩 차례로
        let i = 0;
        for (const it of upList) {
          i++;
          prog.set(`(${i}/${upList.length}) 올리는 중…`, it.f.name);
          try {
            const row = await pj.uploadFile(pid, saved.id, it.f);
            files.push(row);
            if (it.photo && row.kind !== "image") asFile.push(it.f.name);
          } catch (e) { failed.push({ name: it.f.name, msg: e.message }); }
        }
      } finally {
        prog.close();
      }

      // 화면 반영
      if (alive()) {
        if (editing) {
          const wasPinned = !!post.pinned;
          Object.assign(post, saved, { files });
          delete post.pin_error;
          if (!!post.pinned !== wasPinned) await load({ quiet: true, tags: false });
          else refresh(rec);
          refreshTags();
        } else {
          resetFilters();
          await load({ quiet: true });
        }
      }

      // 일부 실패는 글은 남기고 알려 준다
      const lines = [];
      if (saved.pin_error) lines.push("상단고정: " + saved.pin_error);
      for (const x of failed) lines.push(`${clip(x.name, 40)} — ${x.msg}`);
      if (asFile.length) lines.push(`사진으로 줄일 수 없는 형식이라 파일로 올렸어요: ${asFile.map((n) => clip(n, 30)).join(", ")}`);
      if (failed.length) lines.push("글은 저장됐어요. ⋯ 메뉴의 수정에서 다시 올릴 수 있어요");
      if (lines.length) await notice(failed.length ? "글은 저장했지만 일부는 안 됐어요" : "저장했어요", lines);
      else toast("저장했어요", 2000);
      return;
    }
  }

  // 시작: 위의 함수와 값이 모두 준비된 다음에 그린다
  root.replaceChildren(wrap);
  alive(); // 붙은 것을 한 번 기록해 둔다(이후 떨어지면 끝난 것으로 본다)
  renderChips();
  await load();
}
