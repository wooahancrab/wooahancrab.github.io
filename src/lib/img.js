// 프로젝트 사진·파일 공용 도우미: 올리기 전 검사, 폰에서 사진 줄이기, 임시 주소 묶음 캐시, 큰 사진 보기.
// 브라우저에서만 돌아가고 서버 함수·비밀키는 쓰지 않는다. 파일 이름·글자는 모두 글자로만 화면에 넣는다(innerHTML 안 씀).
import { h } from "./ui.js";

export const ALLOWED_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "hwpx", "txt", "csv", "zip",
]);
export const MAX_BYTES = 20 * 1024 * 1024;

const BIG_SIDE = 1600;          // 큰 판: 긴 변 1600px
const THUMB_SIDE = 360;         // 작은 판: 긴 변 360px
const BIG_Q = 0.8;
const THUMB_Q = 0.7;
const MAX_SRC_PIXELS = 64e6;    // 이보다 큰 사진(약 6400만 화소)은 폰 메모리가 모자랄 수 있어 줄이지 않는다
const DECODE_TIMEOUT = 30000;   // 사진 열기가 이 시간(ms) 넘게 걸리면 포기
const URL_TTL_SEC = 3600;       // 임시 주소 유효 시간
const URL_KEEP_MS = 55 * 60 * 1000; // 메모리에는 55분만 보관(만료 직전 주소를 쓰지 않도록)
const URL_CACHE_MAX = 600;

const IMG_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);
const IMG_MIME = /^image\/(jpe?g|pjpeg|png|x-png|gif|webp|heic|heif|heic-sequence|heif-sequence)$/i;

// 이름 끝의 확장자(소문자). 공백을 깎지 않는다: 올리기 경로(pj-api.js)도 같은 규칙으로 읽어야 검사와 저장 경로가 어긋나지 않는다
export const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
};

// 안내 문구에 넣을 파일 이름: 제어문자·방향 바꾸는 글자를 지우고 길면 줄인다
const safeName = (name) => {
  const a = [...String(name || "")].filter((c) => {
    const n = c.codePointAt(0);
    return !(n < 32 || n === 127 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069));
  });
  return a.length > 30 ? a.slice(0, 29).join("") + "…" : a.join("");
};

/* ---------------- 올리기 전 검사 ---------------- */

// 올릴 수 있으면 null, 안 되면 한국어 이유
export function checkFile(file) {
  if (!file) return "파일을 골라 주세요";
  const nm = safeName(file.name) || "파일";
  if (!file.size) return `${nm}: 내용이 비어 있는 파일이에요`;
  if (file.size > MAX_BYTES) return `${nm}: 20MB보다 커서 올릴 수 없어요 (${(file.size / 1048576).toFixed(1)}MB)`;
  if (/\s$/.test(String(file.name || ""))) return `${nm}: 파일 이름 끝의 공백을 지운 뒤 올려 주세요`;
  const ext = extOf(file.name);
  if (!ext) return `${nm}: 확장자가 없는 파일은 올릴 수 없어요`;
  if (!ALLOWED_EXT.has(ext)) return `${nm}: 올릴 수 없는 파일 형식이에요 (사진·pdf·문서·엑셀·ppt·hwp·txt·csv·zip만 가능해요)`;
  return null;
}

// 사진인가? (형식 이름 또는 확장자로 판단. svg 같은 건 사진으로 안 친다)
export function isImage(file) {
  if (!file) return false;
  if (IMG_MIME.test(file.type || "")) return true;
  return IMG_EXT.has(extOf(file.name));
}

/* ---------------- 사진 줄이기 ---------------- */

function readBuf(blob) {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsArrayBuffer(blob);
    } catch { resolve(null); }
  });
}

// JPEG 머리말에서 가로·세로를 찾는다(EXIF 안의 작은 사진은 구간 길이로 건너뜀). 모르면 null
function jpegSize(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= dv.byteLength) {
    if (dv.getUint8(p) !== 0xff) { p++; continue; }
    const m = dv.getUint8(p + 1);
    if (m === 0xff) { p++; continue; }
    if (m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = dv.getUint16(p + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (p + 9 > dv.byteLength) return null;
      return { ht: dv.getUint16(p + 5), w: dv.getUint16(p + 7) };
    }
    p += 2 + len;
  }
  return null;
}

