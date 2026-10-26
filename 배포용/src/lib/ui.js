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

export function toast(msg, ms = 2600) {
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// 제출 전 빈칸 안내. true = 그대로 제출, false = 돌아가서 채우기
export function confirmDialog(title, items, backLabel, goLabel) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); resolve(v); };
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, title),
        h("ul", null, items.map((i) => h("li", null, i))),
        h("button", { class: "btn primary", onclick: () => close(false) }, backLabel),
        h("button", { class: "btn ghost", onclick: () => close(true) }, goLabel)));
    document.body.append(ov);
  });
}

// 비밀번호 입력칸: 오른쪽 '보기' 버튼을 누르면 글자가 보이고, 다시 누르면 숨겨진다. .input 으로 실제 input에 접근.
export function passwordField(placeholder, { autocomplete = "current-password", value = "", oninput } = {}) {
  const inp = h("input", { type: "password", class: "inp pw-inp", placeholder, autocomplete, "aria-label": placeholder });
  inp.value = value;
  if (oninput) inp.addEventListener("input", () => oninput(inp.value));
  const eye = h("button", { type: "button", class: "pw-eye", "aria-label": "비밀번호 보기/숨기기", onclick: () => {
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    eye.textContent = show ? "숨김" : "보기";
  } }, "보기");
  return Object.assign(h("div", { class: "pwbox" }, inp, eye), { input: inp });
}

// 새 비밀번호를 두 번 입력받는 창. 서로 같고 8자 이상이면 문자열, 취소하면 null
export function promptPassword(title) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); resolve(v); };
    const p1 = passwordField("새 비밀번호 (8자 이상)", { autocomplete: "new-password" });
    const p2 = passwordField("새 비밀번호 한 번 더", { autocomplete: "new-password" });
    const hint = h("p", { class: "hint" }, "");
    const check = () => {
      hint.textContent = !p2.input.value ? "" : p1.input.value === p2.input.value ? "✓ 서로 같아요" : "✕ 서로 달라요";
      hint.className = "hint " + (p1.input.value === p2.input.value ? "ok-text" : "err");
    };
    p1.input.addEventListener("input", check); p2.input.addEventListener("input", check);
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, title), p1, p2, hint,
        h("button", { class: "btn primary", onclick: () => {
          if (p1.input.value.length < 8) { toast("8자 이상 입력해 주세요"); return; }
          if (p1.input.value !== p2.input.value) { toast("두 비밀번호가 서로 달라요"); return; }
          close(p1.input.value);
        } }, "변경"),
        h("button", { class: "btn ghost", onclick: () => close(null) }, "취소")));
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
        h("h2", null, title), content,
        h("button", { class: "btn primary", onclick: () => close(true) }, okLabel),
        h("button", { class: "btn ghost", onclick: () => close(false) }, cancelLabel)));
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
  const el = h("input", { type: "text", inputmode: "numeric", maxlength: "5", placeholder: "00:00", class: "inp time", "aria-label": "출근시간", autocomplete: "off" });
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
