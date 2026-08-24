/**
 * load-vas-groups.js
 * ==================
 * Nạp Tổ/thôn (cấp 4) từ vas-address.json vào bảng Supabase public.vas_group_street.
 * Chạy 1 lần (trên máy có Node + internet + .env chứa SUPABASE_URL/SERVICE_ROLE_KEY).
 *
 * Dùng:  node scripts/load-vas-groups.js "D:/test tool/vas-address.json"
 *        (không truyền path thì mặc định "D:/test tool/vas-address.json")
 */

"use strict";

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

const SRC = process.argv[2] || "D:/test tool/vas-address.json";
const URL = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL || !KEY) {
  console.error("❌ Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env");
  process.exit(1);
}
const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

// Chuẩn hóa tiếng Việt (KHỚP normalizeVi bên hub).
function normalizeVi(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const JUNK = /^(dia ban|test)/i;

(async () => {
  console.log(`📖 Đọc ${SRC} ...`);
  const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const provinces = (data.provinces || []).filter((p) => p.name && p.name !== "Test KPI");

  // Gom + dedupe theo (province_key|district_key|ward_key|name)
  const seen = new Set();
  const rows = [];
  for (const p of provinces) {
    const pk = normalizeVi(p.name);
    for (const d of p.districts || []) {
      if (!d.name) continue;
      const dk = normalizeVi(d.name);
      for (const w of d.wards || []) {
        if (!w.name || JUNK.test(w.name)) continue;
        const wk = normalizeVi(w.name);
        for (const g of w.groupStreets || []) {
          if (!g.name || JUNK.test(g.name)) continue;
          const key = `${pk}|${dk}|${wk}|${g.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ province_key: pk, district_key: dk, ward_key: wk, name: g.name });
        }
      }
    }
  }
  console.log(`   Tổng ${rows.length} tổ/thôn (đã dedupe). Bắt đầu nạp...`);

  const BATCH = 1000;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("vas_group_street")
      .upsert(chunk, { onConflict: "province_key,district_key,ward_key,name", ignoreDuplicates: true });
    if (error) {
      console.error(`❌ Lỗi batch ${i}:`, error.message);
      process.exit(1);
    }
    done += chunk.length;
    if (done % 10000 < BATCH) console.log(`   ...đã nạp ${done}/${rows.length}`);
  }
  console.log(`✅ Xong — đã nạp ${done} tổ/thôn vào vas_group_street.`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