// 파일 앞부분만 읽어 크기를 알아낸다(JPEG·PNG). 사진을 통째로 열기 전에 너무 큰 것을 걸러내는 용도
async function peekSize(file) {
  const buf = await readBuf(file.slice(0, 262144));
  if (!buf || buf.byteLength < 24) return null;
  const dv = new DataView(buf);
  if (dv.getUint16(0) === 0xffd8) return jpegSize(dv);
  if (dv.getUint32(0) === 0x89504e47 && dv.getUint32(4) === 0x0d0a1a0a) return { w: dv.getUint32(16), ht: dv.getUint32(20) };
  return null;
}

// 사진 열기 ①: createImageBitmap (EXIF 회전을 반영). 안 되는 브라우저면 ②로
// 반환: { src, w, ht, done() } | null.  done() 은 꼭 불러서 메모리를 놓아 준다
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      let closed = false;
      return { src: bmp, w: bmp.width, ht: bmp.height, done: () => { if (!closed) { closed = true; try { bmp.close(); } catch { /* ignore */ } } } };
    } catch { /* 옵션을 모르거나 못 읽는 형식: 아래 이미지 태그 방식으로 한 번 더 */ }
  }
  return decodeViaImg(file);
}

// 사진 열기 ②: <img> 로 읽기(요즘 브라우저는 EXIF 회전을 알아서 반영). 못 읽으면 null
function decodeViaImg(file) {
  return new Promise((resolve) => {
    let url = "";
    let settled = false;
    let timer = 0;
    const img = new Image();
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (!v) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        img.removeAttribute("src");
      }
      resolve(v);
    };
    try { url = URL.createObjectURL(file); } catch { resolve(null); return; }
    img.onload = () => {
      const w = img.naturalWidth, ht = img.naturalHeight;
      if (!w || !ht) { finish(null); return; }
      finish({
        src: img, w, ht,
        done: () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } img.removeAttribute("src"); },
      });
    };
    img.onerror = () => finish(null);
    timer = setTimeout(() => finish(null), DECODE_TIMEOUT);
    img.decoding = "async";
    img.src = url;
  });
}

function makeCanvas(w, ht) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = ht;
  return c;
}

function release(c) {
  if (!c) return;
  try { c.width = 0; c.height = 0; } catch { /* ignore */ }
}

// 흰 바탕을 깔고 그림을 캔버스 크기에 맞춰 그린다(PNG 투명 부분이 검게 되는 것을 막음). 성공하면 true
function paint(canvas, src) {
  const g = canvas.getContext("2d");
  if (!g) return false;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, canvas.width, canvas.height);
  return true;
}

// 긴 변이 max 를 넘으면 비율대로 줄인 크기. 작은 사진은 키우지 않는다
function fit(iw, ih, max) {
  const s = Math.min(1, max / Math.max(iw, ih));
  return [Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s))];
}

// 캔버스를 목표 크기로 줄인 새 캔버스. 2배 넘게 줄일 때는 반씩 나눠 줄여 계단 현상을 덜어낸다
function shrinkTo(src, tw, th) {
  let cur = src;
  try {
    while (cur.width > tw * 2 || cur.height > th * 2) {
      const next = makeCanvas(Math.max(tw, Math.round(cur.width / 2)), Math.max(th, Math.round(cur.height / 2)));
      let ok = false;
      try { ok = paint(next, cur); } catch { ok = false; }
      if (cur !== src) release(cur);
      cur = next;
      if (!ok) throw new Error("canvas");
    }
    const out = makeCanvas(tw, th);
    let ok = false;
    try { ok = paint(out, cur); } catch { ok = false; }
    if (!ok) { release(out); throw new Error("canvas"); }
    return out;
  } finally {
    if (cur !== src) release(cur);
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try { canvas.toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
  });
}

async function doResize(file) {
  let dec = null, cBig = null, cThumb = null;
  try {
    if (!file || !isImage(file)) return null;
    const peek = await peekSize(file);
    if (peek && peek.w * peek.ht > MAX_SRC_PIXELS) return null;
    dec = await decode(file);
    if (!dec) return null;
    const [bw, bh] = fit(dec.w, dec.ht, BIG_SIDE);
    cBig = makeCanvas(bw, bh);
    if (!paint(cBig, dec.src)) return null;
    dec.done();
    dec = null; // 원본은 바로 놓아 주고, 이후에는 줄인 캔버스만 쓴다
    const big = await toBlob(cBig, "image/jpeg", BIG_Q);
    if (!big || !big.size) return null;
    const [tw, th] = fit(bw, bh, THUMB_SIDE);
    cThumb = shrinkTo(cBig, tw, th);
    release(cBig);
    cBig = null;
    const thumb = await toBlob(cThumb, "image/jpeg", THUMB_Q);
    if (!thumb || !thumb.size) return null;
    return { big, thumb, width: bw, height: bh };
  } catch {
    return null;
  } finally {
    if (dec) dec.done();
    release(cBig);
    release(cThumb);
  }
}

