/**
 * scrape-vas.js
 * =============
 * Quét Tỉnh → Huyện → Xã → Tổ/thôn (mã VAS) từ F9 địa chỉ khách hàng BCCS, qua CDP.
 * Chạy NGAY TRONG exe — gọi từ endpoint GET /api/scrape-vas-address.
 *
 * Quét THEO TỪNG TỈNH (mỗi tỉnh 1 lần Runtime.evaluate) → ghi đĩa dần sau mỗi tỉnh
 * (onProvince) nên mất kết nối giữa chừng KHÔNG mất hết.
 *
 * ĐIỀU KIỆN: SFive mở (cổng 9222, do job BCCS bật), đã đăng nhập, ở trang đấu nối,
 * ĐÃ mở modal "Địa chỉ" của khách hàng (component vào view).
 */

"use strict";

const CDP_PORT = 9222;
const PREFIX = "connectForm:j_idt108:j_idt313:";
const IDS = {
  command: "j_idt323",
  provHidden: "j_idt340",
  precHidden: "j_idt364", // ô ẩn mã XÃ
  distHidden: "j_idt352", // ô ẩn mã HUYỆN
  grpHidden: "j_idt375", // ô ẩn mã TỔ/THÔN
};

// Prelude JS (chạy trong trang): helper post/parse + tham số list/setter.
function prelude(P, IDS) {
  return `
    const P = ${JSON.stringify(P)};
    const IDS = ${JSON.stringify(IDS)};
    const url = location.pathname;
    const vsEl = document.querySelector('input[name="javax.faces.ViewState"]');
    if (!vsEl) throw new Error('Không thấy ViewState — mở modal địa chỉ trước.');
    let viewState = vsEl.value;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function post(params) {
      const body = new URLSearchParams(params).toString();
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) { // retry để chịu blip mạng
        try {
          const res = await fetch(url, { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest' }, body });
          const text = await res.text();
          const vm = text.match(/javax\\.faces\\.ViewState:0"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/);
          if (vm) viewState = vm[1];
          return text;
        } catch (e) { lastErr = e; await sleep(2000); }
      }
      throw lastErr;
    }
    function parseRows(xml) {
      const um = xml.match(/<update id="[^"]*mainCustomertxtAdd\\w*"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>/);
      if (!um) return [];
      const rows = [...um[1].matchAll(/data-item-value="([^"]*)"[\\s\\S]*?<td><label[^>]*>([\\s\\S]*?)<\\/label><\\/td>\\s*<td><label[^>]*>([\\s\\S]*?)<\\/label>/g)];
      return rows.map(r => ({ code: r[1], name: r[3].replace(/\\s+/g, ' ').trim() })).filter(x => x.code && x.name);
    }
    function listParams(comp) { const c = P + comp; return { 'javax.faces.partial.ajax': 'true', 'javax.faces.source': c, 'javax.faces.partial.execute': c, 'javax.faces.partial.render': c, [c]: c, [c + '_query']: '', 'topBarForm': 'topBarForm', 'javax.faces.ViewState': viewState }; }
    function setterParams(prov, dist, ward) { const cmd = P + IDS.command; return { 'javax.faces.partial.ajax': 'true', 'javax.faces.source': cmd, 'javax.faces.partial.execute': [cmd, P + IDS.provHidden, P + IDS.precHidden, P + IDS.distHidden, P + IDS.grpHidden].join(' '), [cmd]: cmd, [P + IDS.provHidden]: prov, [P + IDS.precHidden]: ward || '', [P + IDS.distHidden]: dist || '', [P + IDS.grpHidden]: '', 'javax.faces.ViewState': viewState }; }
  `;
}

// Lấy danh sách TỈNH.
function provinceListFn(P, IDS) {
  return `(async () => {
    ${prelude(P, IDS)}
    return parseRows(await post(listParams('mainCustomertxtAddprovince')));
  })()`;
}

// Quét 1 TỈNH: huyện → xã → tổ/thôn.
function provinceScrapeFn(P, IDS, provCode, provName) {
  return `(async () => {
    ${prelude(P, IDS)}
    const provCode = ${JSON.stringify(provCode)};
    const pj = { code: provCode, name: ${JSON.stringify(provName)}, districts: [] };
    await post(setterParams(provCode, '', '')); await sleep(40);
    const districts = parseRows(await post(listParams('mainCustomertxtAdddistrict')));
    for (const dist of districts) {
      const dj = { code: dist.code, name: dist.name, wards: [] };
      try {
        await post(setterParams(provCode, dist.code, '')); await sleep(40);
        const wards = parseRows(await post(listParams('mainCustomertxtAddprecinct')));
        for (const ward of wards) {
          const wj = { code: ward.code, name: ward.name, groupStreets: [] };
          try {
            await post(setterParams(provCode, dist.code, ward.code)); await sleep(25);
            wj.groupStreets = parseRows(await post(listParams('mainCustomertxtAddgroupStreet')));
          } catch (e) { wj.error = String(e && e.message || e); }
          dj.wards.push(wj);
        }
      } catch (e) { dj.error = String(e && e.message || e); }
      pj.districts.push(dj);
    }
    return pj;
  })()`;
}

/**
 * @param {object} [opts]
 * @param {(prov:object, index:number, total:number)=>void} [opts.onProvince] gọi sau mỗi tỉnh (ghi đĩa dần)
 * @param {number} [opts.port]
 */
async function scrapeVasAddress(opts = {}) {
  const port = opts.port || CDP_PORT;
  const CDP = require("chrome-remote-interface");
  let picked = null;
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const targets = await CDP.List({ host, port });
      const page =
        targets.find((t) => t.type === "page" && /stracking\.jsf/i.test(t.url || "")) ||
        targets.find((t) => t.type === "page");
      if (page) { picked = { host, page }; break; }
    } catch { /* thử host kế */ }
  }
  if (!picked) {
    throw new Error(`Không kết nối được SFive CDP (port ${port}). SFive đã mở qua tool chưa?`);
  }

  const client = await CDP({ host: picked.host, port, target: picked.page.webSocketDebuggerUrl });
  async function evalFn(expr, timeoutMs) {
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    });
    if (exceptionDetails) {
      throw new Error("Lỗi trong trang SFive: " + JSON.stringify(exceptionDetails.exception || exceptionDetails));
    }
    return result.value;
  }

  try {
    await client.Runtime.enable();
    const provinces = await evalFn(provinceListFn(PREFIX, IDS), 2 * 60 * 1000);
    if (!Array.isArray(provinces) || !provinces.length) {
      throw new Error("Không lấy được danh sách tỉnh — mở modal địa chỉ trước khi chạy.");
    }
    // RESUME: giữ các tỉnh đã quét (có huyện) từ lần trước, chỉ quét tỉnh còn thiếu.
    const existing = Array.isArray(opts.existing) ? opts.existing : [];
    const done = new Set(existing.filter((p) => p && p.districts && p.districts.length).map((p) => p.code));
    const out = { source: "BCCS F9 mainCustomertxtAdd (4 cấp)", provinces: existing.slice() };
    for (let i = 0; i < provinces.length; i++) {
      const prov = provinces[i];
      if (done.has(prov.code)) continue; // đã có → bỏ qua
      const pj = await evalFn(provinceScrapeFn(PREFIX, IDS, prov.code, prov.name), 15 * 60 * 1000);
      out.provinces.push(pj);
      if (opts.onProvince) opts.onProvince(out, i + 1, provinces.length);
    }
    return out;
  } finally {
    await client.close();
  }
}

module.exports = { scrapeVasAddress, CDP_PORT };
