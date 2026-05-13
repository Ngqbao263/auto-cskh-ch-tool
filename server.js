/**
 * server.js
 * =========
 * Express backend — phục vụ Master Form UI và điều phối Playwright automation.
 *
 * Khởi động: node server.js
 * Truy cập:  http://localhost:3000
 */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const { runCSKH } = require("./automation/cskh-handler");
const { runCauhinh } = require("./automation/cauhinh-handler");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — Chỉnh tại đây, không cần sửa code bên dưới
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  port: 3000,
  headless: false, // false = thấy browser (dễ debug); true = chạy ẩn
  slowMo: 60, // ms delay giữa các action Playwright
  run_mode: "parallel", // 'parallel' | 'sequential'
  logs_dir: path.resolve(__dirname, "logs/runs"),
  errors_dir: path.resolve(__dirname, "logs/errors"),
  request_timeout: 180_000, // 3 phút timeout cho toàn bộ automation

  // ── TEST MODE ──────────────────────────────────────────────────────────────
  // true  → Bot điền đầy đủ nhưng KHÔNG bấm Submit cuối / Lưu form cuối.
  //         Gọi page.pause() để bạn kiểm tra giao diện bằng mắt trước khi thoát.
  //         Browser luôn hiện (headless bị override thành false).
  // false → Chạy thật, bấm Submit và lưu dữ liệu vào hệ thống.
  // ──────────────────────────────────────────────────────────────────────────
  test_mode: true,
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
    test_mode: CONFIG.test_mode, // Ghi rõ vào log để phân biệt test vs thật
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
    const isTest = settledResult.value?.test_mode ?? false;
    return {
      success: true,
      duration_ms: settledResult.value?.duration_ms ?? null,
      test_mode: isTest,
      message: isTest
        ? `${label} điền xong (TEST MODE — chưa submit, chưa lưu DB).`
        : `${label} hoàn tất thành công.`,
    };
  }
  return {
    success: false,
    error: settledResult.reason?.message ?? "Lỗi không xác định.",
    message: `${label} thất bại.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/run-automation
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/run-automation", async (req, res) => {
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

  // ── Cảnh báo nổi bật khi Test Mode đang bật ──────────────────────────────
  if (CONFIG.test_mode) {
    console.log("\n" + "  ⚠️ ".repeat(15));
    console.log("  🧪 TEST MODE BẬT — Bot sẽ KHÔNG submit / lưu dữ liệu thật!");
    console.log(
      "  🧪 Chuyển sang chạy thật: đặt test_mode: false trong CONFIG."
    );
    console.log("  ⚠️ ".repeat(15) + "\n");
  }
  console.log("═".repeat(60));

  // ── Khởi tạo browser ─────────────────────────────────────────────────────
  // Test mode luôn override headless=false để người dùng thấy kết quả
  const effectiveHeadless = CONFIG.test_mode ? false : CONFIG.headless;

  let browser;
  try {
    browser = await chromium.launch({
      headless: effectiveHeadless,
      slowMo: CONFIG.slowMo,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    console.log(`\n🌐 Browser khởi động (headless=${effectiveHeadless})`);
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
    context.setDefaultTimeout(CONFIG.request_timeout);

    const pageCSKH = await context.newPage();
    const pageCauhinh = await context.newPage();
    console.log(`\n📑 Đã tạo 2 tabs: CSKH và Cấu hình`);

    // ── Truyền testMode vào cả 2 handler như tham số thứ 3 ──────────────────
    const testMode = CONFIG.test_mode;

    if (CONFIG.run_mode === "parallel") {
      console.log(`\n⚡ Chế độ SONG SONG: Chạy CSKH và Cấu hình đồng thời\n`);
      const [cskhResult, cauhinhResult] = await Promise.allSettled([
        runCSKH(pageCSKH, masterData, testMode),
        runCauhinh(pageCauhinh, masterData, testMode),
      ]);
      results = {
        cskh: formatSettledResult(cskhResult, "CSKH"),
        cauhinh: formatSettledResult(cauhinhResult, "Cấu hình"),
      };
    } else {
      console.log(`\n🔁 Chế độ TUẦN TỰ: CSKH trước → Cấu hình sau\n`);
      const cskhSettled = await Promise.allSettled([
        runCSKH(pageCSKH, masterData, testMode),
      ]);
      const cauhinhSettled = await Promise.allSettled([
        runCauhinh(pageCauhinh, masterData, testMode),
      ]);
      results = {
        cskh: formatSettledResult(cskhSettled[0], "CSKH"),
        cauhinh: formatSettledResult(cauhinhSettled[0], "Cấu hình"),
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
  console.log(
    `${overallSuccess ? "✅" : "⚠️ "} [API] Kết thúc — ${(
      totalDuration / 1000
    ).toFixed(1)}s${CONFIG.test_mode ? " 🧪 TEST" : ""}`
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
    test_mode: CONFIG.test_mode,
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
app.listen(CONFIG.port, () => {
  console.clear();
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
    CONFIG.headless && !CONFIG.test_mode
      ? "Ẩn (headless)              "
      : "Hiện (có thể thấy thao tác)"
  }  ║
║  📁  Logs:    ./logs/runs/                    ║
║  🧪  Test:    ${
    CONFIG.test_mode
      ? "BẬT  — Không submit thật      "
      : "TẮT  — Chạy thật, lưu DB      "
  }  ║
╚═══════════════════════════════════════════════╝
${
  CONFIG.test_mode
    ? "\n  ⚠️  TEST MODE BẬT: Bot sẽ dừng trước khi Submit.\n  ⚠️  Đặt test_mode: false trong CONFIG để chạy thật.\n"
    : ""
}
  Nhấn Ctrl+C để dừng server.
`);
});