// 큰 판(긴 변 1600px JPEG)과 작은 판(360px)을 만든다. 읽을 수 없는 형식(HEIC 등)·너무 큰 사진은 null → 부른 쪽이 일반 파일로 올린다.
// 여러 장을 동시에 불러도 한 장씩 차례로 처리한다(폰 메모리 보호).
let resizeChain = Promise.resolve();
export async function resizeImage(file) {
  const run = resizeChain.then(() => doResize(file));
  resizeChain = run.then(() => {}, () => {});
  return run;
}

/* ---------------- 임시 주소 캐시 ---------------- */

const urlCache = new Map(); // 경로 -> { url, exp }

function trimCache(now) {
  if (urlCache.size <= URL_CACHE_MAX) return;
  for (const [k, v] of urlCache) if (v.exp <= now) urlCache.delete(k);
  for (const k of urlCache.keys()) {
    if (urlCache.size <= URL_CACHE_MAX) break;
    urlCache.delete(k);
  }
}

// 로그아웃 때 불러 두면 다른 계정에게 옛 주소가 남지 않는다
export function clearSignedUrls() {
  urlCache.clear();
}

// 보관함(projects) 파일들의 1시간짜리 임시 주소를 한 번에 받는다. 캐시에 있으면(55분 안) 다시 안 받는다.
// 경로별 오류는 무시하고(그 경로만 Map 에서 빠짐), 호출 자체가 실패하면 오류를 던진다.
// opts.fresh = true 면 캐시를 건너뛰고 새로 받는다(주소가 만료돼 사진이 안 열릴 때 다시 시도용)
export async function signedUrls(client, paths, opts) {
  const out = new Map();
  const now = Date.now();
  const fresh = opts === true || !!(opts && opts.fresh);
  const want = [...new Set((paths || []).filter((p) => typeof p === "string" && p))];
  const need = [];
  for (const p of want) {
    const c = fresh ? null : urlCache.get(p);
    if (c && c.exp > now) out.set(p, c.url);
    else need.push(p);
  }
  if (!need.length) return out;
  const { data, error } = await client.storage.from("projects").createSignedUrls(need, URL_TTL_SEC);
  if (error) throw error;
  const exp = now + URL_KEEP_MS;
  (data || []).forEach((d, i) => {
    if (!d || d.error) return;
    const p = d.path || need[i];
    const url = d.signedUrl || d.signedURL;
    if (!p || !url) return;
    urlCache.delete(p);
    urlCache.set(p, { url, exp });
    out.set(p, url);
  });
  trimCache(now);
  return out;
}

/* ---------------- 큰 사진 보기 ---------------- */

const CSS = `
.pj-lightbox{position:fixed;inset:0;z-index:25;display:flex;flex-direction:column;background:rgba(0,0,0,.94);color:#fff;overscroll-behavior:contain;-webkit-user-select:none;user-select:none}
.pj-lightbox:focus{outline:none}
.pj-lightbox [hidden]{display:none!important}
.pj-lb-top{flex:none;display:flex;align-items:center;gap:8px;padding:calc(8px + env(safe-area-inset-top)) 12px 8px}
.pj-lb-count{flex:none;min-width:3.6em;font-size:.85rem;opacity:.85}
.pj-lb-name{flex:1;min-width:0;font-size:.8rem;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pj-lb-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 14px;border:1px solid rgba(255,255,255,.35);border-radius:22px;background:rgba(255,255,255,.12);color:#fff;font-weight:700;font-size:.9rem;text-decoration:none;cursor:pointer}
.pj-lb-btn:focus-visible,.pj-lb-nav:focus-visible{outline:2px solid #fff;outline-offset:2px}
.pj-lb-btn[aria-disabled=true]{opacity:.4;pointer-events:none}
.pj-lb-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:pan-y pinch-zoom;padding-bottom:env(safe-area-inset-bottom)}
.pj-lb-img{display:none;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
.pj-lb-img.on{display:block}
.pj-lb-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:80%;text-align:center;font-size:.95rem;opacity:.9}
.pj-lb-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:1;width:48px;height:72px;border:0;border-radius:12px;background:rgba(255,255,255,.14);color:#fff;font-size:2rem;line-height:1;cursor:pointer}
.pj-lb-nav.prev{left:6px}.pj-lb-nav.next{right:6px}
`;

