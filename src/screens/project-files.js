// 프로젝트 파일 탭: 사진은 3열 작은 판 격자, 문서는 줄 목록. 글 없이 바로 올리기·열기·삭제.
// 파일 이름·올린 사람 이름은 모두 글자로만 화면에 넣는다(innerHTML 안 씀). ctx 는 project-feed.js 와 같다.
// ctx.goPost(postId) 가 있을 때만 '글로 이동' 단추를 보인다(없으면 단추를 숨김).
import { h, toast, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD, todayKST } from "../lib/kst.js";
import { ALLOWED_EXT, checkFile, ensureImgStyles, openLightbox } from "../lib/img.js";

const PAGE = 30;
const ACCEPT = [...ALLOWED_EXT].map((e) => "." + e).join(",");
const KINDS = [["all", "전체"], ["image", "사진"], ["file", "문서"]];

const CSS = `
.pj-files{padding-bottom:12px}
.pj-files .inp{margin:6px 0}
.pj-f-note{margin:2px 0 8px}
.pj-f-chips{display:flex;gap:8px;overflow-x:auto;padding:6px 0 4px}
.pj-f-chip{flex:none;min-height:42px;padding:0 18px;border:2px solid var(--line,#eadfd6);background:#fff;border-radius:21px;font-weight:700;cursor:pointer;color:inherit}
.pj-f-chip.on{background:var(--red,#c8402a);border-color:var(--red,#c8402a);color:#fff}
.pj-f-prog{display:flex;align-items:center;gap:8px;margin:6px 0;padding:8px 10px;border:1px solid var(--line,#eadfd6);border-radius:12px;background:#fff}
.pj-f-prog-t{flex:1;min-width:0;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-f-fail{margin:6px 0;padding:10px 12px;border:1px solid #f0c4bb;border-radius:12px;background:#fff5f2}
.pj-f-fail b{color:var(--bad,#c8402a)}
.pj-f-fail ul{margin:6px 0;padding-left:1.2em;font-size:.9rem}
.pj-f-fail li{overflow-wrap:anywhere}
.pj-f-sec{margin:12px 0 6px;font-size:.9rem;font-weight:700}
.pj-f-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
.pj-f-cell{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;background:#efe7e0}
.pj-f-ph{position:relative;display:block;width:100%;height:100%;padding:0;border:0;background:none;cursor:pointer}
.pj-f-img{display:block;width:100%;height:100%;object-fit:cover}
.pj-f-ph.broken::after{content:"🖼";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.8rem;opacity:.5}
.pj-f-mini{position:absolute;bottom:4px;min-width:34px;height:34px;padding:0 6px;border:0;border-radius:17px;background:rgba(0,0,0,.55);color:#fff;font-size:.8rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.pj-f-mini.l{left:4px}
.pj-f-mini.r{right:4px}
.pj-f-mini:disabled{opacity:.5}
.pj-f-doc{margin:8px 0;padding:12px;border:1px solid var(--line,#eadfd6);border-radius:12px;background:var(--card,#fff)}
.pj-f-row{display:flex;align-items:center;gap:10px;min-width:0}
.pj-f-ico{flex:none;font-size:1.6rem}
.pj-f-main{flex:1;min-width:0}
.pj-f-name{font-weight:700;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.pj-f-meta{margin-top:2px;overflow-wrap:anywhere}
.pj-f-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.pj-f-act{min-height:40px;padding:0 14px;border:2px solid var(--line,#eadfd6);background:#fff;border-radius:12px;font-weight:700;cursor:pointer;color:inherit}
.pj-f-act.del{color:var(--bad,#c8402a);border-color:#f0c4bb}
.pj-f-act:disabled{opacity:.5}
.pj-f-warn{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0}
`;

function ensureStyles() {
  if (document.getElementById("pj-files-style")) return;
  const st = document.createElement("style");
  st.id = "pj-files-style";
  st.textContent = CSS;
  document.head.append(st);
}

