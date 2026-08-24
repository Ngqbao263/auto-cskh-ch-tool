/**
 * scrape-vas-address.js
 * =====================
 * Quét toàn bộ Tỉnh → Huyện → Xã (mã VAS) từ F9 địa chỉ khách hàng của BCCS.
 *
 * Cơ chế (đã bắt từ Network):
 *   - List:   POST source = mainCustomertxtAdd{province|district|precinct}, param _query="" → bảng <data-item-value>=mã, tên.
 *   - Setter: POST source = j_idt323 (set mã tỉnh vào j_idt340, mã huyện vào j_idt352) → nạp cấp con phía server.
 *   Trình tự: list tỉnh → [set tỉnh → list huyện → [set huyện → list xã]].
 *
 * Chạy fetch NGAY TRONG trang SFive (qua CDP) nên tự dùng session đăng nhập.
 *
 * ĐIỀU KIỆN CHẠY:
 *   1. SFive đang mở (do tool bật, có --remote-debugging-port=9222) và ĐÃ đăng nhập BCCS.
 *   2. Đang ở trang đấu nối (stracking.jsf) và ĐÃ MỞ modal "Địa chỉ" của khách hàng
 *      (bấm vào ô Địa chỉ để modal tỉnh/huyện/xã hiện ra) — để các component tồn tại trong DOM.
 *
 * CHẠY:  node scripts/scrape-vas-address.js
 * KẾT QUẢ: data/vas-address.json
 *
 * Nếu id nội bộ đổi (j_idt###), sửa OBJECT `IDS` bên dưới cho khớp request đã bắt.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const CDP = require("chrome-remote-interface");

const CDP_PORT = 9222;
const OUT = path.resolve(__dirname, "..", "data", "vas-address.json");

// Prefix + id nội bộ (khớp request đã bắt). Chỉ sửa khi BCCS đổi j_idt.
const PREFIX = "connectForm:j_idt108:j_idt313:";
const IDS = {
  command: "j_idt323", // remoteCommand nạp cấp con
  provHidden: "j_idt340", // ô ẩn mã tỉnh
  precHidden: "j_idt364", // ô ẩn mã xã
  distHidden: "j_idt352", // ô ẩn mã huyện
  grpHidden: "j_idt375", // ô ẩn mã tổ/thôn
};

// Hàm chạy TRONG trang SFive — trả về { provinces:[{code,name,districts:[{code,name,wards:[{code,name}]}]}] }
function buildPageFn(PREFIX, IDS) {
  return `(async () => {
    const P = ${JSON.stringify(PREFIX)};
    const IDS = ${JSON.stringify(IDS)};
    const url = location.pathname;
    const vsEl = document.querySelector('input[name="javax.faces.ViewState"]');
    if (!vsEl) return { error: 'Không thấy ViewState — mở đúng trang đấu nối + modal địa chỉ.' };
    let viewState = vsEl.value;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function post(params) {
      const body = new URLSearchParams(params).toString();
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Faces-Request': 'partial/ajax',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      const text = await res.text();
      const vm = text.match(/javax\\.faces\\.ViewState:0"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/);
      if (vm) viewState = vm[1];
      return text;
    }

    function parseRows(xml) {
      const um = xml.match(/<update id="[^"]*mainCustomertxtAdd\\w*"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>/);
      if (!um) return [];
      const html = um[1];
      const rows = [...html.matchAll(/data-item-value="([^"]*)"[\\s\\S]*?<td><label[^>]*>([\\s\\S]*?)<\\/label><\\/td>\\s*<td><label[^>]*>([\\s\\S]*?)<\\/label>/g)];
      return rows.map(r => ({ code: r[1], name: r[3].replace(/\\s+/g, ' ').trim() }))
                 .filter(x => x.code && x.name);
    }

    function listParams(comp) {
      const c = P + comp;
      return {
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': c,
        'javax.faces.partial.execute': c,
        'javax.faces.partial.render': c,
        [c]: c,
        [c + '_query']: '',
        'topBarForm': 'topBarForm',
        'javax.faces.ViewState': viewState
      };
    }

    function setterParams(provCode, distCode) {
      const cmd = P + IDS.command;
      return {
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': cmd,
        'javax.faces.partial.execute': [cmd, P + IDS.provHidden, P + IDS.precHidden, P + IDS.distHidden, P + IDS.grpHidden].join(' '),
        [cmd]: cmd,
        [P + IDS.provHidden]: provCode,
        [P + IDS.precHidden]: '',
        [P + IDS.distHidden]: distCode || '',
        [P + IDS.grpHidden]: '',
        'javax.faces.ViewState': viewState
      };
    }

    const provinces = parseRows(await post(listParams('mainCustomertxtAddprovince')));
    if (!provinces.length) return { error: 'Không lấy được danh sách tỉnh — kiểm tra modal địa chỉ đã mở chưa.' };

    const out = { source: 'BCCS F9 mainCustomertxtAdd', provinces: [] };
    for (const prov of provinces) {
      const pj = { code: prov.code, name: prov.name, districts: [] };
      try {
        await post(setterParams(prov.code, ''));
        await sleep(50);
        const districts = parseRows(await post(listParams('mainCustomertxtAdddistrict')));
        for (const dist of districts) {
          const dj = { code: dist.code, name: dist.name, wards: [] };
          try {
            await post(setterParams(prov.code, dist.code));
            await sleep(50);
            dj.wards = parseRows(await post(listParams('mainCustomertxtAddprecinct')));
          } catch (e) { dj.error = String(e && e.message || e); }
          pj.districts.push(dj);
          await sleep(15);
        }
      } catch (e) { pj.error = String(e && e.message || e); }
      out.provinces.push(pj);
    }
    return out;
  })()`;
}

async function listTargets() {
  // localhost trên Windows hay ra IPv6 ::1 (SFive nghe 127.0.0.1) → thử 127.0.0.1 trước.
  const hosts = ["127.0.0.1", "localhost"];
  let lastErr;
  for (let attempt = 1; attempt <= 10; attempt++) {
    for (const host of hosts) {
      try {
        const targets = await CDP.List({ host, port: CDP_PORT });
        return { host, targets };
      } catch (e) {
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr || new Error("Không kết nối được CDP");
}

(async () => {
  let client;
  try {
    const { host, targets } = await listTargets();
    const page =
      targets.find((t) => t.type === "page" && /stracking\.jsf/i.test(t.url || "")) ||
      targets.find((t) => t.type === "page");
    if (!page) {
      console.error("❌ Không thấy tab nào trong SFive. Hãy mở BCCS + trang đấu nối + modal Địa chỉ.");
      process.exit(1);
    }
    console.log(`🔌 Kết nối CDP (${host}): ${page.url}`);
    client = await CDP({ host, port: CDP_PORT, target: page.webSocketDebuggerUrl });
    await client.Runtime.enable();

    console.log("⏳ Đang quét tỉnh → huyện → xã (vài phút)...");
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: buildPageFn(PREFIX, IDS),
      awaitPromise: true,
      returnByValue: true,
      timeout: 20 * 60 * 1000,
    });
    if (exceptionDetails) {
      console.error("❌ Lỗi trong trang:", JSON.stringify(exceptionDetails.exception || exceptionDetails));
      process.exit(1);
    }
    const data = result.value;
    if (data && data.error) {
      console.error("❌", data.error);
      process.exit(1);
    }

    fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
    const nProv = data.provinces.length;
    const nDist = data.provinces.reduce((s, p) => s + p.districts.length, 0);
    const nWard = data.provinces.reduce((s, p) => s + p.districts.reduce((a, d) => a + (d.wards ? d.wards.length : 0), 0), 0);
    console.log(`✅ Xong → ${OUT}`);
    console.log(`   Tỉnh: ${nProv} | Huyện: ${nDist} | Xã: ${nWard}`);
  } catch (err) {
    console.error("❌ Lỗi:", err.message);
    process.exit(1);
  } finally {
    if (client) await client.close();
  }
})();