// 이 파일이 쓰는 스타일을 한 번만 끼워 넣는다
export function ensureImgStyles() {
  if (document.getElementById("pj-img-style")) return;
  const st = document.createElement("style");
  st.id = "pj-img-style";
  st.textContent = CSS;
  document.head.append(st);
}

// 내려받기 주소: 보관함 주소에 download 를 붙이면 서버가 파일로 내려준다
function downloadHref(url, name) {
  const base = String(url);
  if (/[?&]download=/.test(base)) return base;
  return base + (base.includes("?") ? "&" : "?") + "download=" + encodeURIComponent(name);
}

// 줄여서 올린 사진은 JPEG 이므로 내려받는 이름의 확장자도 jpg 로 맞춘다
function downloadName(row) {
  const n = String((row && row.file_name) || "photo.jpg");
  if (row && /^image\/jpeg$/i.test(row.mime || "") && !/\.jpe?g$/i.test(n)) return n.replace(/\.[A-Za-z0-9]{1,8}$/, "") + ".jpg";
  return n;
}

let lbClose = null; // 지금 열려 있는 큰 사진 보기를 닫는 함수(한 번에 하나만 연다)
let lbCarry = false; // 덮개를 바꿔 열 때, 앞 덮개가 쌓아 둔 history 항목을 새 덮개가 이어받는다는 표시

// 뒤로가기(popstate) 한 번을 화면 쪽 처리기보다 먼저(캡처 단계) 받아서 삼킨다. 1초 안에 안 오면 거둔다.
// 버튼·Esc 로 덮개를 닫고 history.back() 으로 항목을 되돌릴 때, 그 popstate 를 화면이 '뒤로가기'로 오해하지 않게 하려는 것
function swallowNextPop() {
  let t = 0;
  const eat = (e) => {
    clearTimeout(t);
    window.removeEventListener("popstate", eat, true);
    e.stopImmediatePropagation();
  };
  window.addEventListener("popstate", eat, true);
  t = setTimeout(() => window.removeEventListener("popstate", eat, true), 1000);
}