// 화면에 보일 이름: 제어문자와 글자 방향을 바꾸는 문자를 지운다
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "");
// 안내 문구용 짧은 이름(30자)
const shortName = (s) => {
  const a = [...cleanName(s)];
  if (!a.length) return "파일";
  return a.length > 30 ? a.slice(0, 29).join("") + "…" : a.join("");
};
const kb = (n) => {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  return v >= 1048576 ? (v / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(v / 1024)) + "KB";
};
const iconOf = (f) => {
  const n = String(f.file_name || "").toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "📊";
  if (/\.(docx?|hwp|hwpx)$/.test(n)) return "📄";
  if (/\.pdf$/.test(n)) return "📕";
  if (/\.pptx?$/.test(n)) return "📙";
  if (/\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return "🖼";
  if (/\.(zip|7z)$/.test(n)) return "🗜";
  if (/\.txt$/.test(n)) return "📃";
  return "📎";
};
// 올해가 아니면 '25년 10/26(월)' 처럼 연도를 붙인다
const fmtDate = (iso) => {
  try {
    const d = dateOf(iso);
    return (d.slice(0, 4) === todayKST().slice(0, 4) ? "" : d.slice(2, 4) + "년 ") + labelMD(d);
  } catch {
    return "";
  }
};
const isPhoto = (r) => r.kind === "image";

export async function renderFiles(root, ctx) {
  ensureStyles();
  ensureImgStyles();
  const pj = ctx && ctx.pj;
  const project = ctx && ctx.project;
  if (!pj || !project) {
    root.replaceChildren(h("p", { class: "err" }, "파일 화면을 열지 못했어요"));
    return;
  }
  const pid = project.id;
  const me = (ctx.profile && ctx.profile.user_id) || null;
  const archived = project.status === "archived";
  const canWrite = !!ctx.canWrite && !archived;
  const canAdmin = !!ctx.canAdmin;
  // 보관된 프로젝트에서는 관리자만 지울 수 있다(올린 사람도 읽기만)
  const canDel = (r) => canAdmin || (!archived && !!me && r.uploaded_by === me);
  const canGoPost = () => typeof ctx.goPost === "function";

  // 이 판이 아직 쓸모 있는지: 같은 칸에 새로 그렸거나, 화면에 붙었다가 떨어졌으면 끝난 것.
  // 아직 한 번도 안 붙은 칸(붙이기 전에 await 하는 호출)은 그대로 그린다
  const token = {};
  root.__pjFiles = token;
  let seen = root.isConnected;
  const alive = () => {
    if (root.__pjFiles !== token) return false;
    if (root.isConnected) seen = true;
    else if (seen) return false;
    return true;
  };

  let kind = "all", q = "";
  let rows = [], hasMore = false, loading = true, err = "";
  let moreBusy = false, moreErr = "";
  let gen = 0, paintGen = 0;
  let upBusy = false, stopUp = false, upNow = null, upFails = [], upSkipped = 0;
  let opening = false, timer = 0;
  const deleting = new Set();

  // 큰 사진 주소(눌렀을 때만 받음). fresh 면 기억해 둔 주소를 건너뛰고 새로 받는다
  const bigUrl = (r, fresh) => pj.urls([r.path], !!fresh).then((m) => m.get(r.path));

  /* ---------- 화면 틀 ---------- */
  const fileIn = h("input", {
    type: "file", multiple: true, accept: ACCEPT, style: "display:none", tabindex: "-1", "aria-hidden": "true",
    onchange: () => {
      const picked = Array.from(fileIn.files || []);
      fileIn.value = ""; // 같은 파일을 다시 골라도 반응하게
      if (picked.length) uploadAll(picked);
    },
  });
  const upBtn = h("button", { type: "button", class: "btn primary", onclick: () => { if (!upBusy) fileIn.click(); } }, "⬆ 파일 올리기");
  const upBox = h("div", { "aria-live": "polite" });
  const chipsBox = h("div", { class: "pj-f-chips", role: "group", "aria-label": "파일 종류" });
  const search = h("input", {
    class: "inp", type: "search", placeholder: "파일 이름 검색", maxlength: "50", autocomplete: "off", "aria-label": "파일 이름 검색",
  });
  const listBox = h("div");
  const moreBox = h("div");

  function runSearch() {
    clearTimeout(timer);
    const v = search.value.trim();
    if (v === q) return;
    q = v;
    load(true);
  }
  function searchLater() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (alive()) runSearch(); }, 450);
  }
  search.addEventListener("input", (e) => { if (!e.isComposing) searchLater(); });
  search.addEventListener("compositionend", searchLater);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });

  /* ---------- 올리기 ---------- */
  function drawUp() {
    upBtn.disabled = upBusy;
    upBtn.textContent = upBusy ? "올리는 중…" : "⬆ 파일 올리기";
    const kids = [];
    if (upBusy && upNow) {
      kids.push(h("div", { class: "pj-f-prog" },
        h("span", { class: "pj-f-prog-t" }, `(${upNow.i}/${upNow.n}) 올리는 중… ${shortName(upNow.name)}`),
        h("button", { type: "button", class: "pj-f-act", disabled: stopUp, onclick: () => { stopUp = true; drawUp(); } },
          stopUp ? "멈추는 중…" : "그만 올리기")));
    }
    if (!upBusy && (upFails.length || upSkipped)) {
      kids.push(h("div", { class: "pj-f-fail", role: "alert" },
        h("b", null, upFails.length ? `올리지 못한 파일 ${upFails.length}개` : "올리기를 멈췄어요"),
        upFails.length > 0 && h("ul", null, upFails.map((m) => h("li", null, m))),
        upSkipped > 0 && h("p", { class: "muted" }, `${upSkipped}개는 올리지 않았어요`),
        h("button", { type: "button", class: "pj-f-act", onclick: () => { upFails = []; upSkipped = 0; drawUp(); } }, "닫기")));
    }
    upBox.replaceChildren(...kids);
  }

  // 글 없이 한 개씩 차례로 올린다(폰 메모리 보호). 실패한 파일은 이유와 함께 모아서 보여준다
  async function uploadAll(list) {
    if (upBusy || !canWrite || !list.length) return;
    upBusy = true;
    stopUp = false;
    upFails = [];
    upSkipped = 0;
    let okN = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        if (stopUp) { upSkipped = list.length - i; break; }
        const f = list[i];
        upNow = { i: i + 1, n: list.length, name: f.name };
        drawUp();
        const bad = checkFile(f);
        if (bad) { upFails.push(bad); continue; }
        try {
          await pj.uploadFile(pid, null, f);
          okN++;
        } catch (e) {
          upFails.push(`${shortName(f.name)}: ${(e && e.message) || "올리지 못했어요"}`);
        }
      }
    } finally {
      upBusy = false;
      upNow = null;
      drawUp();
    }
    if (okN && !upFails.length && !upSkipped) toast(`${okN}개 올렸어요`, 2200);
    else if (okN) toast(`${okN}개 올렸어요. 올리지 못한 파일이 있어요`, 4500);
    else if (upFails.length) toast("올리지 못했어요. 이유를 확인해 주세요", 4500);
    else toast("올리기를 멈췄어요", 2200);
    if (okN && alive()) await load(true);
  }

  /* ---------- 목록 불러오기 ---------- */
  async function load(reset) {
    const my = ++gen;
    if (reset) {
      rows = [];
      hasMore = false;
      err = "";
      moreErr = "";
      moreBusy = false;
      loading = true;
      drawList();
    } else {
      moreBusy = true;
      moreErr = "";
      drawMore();
    }
    try {
      const before = (reset || !rows.length) ? undefined : rows[rows.length - 1].created_at;
      const r = await pj.files(pid, { kind: kind === "all" ? undefined : kind, q, before, limit: PAGE });
      if (my !== gen) return; // 그 사이 다시 불러왔으면 이 결과는 버린다
      if (reset) rows = r.rows;
      else {
        const have = new Set(rows.map((x) => x.id));
        rows = rows.concat(r.rows.filter((x) => !have.has(x.id)));
      }
      hasMore = !!r.hasMore;
      err = "";
      moreErr = "";
    } catch (e) {
      if (my !== gen) return;
      const msg = (e && e.message) || "알 수 없는 오류";
      if (reset || !rows.length) err = msg;
      else moreErr = msg;
    }
    loading = false;
    moreBusy = false;
    if (alive()) drawList();
  }

  /* ---------- 그리기 ---------- */
  function drawChips() {
    chipsBox.replaceChildren(...KINDS.map(([k, l]) =>
      h("button", {
        type: "button", class: "pj-f-chip" + (kind === k ? " on" : ""), "aria-pressed": kind === k ? "true" : "false",
        onclick: () => {
          if (kind === k) return;
          kind = k;
          drawChips();
          load(true);
        },
      }, l)));
  }

  function drawMore() {
    const kids = [];
    if (moreErr) kids.push(h("p", { class: "err" }, "불러오기 실패: " + moreErr));
    if (rows.length && (hasMore || moreErr)) {
      kids.push(h("button", { type: "button", class: "btn ghost slim", disabled: moreBusy, onclick: () => load(false) },
        moreBusy ? "불러오는 중…" : moreErr ? "다시 시도" : "더 보기"));
    }
    moreBox.replaceChildren(...kids);
  }

  function photoCell(r, imgs) {
    const nm = cleanName(r.file_name) || "사진";
    const img = h("img", { class: "pj-f-img", alt: "", loading: "lazy", decoding: "async", draggable: "false" });
    img.dataset.p = r.thumb_path || r.path;
    imgs.push(img);
    const tip = [nm, cleanName(r.uploaded_name), fmtDate(r.created_at)].filter(Boolean).join(" · ");
    return h("div", { class: "pj-f-cell", title: tip },
      h("button", { type: "button", class: "pj-f-ph", "aria-label": `${nm} 크게 보기`, onclick: () => openPhoto(r) }, img),
      r.post_id && canGoPost() && h("button", { type: "button", class: "pj-f-mini l", "aria-label": "글로 이동", onclick: () => goPost(r) }, "글"),
      canDel(r) && h("button", {
        type: "button", class: "pj-f-mini r", "aria-label": "사진 지우기", disabled: deleting.has(r.id), onclick: () => removeRow(r),
      }, "🗑"));
  }

  function docRow(r) {
    const nm = cleanName(r.file_name) || "이름 없는 파일";
    const meta = [kb(r.size), cleanName(r.uploaded_name), fmtDate(r.created_at)].filter(Boolean).join(" · ");
    return h("div", { class: "pj-f-doc" },
      h("div", { class: "pj-f-row" },
        h("span", { class: "pj-f-ico", "aria-hidden": "true" }, iconOf(r)),
        h("div", { class: "pj-f-main" },
          h("div", { class: "pj-f-name", title: nm }, nm),
          h("div", { class: "muted pj-f-meta" }, meta))),
      h("div", { class: "pj-f-acts" },
        h("button", { type: "button", class: "pj-f-act", onclick: () => openDoc(r) }, "열기"),
        r.post_id && canGoPost() && h("button", { type: "button", class: "pj-f-act", onclick: () => goPost(r) }, "글로 이동"),
        canDel(r) && h("button", { type: "button", class: "pj-f-act del", disabled: deleting.has(r.id), onclick: () => removeRow(r) }, "삭제")));
  }

  function drawList() {
    const my = ++paintGen;
    const imgs = [];
    const kids = [];
    if (loading) {
      kids.push(h("p", { class: "muted" }, "불러오는 중…"));
    } else if (err) {
      kids.push(h("p", { class: "err" }, "불러오기 실패: " + err));
      kids.push(h("button", { type: "button", class: "pj-f-act", onclick: () => load(true) }, "다시 시도"));
    } else if (!rows.length) {
      kids.push(h("p", { class: "muted" }, (q || kind !== "all") ? "찾는 파일이 없어요" : "아직 올린 파일이 없어요"));
    } else {
      const photos = rows.filter(isPhoto);
      const docs = rows.filter((r) => !isPhoto(r));
      const both = photos.length > 0 && docs.length > 0;
      if (photos.length) {
        if (both) kids.push(h("div", { class: "pj-f-sec" }, "사진"));
        kids.push(h("div", { class: "pj-f-grid" }, photos.map((r) => photoCell(r, imgs))));
      }
      if (docs.length) {
        if (both) kids.push(h("div", { class: "pj-f-sec" }, "문서"));
        for (const r of docs) kids.push(docRow(r));
      }
    }
    listBox.replaceChildren(...kids);
    drawMore();
    fillThumbs(imgs, my).catch(() => {});
  }

  /* ---------- 작은 사진 ---------- */
  // 그림이 안 열리면 깨진 표시(누르면 큰 사진 보기에서 다시 시도할 수 있다)
  function broken(im) {
    im.removeAttribute("src");
    if (im.parentElement) im.parentElement.classList.add("broken");
  }

  async function retryThumb(im) {
    if (im.dataset.retried) { broken(im); return; }
    im.dataset.retried = "1";
    try {
      const u = (await pj.urls([im.dataset.p], true)).get(im.dataset.p); // 만료됐을 수 있으니 새 주소로 한 번만
      if (u && im.isConnected) im.src = u;
      else broken(im);
    } catch {
      broken(im);
    }
  }

  // 이번에 그린 작은 사진들의 주소를 한 번에 받아 채운다(이미 받은 건 pj.urls 가 기억하고 있음)
  async function fillThumbs(imgs, my) {
    if (!imgs.length) return;
    let map;
    try {
      map = await pj.urls(imgs.map((im) => im.dataset.p));
    } catch (e) {
      if (my === paintGen && alive()) {
        listBox.prepend(h("div", { class: "pj-f-warn" },
          h("span", { class: "err" }, "사진 미리보기를 불러오지 못했어요: " + ((e && e.message) || "")),
          h("button", { type: "button", class: "pj-f-act", onclick: () => drawList() }, "다시 시도")));
      }
      return;
    }
    if (my !== paintGen || !alive()) return;
    for (const im of imgs) {
      const u = map.get(im.dataset.p);
      if (!u) { broken(im); continue; }
      im.addEventListener("error", () => { retryThumb(im); });
      im.src = u;
    }
  }

  /* ---------- 누르기 ---------- */
  function openPhoto(r) {
    const list = rows.filter(isPhoto);
    const i = list.findIndex((x) => x.id === r.id);
    openLightbox(list, i < 0 ? 0 : i, bigUrl);
  }

  // library.js 와 같은 방식: 팝업 차단을 피하려고 눌렀을 때 창을 먼저 열고, 새 임시 주소를 받으면 그 창으로 보낸다
  async function openDoc(r) {
    if (opening) return;
    opening = true;
    const w = window.open("", "_blank");
    if (w) { try { w.opener = null; } catch { /* ignore */ } }
    try {
      const url = (await pj.urls([r.path], true)).get(r.path);
      if (!url) throw new Error("파일 주소를 받지 못했어요");
      if (w) w.location.href = url;
      else location.href = url;
    } catch (e) {
      try { if (w) w.close(); } catch { /* ignore */ }
      toast((e && e.message) || "파일을 열지 못했어요", 5000);
    } finally {
      opening = false;
    }
  }

  function goPost(r) {
    if (canGoPost()) ctx.goPost(r.post_id);
  }

  async function removeRow(r) {
    if (deleting.has(r.id)) return;
    const items = [cleanName(r.file_name) || "파일"];
    if (r.post_id) items.push("글에 붙은 파일이라 그 글에서도 사라져요");
    items.push("지우면 되돌릴 수 없어요");
    if (!(await confirmDialog("파일을 지울까요?", items, "취소", "지우기"))) return;
    deleting.add(r.id);
    if (alive()) drawList();
    try {
      await pj.deleteFile(r);
      toast("지웠어요", 1800);
      rows = rows.filter((x) => x.id !== r.id);
      if (!rows.length && hasMore) { // 불러온 게 다 지워졌으면 맨 앞부터 다시
        deleting.delete(r.id);
        if (alive()) await load(true);
        return;
      }
    } catch (e) {
      toast((e && e.message) || "지우지 못했어요", 5000);
    }
    deleting.delete(r.id);
    if (alive()) drawList();
  }

  /* ---------- 시작 ---------- */
  const note = canWrite
    ? h("div", null, upBtn, fileIn,
      h("p", { class: "muted pj-f-note" }, "한 번에 여러 개를 고를 수 있어요 (파일당 20MB). 고객 개인정보·급여·통장 자료는 올리지 마세요."))
    : h("p", { class: "muted pj-f-note" }, archived ? "보관된 프로젝트라서 파일을 볼 수만 있어요." : "프로젝트에 참여하면 파일을 올릴 수 있어요.");

  root.replaceChildren(h("div", { class: "pj-files" }, note, upBox, chipsBox, search, listBox, moreBox));
  drawUp();
  drawChips();
  await load(true);
}
