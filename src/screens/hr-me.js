// 직원 화면의 작은 "내 보건증" 카드(4단계). 직원 본인은 자기 보건증 만료일만 보고 고칠 수는 없다(관리자에게 알려야 한다). 설계 7.4
// 서버에는 hr.myHealth() 하나만 부른다(서버 함수 hr_my_health 는 보건증 4개 값만 돌려준다). 급여·4대보험·계약서는 이 파일 어디에도 없다.
// 보건증이 필요한 직원('필요')에게만 보이고, 그 밖(해당 없음·미확인·행 없음·함수 없음·오류)에는 아무것도 그리지 않는다(높이 0, 토스트 없음, 콘솔에는 코드만).
// 사용: mountMyHealth(자리 요소, profile, { inline })  — 직원·매니저·중간관리자: main.js tabbedHome, 부대표·회장: 총괄 앱 홈(ceo.js). 대표(owner)는 마운트하지 않는다.
import { api } from "../lib/api.js";
import { h } from "../lib/ui.js";
import { t } from "../lib/i18n.js";
import { healthBadge, badgeText, daysLeft, hrLog } from "../lib/hr.js";

export async function mountMyHealth(host, profile, opts = {}) {
  if (!host || !profile || profile.role === "owner") return;
  let r = null;
  try {
    const hr = opts.hr || (await api.hr());
    r = await hr.myHealth();
  } catch (e) { hrLog(e); return; }
  if (!r || r.need !== "yes") return;
  const days = typeof r.days_left === "number" ? r.days_left : daysLeft(r.expires_on, r.today);
  const unset = !r.expires_on || typeof days !== "number";
  const badge = unset ? { ctx: "인사", text: "미등록", cls: "warn" } : healthBadge({ need: "yes", expires_on: r.expires_on, days_left: days });
  const note = unset ? t("만료일이 아직 등록되지 않았어요. 관리자에게 알려 주세요")
    : days < 0 ? `${t("만료됐어요")} · ${t("날짜를 바꾸려면 관리자에게 알려 주세요")}` : t("날짜를 바꾸려면 관리자에게 알려 주세요");
  host.classList.add("hr-me-host");
  if (opts.inline) host.classList.add("inline");
  host.replaceChildren(h("div", { class: "card hr-me" },
    h("div", { class: "hr-me-top" },
      h("b", null, h("span", { "aria-hidden": "true" }, "🩺 "), t("내 보건증")),
      unset ? null : h("span", { class: "num hr-me-date" }, r.expires_on),
      h("span", { class: "badge " + badge.cls }, badgeText(badge))),
    h("p", { class: "muted hr-me-note" }, note)));
}
