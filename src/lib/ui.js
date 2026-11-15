import { t, lang } from "./i18n.js";

// 문자열만 화면 언어로 바꾼다(사전에 없으면 그대로). 이미 번역된 문장·요소(노드)를 넘겨도 안전하다
const tr = (s) => (typeof s === "string" ? t(s) : s);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// msg 는 t(msg) 로 자동 번역된다(이미 번역된 문장도 사전에 없으면 그대로 나온다)
export function toast(msg, ms = 2600) {
  // DB·네트워크가 던지는 영어 원문(예: Failed to fetch, JWT expired)은 번역할 수 없어서, 한국어가 아닌 화면에서는 알아볼 수 있는 문장으로 바꾼다
  if (typeof msg === "string" && lang() !== "ko" && !/[가-힣]/.test(msg)) {
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) msg = "서버에 연결하지 못했어요";
    else if (/jwt|row-level security|violates|does not exist|permission denied|schema cache/i.test(msg)) msg = "처리하지 못했어요";
  }
  const el = h("div", { class: "toast", role: "status" }, tr(msg));
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// 제출 전 빈칸 안내. true = 그대로 제출, false = 돌아가서 채우기
export function confirmDialog(title, items, backLabel, goLabel) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); resolve(v); };
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, tr(title)),
        h("ul", null, items.map((i) => h("li", null, tr(i)))),
        h("button", { class: "btn primary", onclick: () => close(false) }, tr(backLabel)),
        h("button", { class: "btn ghost", onclick: () => close(true) }, tr(goLabel))));
    document.body.append(ov);
  });
}

// 비밀번호 입력칸: 오른쪽 '보기' 버튼을 누르면 글자가 보이고, 다시 누르면 숨겨진다. .input 으로 실제 input에 접근.
export function passwordField(placeholder, { autocomplete = "current-password", value = "", oninput } = {}) {
  const ph = tr(placeholder);
  const inp = h("input", { type: "password", class: "inp pw-inp", placeholder: ph, autocomplete, "aria-label": ph });
  inp.value = value;
  if (oninput) inp.addEventListener("input", () => oninput(inp.value));
  const eye = h("button", { type: "button", class: "pw-eye", "aria-label": t("비밀번호 보기/숨기기"), onclick: () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    eye.textContent = show ? t("숨김") : t("보기");
  } }, t("보기"));
  return Object.assign(h("div", { class: "pwbox" }, inp, eye), { input: inp });
}

// 새 비밀번호를 두 번 입력받는 창. 서로 같고 8자 이상이면 문자열, 취소하면 null
export function promptPassword(title) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); resolve(v); };
    const p1 = passwordField(t("새 비밀번호 (8자 이상)"), { autocomplete: "new-password" });
    const p2 = passwordField(t("새 비밀번호 한 번 더"), { autocomplete: "new-password" });
    const hint = h("p", { class: "hint" }, "");
    const check = () => {
      hint.textContent = !p2.input.value ? "" : p1.input.value === p2.input.value ? t("✓ 서로 같아요") : t("✕ 서로 달라요");
      hint.className = "hint " + (p1.input.value === p2.input.value ? "ok-text" : "err");
    };
    p1.input.addEventListener("input", check); p2.input.addEventListener("input", check);
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, tr(title)), p1, p2, hint,
        h("button", { class: "btn primary", onclick: () => {
          if (p1.input.value.length < 8) { toast(t("8자 이상 입력해 주세요")); return; }
          if (p1.input.value !== p2.input.value) { toast(t("두 비밀번호가 서로 달라요")); return; }
          close(p1.input.value);
        } }, t("변경")),
        h("button", { class: "btn ghost", onclick: () => close(null) }, t("취소"))));
    document.body.append(ov);
    p1.input.focus();
  });
}
// 내용을 직접 넣는 확인창. 확인=true, 취소=false (내용 요소는 다시 열어도 값이 유지된다)
export function modal(title, content, okLabel = "확인", cancelLabel = "취소") {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); resolve(v); };
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, tr(title)), content,
        h("button", { class: "btn primary", onclick: () => close(true) }, tr(okLabel)),
        h("button", { class: "btn ghost", onclick: () => close(false) }, tr(cancelLabel))));
    document.body.append(ov);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

// 00:00 형식 시간 입력 (숫자만 누르면 콜론이 자동으로 붙는다)
export function timeInput(value, onChange) {
  const el = h("input", { type: "text", inputmode: "numeric", maxlength: "5", placeholder: "00:00", class: "inp time", "aria-label": t("시각"), autocomplete: "off" });
  el.value = value || "";
  el.addEventListener("input", () => {
    const d = el.value.replace(/\D/g, "").slice(0, 4);
    el.value = d.length > 2 ? d.slice(0, 2) + ":" + d.slice(2) : d;
    onChange(el.value);
  });
  el.addEventListener("blur", () => {
    const d = el.value.replace(/\D/g, "");
    if (!d) return;
    let hh, mm;
    if (d.length <= 2) { hh = d; mm = "00"; } else if (d.length === 3) { hh = "0" + d[0]; mm = d.slice(1); } else { hh = d.slice(0, 2); mm = d.slice(2); }
    hh = String(Math.min(23, Number(hh))).padStart(2, "0");
    mm = String(Math.min(59, Number(mm))).padStart(2, "0");
    el.value = `${hh}:${mm}`;
    onChange(el.value);
  });
  return el;
}

export const seg =(options, value, onPick) =>
  h("div", { class: "seg" }, options.map(([v, label]) =>
    h("button", { type: "button", class: "segbtn" + (value === v ? " on" : ""), onclick: () => onPick(v) }, label)));

export const bigToggle = (label, on, onChange) =>
  h("button", { type: "button", class: "bigtoggle" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", onclick: () => onChange(!on) },
    h("span", { class: "box" }, on ? "✓" : ""), h("span", null, label));