// items: pj_files 행(kind='image') 배열, startIndex: 처음 보여줄 번호, getUrl(row, fresh) -> Promise<큰 사진 주소>
// 사진이 안 열리면(주소 만료 등) getUrl(row, true) 로 새 주소를 받아 한 번만 다시 시도한다. 닫는 함수를 돌려준다.
// 열 때 history 항목을 하나 쌓아서, 폰의 뒤로가기 한 번에 사진만 닫히고 화면(프로젝트) 위치는 그대로 유지된다.
export function openLightbox(items, startIndex, getUrl) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length || typeof getUrl !== "function") return () => {};
  ensureImgStyles();
  if (lbClose) lbClose(true); // 앞 덮개는 항목을 되돌리지 않고 넘겨준다

  let idx = Math.min(Math.max(Math.trunc(Number(startIndex)) || 0, 0), list.length - 1);
  let seq = 0;
  let closed = false;
  let pushed = lbCarry; // 내가 쌓은 history 항목이 아직 남아 있는가
  lbCarry = false;
  const prevFocus = document.activeElement;
  const prevOverflow = document.body.style.overflow;

  const count = h("span", { class: "pj-lb-count", "aria-live": "polite" });
  const nameEl = h("span", { class: "pj-lb-name" });
  const dl = h("a", { class: "pj-lb-btn", target: "_blank", rel: "noopener", "aria-disabled": "true" }, "내려받기");
  const closeBtn = h("button", { type: "button", class: "pj-lb-btn", "aria-label": "닫기", onclick: () => close() }, "닫기");
  const img = h("img", { class: "pj-lb-img", alt: "", draggable: "false", referrerpolicy: "no-referrer" });
  const msg = h("div", { class: "pj-lb-msg", role: "status" });
  const prev = h("button", { type: "button", class: "pj-lb-nav prev", "aria-label": "이전 사진", onclick: () => go(-1) }, "‹");
  const next = h("button", { type: "button", class: "pj-lb-nav next", "aria-label": "다음 사진", onclick: () => go(1) }, "›");
  const stage = h("div", { class: "pj-lb-stage" }, img, msg, prev, next);
  const root = h("div", { class: "pj-lightbox", role: "dialog", "aria-modal": "true", "aria-label": "사진 크게 보기", tabindex: "-1" },
    h("div", { class: "pj-lb-top" }, count, nameEl, dl, closeBtn),
    stage);

  function setMsg(...kids) {
    msg.replaceChildren(...kids);
    msg.hidden = !kids.length;
  }

  function go(d) {
    const ni = idx + d;
    if (ni < 0 || ni >= list.length) return;
    show(ni, false);
  }

  function show(i, fresh) {
    idx = i;
    const token = ++seq;
    const row = list[i] || {};
    count.textContent = `${i + 1} / ${list.length}`;
    nameEl.textContent = row.file_name || "";
    img.alt = row.file_name || "사진";
    img.onload = null;
    img.onerror = null;
    img.classList.remove("on");
    img.removeAttribute("src");
    dl.removeAttribute("href");
    dl.setAttribute("aria-disabled", "true");
    prev.hidden = i <= 0;
    next.hidden = i >= list.length - 1;
    setMsg("불러오는 중…");

    const fail = () => {
      if (token !== seq || closed) return;
      if (!fresh) { show(i, true); return; } // 만료됐을 수 있으니 새 주소로 한 번만 다시
      setMsg(
        h("div", null, "사진을 불러오지 못했어요"),
        h("button", { type: "button", class: "pj-lb-btn", style: "margin-top:12px", onclick: () => show(i, true) }, "다시 시도"));
    };

    Promise.resolve().then(() => getUrl(row, fresh)).then((url) => {
      if (token !== seq || closed) return;
      if (!url) { fail(); return; }
      img.onload = () => {
        if (token !== seq || closed) return;
        img.classList.add("on");
        setMsg();
        const nm = downloadName(row);
        dl.href = downloadHref(url, nm);
        dl.setAttribute("download", nm);
        dl.removeAttribute("aria-disabled");
      };
      img.onerror = fail;
      img.src = url;
    }).catch(fail);
  }

  // keep === true 는 다른 덮개로 바로 바꿔 열 때만(history 항목을 되돌리지 않고 새 덮개에 넘김)
  function close(keep) {
    if (closed) return;
    closed = true;
    seq++;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("popstate", onPop, true);
    img.onload = null;
    img.onerror = null;
    root.remove();
    img.removeAttribute("src");
    document.body.style.overflow = prevOverflow;
    if (lbClose === close) lbClose = null;
    if (pushed) {
      pushed = false;
      if (keep === true) lbCarry = true;
      else {
        swallowNextPop();
        try { history.back(); } catch { /* ignore */ }
      }
    }
    try {
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") prevFocus.focus({ preventScroll: true });
    } catch { /* ignore */ }
  }

  // 뒤로가기: 내 항목은 이미 빠졌으니 되돌리지 않고 닫기만 한다. 캡처 단계에서 가로채 화면이 이 이벤트를 못 보게 한다
  function onPop(e) {
    e.stopImmediatePropagation();
    pushed = false;
    close();
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); go(1); return; }
    if (e.key === "Tab") { // 포커스가 덮개 밖으로 나가지 않게 가둔다
      const f = [...root.querySelectorAll("button, a[href]")].filter((el) => el.getClientRects().length);
      if (!f.length) { e.preventDefault(); root.focus(); return; }
      const first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (!root.contains(cur)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (cur === first || cur === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    }
  }

  // 사진 바깥 빈 곳을 누르면 닫기
  stage.addEventListener("click", (e) => { if (e.target === stage) close(); });

  // 좌우로 밀어서 넘기기(손가락 하나일 때만. 화면을 확대해서 보는 중이면 넘기지 않음)
  let tx = 0, ty = 0, tracking = false;
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    tracking = true;
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    if (!t) return;
    if (window.visualViewport && window.visualViewport.scale > 1.05) return;
    const dx = t.clientX - tx, dy = t.clientY - ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.body.style.overflow = "hidden";
  document.body.append(root);
  document.addEventListener("keydown", onKey, true);
  if (!pushed) {
    try { history.pushState({ pjLb: 1 }, ""); pushed = true; } catch { /* history 를 못 쓰면 뒤로가기 연동만 빠진다 */ }
  }
  window.addEventListener("popstate", onPop, true);
  lbClose = close;
  show(idx, false);
  try { closeBtn.focus({ preventScroll: true }); } catch { /* ignore */ }
  return close;
}
