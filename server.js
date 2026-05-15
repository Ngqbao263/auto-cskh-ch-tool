/**
 * server.js
 * =========
 * Express backend — phục vụ Master Form UI và điều phối automation.
 *
 * CSKH   → Direct DB Insert vào Supabase (cskh-db-handler.js) — không dùng browser
 * Viettel → Playwright automation (cauhinh-handler.js) — vẫn dùng browser
 *
 * Khởi động: node server.js
 * Truy cập:  http://localhost:3000
 */

"use strict";

require("dotenv").config(); // Load .env sớm nhất có thể

const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const { createClient } = require("@supabase/supabase-js");
const { insertCSKH } = require("./automation/cskh-db-handler"); // DB insert
const { runCauhinh } = require("./automation/cauhinh-handler"); // Playwright

// Supabase client dùng cho các API nhẹ (search, lookup) — không phải automation
const _supabaseUrl = (process.env.SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/, "")
  .replace(/\/$/, "");
const _supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase =
  _supabaseUrl && _supabaseKey
    ? createClient(_supabaseUrl, _supabaseKey, {
        auth: { persistSession: false },
      })
    : null;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — Chỉnh tại đây, không cần sửa code bên dưới
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  port: 3000,
  headless: true, // false = thấy browser (dễ debug); true = chạy ẩn
  slowMo: 60, // ms delay giữa các action Playwright
  run_mode: "parallel", // 'parallel' | 'sequential'
  logs_dir: path.resolve(__dirname, "logs/runs"),
  errors_dir: path.resolve(__dirname, "logs/errors"),
  request_timeout: 180_000, // 3 phút timeout cho toàn bộ automation

  // ── TEST MODE (độc lập từng hệ thống) ────────────────────────────────────
  // cskh:    false → Ghi thật vào Supabase DB
  //          true  → Dry-run: in payload ra console, KHÔNG insert
  // cauhinh: false → Playwright click Lưu từng form, lưu vào Viettel DB
  //          true  → Playwright điền form nhưng KHÔNG click Lưu, gọi page.pause()
  //                  Browser luôn hiện khi cauhinh test_mode = true
  // ──────────────────────────────────────────────────────────────────────────
  test_mode: {
    cskh: true, // false = Chạy thật (Ghi vào Supabase)
    cauhinh: true, // true  = Chạy nháp (Không click Lưu Viettel)
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

fs.mkdirSync(CONFIG.logs_dir, { recursive: true });
fs.mkdirSync(CONFIG.errors_dir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Lưu log chạy ra file JSON
// ─────────────────────────────────────────────────────────────────────────────
function saveRunLog(masterData, results, totalDuration) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `run_${timestamp}.json`;
  const filepath = path.join(CONFIG.logs_dir, filename);

  const logEntry = {
    timestamp: new Date().toISOString(),
    run_mode: CONFIG.run_mode,
    test_mode: CONFIG.test_mode, // { cskh: bool, cauhinh: bool }
    total_duration_ms: totalDuration,
    input: {
      ship_code: masterData.ship_code,
      serial_number: masterData.serial_number,
      owner_name: masterData.owner_name,
    },
    results,
  };

  try {
    fs.writeFileSync(filepath, JSON.stringify(logEntry, null, 2), "utf8");
    return filename;
  } catch (err) {
    console.error(`⚠️  Không thể lưu log: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Validate masterData tối thiểu
// ─────────────────────────────────────────────────────────────────────────────
function validateMasterData(data) {
  const REQUIRED = [
    "ship_code",
    "serial_number",
    "owner_name",
    "owner_phone",
    "owner_cccd",
    "so_thang",
  ];
  return REQUIRED.filter((k) => {
    const v = data[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Format kết quả từ Promise.allSettled
// ─────────────────────────────────────────────────────────────────────────────
function formatSettledResult(settledResult, label) {
  if (settledResult.status === "fulfilled") {
    const val = settledResult.value ?? {};
    const isTest = val.test_mode ?? false;
    // Hiển thị connection_id + payment_id nếu có (từ RPC create_connection_record)
    const extra = val.inserted_id
      ? `  (Connection ID: ${val.inserted_id}${
          val.payment_id ? ` | Payment ID: ${val.payment_id}` : ""
        })`
      : "";
    return {
      success: true,
      duration_ms: val.duration_ms ?? null,
      test_mode: isTest,
      inserted_id: val.inserted_id ?? undefined,
      payment_id: val.payment_id ?? undefined,
      message: isTest
        ? `${label} hoàn tất (TEST MODE — chưa lưu DB thật).`
        : `${label} hoàn tất thành công.${extra}`,
    };
  }
  return {
    success: false,
    error: settledResult.reason?.message ?? "Lỗi không xác định.",
    message: `${label} thất bại.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/login
// Xác thực người dùng qua Supabase Auth.
// Nhận { username, password } — tự ghép domain thành email đầy đủ.
// ─────────────────────────────────────────────────────────────────────────────
const LOGIN_DOMAIN = process.env.LOGIN_DOMAIN || "@sdvico.local";

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password." });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }

  const email = username.includes("@") ? username : username + LOGIN_DOMAIN;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      console.warn(`[login] Thất bại cho "${username}": ${error.message}`);
      return res
        .status(401)
        .json({ error: "Tên đăng nhập hoặc mật khẩu không đúng." });
    }
    const id = data.user?.id ?? null;
    console.log(`[login] ✅ "${username}" đăng nhập thành công — id: ${id}`);
    return res.json({ id, username });
  } catch (err) {
    console.error(`[login] Lỗi server: ${err.message}`);
    return res.status(500).json({ error: "Lỗi server nội bộ." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-account?q=...
// Tìm kiếm tương đối trong bảng account theo tên (ilike), trả về name + phone
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-account", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("accounts")
      .select("name, phone")
      .ilike("name", `%${q}%`)
      .limit(10);
    if (error) throw error;
    res.json({ results: data ?? [] });
  } catch (err) {
    console.error(`[search-account] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-ship?q=...
// Tìm kiếm tương đối trong bảng vnf_data theo cột so_dang_ky (ilike), trả về mảng mã tàu
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-ship", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("vnf_data")
      .select("so_dang_ky")
      .ilike("so_dang_ky", `%${q}%`)
      .limit(10);
    if (error) throw error;
    const results = (data ?? []).map((r) => r.so_dang_ky).filter(Boolean);
    res.json({ results });
  } catch (err) {
    console.error(`[search-ship] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-serial?q=...
// Tìm kiếm tương đối trong bảng order_item_serials theo cột serial_number (ilike)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-serial", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("order_item_serials")
      .select("serial_number")
      .ilike("serial_number", `%${q}%`)
      .limit(10);
    if (error) throw error;
    const results = (data ?? []).map((r) => r.serial_number).filter(Boolean);
    res.json({ results });
  } catch (err) {
    console.error(`[search-serial] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/run-automation
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/run-automation", async (req, res) => {
  console.log(
    `\n>>> [API] POST /api/run-automation nhận được — ${new Date().toLocaleTimeString(
      "vi-VN"
    )}`
  );
  const startTime = Date.now();
  const masterData = req.body?.masterData;

  if (!masterData || typeof masterData !== "object") {
    return res.status(400).json({
      success: false,
      error: 'Request body phải có dạng: { "masterData": { ... } }',
    });
  }

  const missingFields = validateMasterData(masterData);
  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Thiếu các trường bắt buộc: ${missingFields.join(", ")}`,
      missing: missingFields,
    });
  }

  console.log("\n" + "═".repeat(60));
  console.log(`📨 [API] Nhận request — ${new Date().toLocaleString("vi-VN")}`);
  console.log(
    `   Tàu: ${masterData.ship_code} | Serial: ${masterData.serial_number}`
  );
  console.log(
    `   Chủ tàu: ${masterData.owner_name} | Chế độ: ${CONFIG.run_mode}`
  );

  // ── Trích test mode từng hệ thống ────────────────────────────────────────
  const testModeCskh = CONFIG.test_mode.cskh;
  const testModeCauhinh = CONFIG.test_mode.cauhinh;

  // ── Log trạng thái test mode ──────────────────────────────────────────────
  console.log(
    `   CSKH:     ${
      testModeCskh
        ? "🧪 TEST (dry-run, không insert DB)"
        : "🟢 THẬT (ghi vào Supabase)"
    }`
  );
  console.log(
    `   Cấu hình: ${
      testModeCauhinh
        ? "🧪 TEST (không click Lưu Viettel)"
        : "🟢 THẬT (lưu vào Viettel DB)"
    }`
  );
  console.log("═".repeat(60));

  // ── Khởi tạo browser (chỉ dùng cho Viettel — CSKH dùng DB trực tiếp) ─────
  // Browser luôn hiện khi Viettel đang ở test mode để quan sát
  const effectiveHeadless = testModeCauhinh ? false : CONFIG.headless;

  let browser;
  try {
    browser = await chromium.launch({
      headless: effectiveHeadless,
      slowMo: CONFIG.slowMo,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    console.log(
      `\n🌐 Browser khởi động (headless=${effectiveHeadless}) — dùng cho Viettel`
    );
  } catch (err) {
    console.error("❌ Không thể khởi động Playwright:", err.message);
    return res.status(500).json({
      success: false,
      error: `Không thể khởi động browser: ${err.message}`,
    });
  }

  let results;

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "vi-VN",
      timezoneId: "Asia/Ho_Chi_Minh",
    });
    // 30s per action — đủ cho Viettel xử lý mỗi bước mà không treo quá lâu khi lỗi.
    // (CONFIG.request_timeout = 3 phút quá lớn → bot đứng 3 phút mỗi khi bị kẹt)
    context.setDefaultTimeout(30_000);

    // CSKH: DB insert — không cần tab riêng
    // Viettel: Playwright — 1 tab
    const pageCauhinh = await context.newPage();
    console.log(
      `\n📑 Đã tạo 1 tab Playwright (Viettel). CSKH → Supabase trực tiếp.`
    );

    if (CONFIG.run_mode === "parallel") {
      console.log(
        `\n⚡ Chế độ SONG SONG: CSKH (DB) và Cấu hình (Playwright) chạy đồng thời\n`
      );
      const [cskhResult, cauhinhResult] = await Promise.allSettled([
        insertCSKH(masterData, testModeCskh), // DB insert — test mode riêng
        runCauhinh(pageCauhinh, masterData, testModeCauhinh), // Playwright — test mode riêng
      ]);
      results = {
        cskh: formatSettledResult(cskhResult, "CSKH"),
        cauhinh: formatSettledResult(cauhinhResult, "Cấu hình"),
      };
    } else {
      console.log(
        `\n🔁 Chế độ TUẦN TỰ: CSKH (DB) trước → Cấu hình (Playwright) sau\n`
      );
      const [cskhSettled] = await Promise.allSettled([
        insertCSKH(masterData, testModeCskh),
      ]);
      const [cauhinhSettled] = await Promise.allSettled([
        runCauhinh(pageCauhinh, masterData, testModeCauhinh),
      ]);
      results = {
        cskh: formatSettledResult(cskhSettled, "CSKH"),
        cauhinh: formatSettledResult(cauhinhSettled, "Cấu hình"),
      };
    }
  } catch (err) {
    console.error("❌ Lỗi không mong muốn:", err.message);
    results = {
      cskh: { success: false, error: "Lỗi hệ thống: " + err.message },
      cauhinh: { success: false, error: "Lỗi hệ thống: " + err.message },
    };
  } finally {
    if (browser) {
      await browser.close();
      console.log("\n🔒 Browser đã đóng.");
    }
  }

  const totalDuration = Date.now() - startTime;
  const overallSuccess = results.cskh.success && results.cauhinh.success;
  const logFile = saveRunLog(masterData, results, totalDuration);

  console.log("\n" + "═".repeat(60));
  const testSuffix = [
    testModeCskh ? "CSKH🧪" : "",
    testModeCauhinh ? "Viettel🧪" : "",
  ]
    .filter(Boolean)
    .join(" ");
  console.log(
    `${overallSuccess ? "✅" : "⚠️ "} [API] Kết thúc — ${(
      totalDuration / 1000
    ).toFixed(1)}s${testSuffix ? `  [TEST: ${testSuffix}]` : ""}`
  );
  console.log(
    `   CSKH:     ${
      results.cskh.success ? "✅ OK" : "❌ " + results.cskh.error
    }`
  );
  console.log(
    `   Cấu hình: ${
      results.cauhinh.success ? "✅ OK" : "❌ " + results.cauhinh.error
    }`
  );
  if (logFile) console.log(`   Log: logs/runs/${logFile}`);
  console.log("═".repeat(60) + "\n");

  res.json({
    success: overallSuccess,
    test_mode: CONFIG.test_mode, // { cskh: bool, cauhinh: bool }
    results,
    total_duration_ms: totalDuration,
    log_file: logFile,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/logs
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/logs", (_req, res) => {
  try {
    const files = fs
      .readdirSync(CONFIG.logs_dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 20);

    const logs = files.map((filename) => {
      try {
        const content = JSON.parse(
          fs.readFileSync(path.join(CONFIG.logs_dir, filename), "utf8")
        );
        return { filename, ...content };
      } catch {
        return { filename, error: "Không đọc được file" };
      }
    });

    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/config — Trả về config hiện tại (để frontend hiển thị badge)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    test_mode: CONFIG.test_mode,
    run_mode: CONFIG.run_mode,
    headless: CONFIG.headless,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK SPA
// ─────────────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(CONFIG.port, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║         AUTO ENTRY — MASTER CONTROL           ║
╠═══════════════════════════════════════════════╣
║  🌐  http://localhost:${CONFIG.port}                   ║
║  🤖  Chế độ:  ${
    CONFIG.run_mode === "parallel"
      ? "Song song (CSKH + Cấu hình)  "
      : "Tuần tự (CSKH → Cấu hình)  "
  }  ║
║  👁️   Browser: ${
    CONFIG.headless && !CONFIG.test_mode.cauhinh
      ? "Ẩn (headless)              "
      : "Hiện (có thể thấy thao tác)"
  }  ║
║  📁  Logs:    ./logs/runs/                    ║
║  🗄️   CSKH:   ${
    CONFIG.test_mode.cskh
      ? "🧪 TEST — Không ghi Supabase  "
      : "🟢 THẬT — Ghi vào Supabase    "
  }  ║
║  🤖  Viettel: ${
    CONFIG.test_mode.cauhinh
      ? "🧪 TEST — Không click Lưu    "
      : "🟢 THẬT — Lưu vào Viettel DB "
  }  ║
╚═══════════════════════════════════════════════╝
${
  CONFIG.test_mode.cauhinh
    ? "\n  ⚠️  VIETTEL TEST MODE: Bot không click Lưu, gọi page.pause().\n"
    : ""
}${
    CONFIG.test_mode.cskh
      ? "  ⚠️  CSKH TEST MODE: Dry-run, không insert vào Supabase.\n"
      : ""
  }
  Nhấn Ctrl+C để dừng server.
`);

  // Timeout 5 phút cho mỗi request — tránh connection treo mãi
  // (lớn hơn request_timeout automation 3 phút để server luôn kịp gửi response)
  server.setTimeout(5 * 60 * 1000);
});
