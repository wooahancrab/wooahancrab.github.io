// 현재 위치 한 번 읽기 (출퇴근 버튼을 누른 순간에만 사용)
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(Object.assign(new Error("이 기기는 위치 기능을 지원하지 않아요"), { code: "unsupported" }));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => {
        const msg = e.code === 1 ? "위치 권한이 꺼져 있어요. 휴대폰 설정에서 이 앱의 위치를 '허용'으로 바꿔 주세요"
          : e.code === 3 ? "위치를 찾는 데 시간이 너무 오래 걸려요. 창가에서 다시 눌러 주세요"
          : "위치를 확인하지 못했어요";
        reject(Object.assign(new Error(msg), { code: e.code === 1 ? "denied" : "no_location" }));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
