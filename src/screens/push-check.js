// 알림 점검: 폰에서 알림이 잘 오는지 단계별로 확인하고, 시험 알림을 보내 본다.
import { api } from "../lib/api.js";
import { h, toast } from "../lib/ui.js";

export async function openPushCheck() {
  const body = h("div", { class: "stack" });
  const ov = h("div", { class: "overlay" }, h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
    h("h2", null, "🔔 알림 점검"), body,
    h("button", { class: "btn ghost", onclick: () => ov.remove() }, "닫기")));
  document.body.append(ov);
  let busy = false;

  const row = (ok, text, hint) => h("div", { style: "margin:6px 0" },
    h("div", { class: ok ? "ok-text" : "err" }, (ok ? "✅ " : "❌ ") + text),
    !ok && hint && h("div", { class: "muted", style: "font-size:12px;margin-left:22px" }, hint));

  async function draw(testMsg) {
    body.replaceChildren(h("p", { class: "muted" }, "확인하는 중…"));
    const s = await api.pushStatus();
    const items = [];
    if (s.kakao) items.push(row(false, "카톡 안에서 열었어요", "카톡 안에서는 알림이 안 돼요. 크롬(안드로이드)이나 사파리(아이폰)로 열어 주세요."));
    if (s.ios && !s.standalone) items.push(row(false, "홈 화면에 추가한 앱이 아니에요", "아이폰은 사파리에서 공유(□↑) → 홈 화면에 추가 후, 그 아이콘으로 열어야 알림이 와요."));
    items.push(row(s.supported, "이 기기·브라우저가 알림을 지원해요", "지원하지 않는 브라우저예요. 크롬(안드로이드)이나 사파리(아이폰)를 쓰세요."));
    if (s.supported) {
      items.push(row(s.permission === "granted", s.permission === "denied" ? "알림이 차단돼 있어요" : "알림 허용이 필요해요",
        s.permission === "denied" ? "폰 설정 → 앱(또는 크롬) → 알림 허용으로 바꾼 뒤 다시 눌러 주세요." : "아래 [알림 켜기]를 눌러 허용해 주세요."));
      items.push(row(s.hasSub, "이 기기가 알림용으로 등록됐어요", "[알림 켜기]를 눌러 주세요."));
      items.push(row(s.saved, "서버에 이 기기가 저장돼 있어요", "[알림 켜기]를 다시 눌러 주세요(로그인한 계정에 연결돼요)."));
    }
    const ready = s.supported && s.permission === "granted" && s.hasSub && s.saved;
    const out = h("p", { class: testMsg?.err ? "err" : "ok-text" }, testMsg?.text ?? "");
    body.replaceChildren(...items, out,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" },
        s.supported && h("button", { class: "btn ghost slim", disabled: busy, onclick: async () => {
          busy = true;
          try { await api.enablePush(); toast("알림을 켰어요", 2000); } catch (e) { toast(e.message, 6000); }
          busy = false; draw();
        } }, s.hasSub ? "알림 다시 켜기" : "알림 켜기"),
        h("button", { class: "btn primary slim", disabled: !ready || busy, onclick: async () => {
          busy = true;
          try {
            const r = await api.pushTest();
            busy = false;
            draw({ text: r.sent > 0 ? `시험 알림을 ${r.sent}대에 보냈어요. 몇 초 안에 알림이 오면 정상이에요.` : "서버가 보낼 기기를 찾지 못했어요. [알림 다시 켜기]를 눌러 보세요.", err: !(r.sent > 0) });
          } catch (e) { busy = false; draw({ text: "시험 알림을 보내지 못했어요: " + e.message, err: true }); }
        } }, "시험 알림 보내기")),
      ready && h("p", { class: "muted", style: "font-size:12px" }, "시험 알림이 안 오면: 폰의 방해금지·절전 모드를 끄고, 크롬(또는 설치한 앱)의 알림이 켜져 있는지 확인하세요."));
  }
  await draw();
}
