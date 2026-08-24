/**
 * run-automation.js
 * =================
 * Orchestrator dùng chung cho 3 luồng (CSKH / Viettel Cấu hình / BCCS).
 *
 * Trước đây logic này nằm inline trong POST /api/run-automation (server.js).
 * Tách ra để CẢ HTTP endpoint (dùng trực tiếp trên PC) LẪN worker remote
 * (automation/worker.js) gọi CÙNG một hàm → không lệch hành vi.
 *
 * runAutomation(masterData, opts) chỉ lo:
 *   - quyết định luồng nào chạy (từ masterData.automation_options)
 *   - mở/đóng Chromium cho Viettel
 *   - chạy insertCSKH / runCauhinh / runBCCS (song song hoặc tuần tự)
 *   - format kết quả
 * KHÔNG lo file tạm / log / captcha bridge — đó là việc của caller.
 */

"use strict";

const { chromium } = require("playwright");
const { insertCSKH } = require("./cskh-db-handler");
const { runCauhinh } = require("./cauhinh-handler");
const { runBCCS } = require("./bccs-handler");

// ─────────────────────────────────────────────────────────────────────────────
// Format kết quả từ Promise.allSettled (giữ nguyên hành vi server.js cũ)
// ─────────────────────────────────────────────────────────────────────────────
function formatSettledResult(settledResult, label) {
  if (settledResult.status === "fulfilled") {
    const val = settledResult.value ?? {};
    if (val.success === false) {
      return {
        success: false,
        duration_ms: val.duration_ms ?? null,
        test_mode: val.test_mode ?? false,
        error: val.error || "Lỗi không xác định.",
        message: val.message || `${label} thất bại.`,
      };
    }
    const isTest = val.test_mode ?? false;
    const extra = val.inserted_id
      ? `  (Connection ID: ${val.inserted_id}${
          val.payment_id ? ` | Payment ID: ${val.payment_id}` : ""
        })`
      : "";
    return {
      success: true,
      duration_ms: val.duration_ms ?? null,
      test_mode: isTest,
      manual_handoff: val.manual_handoff ?? false,
      inserted_id: val.inserted_id ?? undefined,
      payment_id: val.payment_id ?? undefined,
      message:
        val.message ||
        (isTest
          ? `${label} hoàn tất (TEST MODE — chưa lưu DB thật).`
          : `${label} hoàn tất thành công.${extra}`),
    };
  }
  return {
    success: false,
    error: settledResult.reason?.message ?? "Lỗi không xác định.",
    message: `${label} thất bại.`,
  };
}

function formatSkippedResult(label) {
  return {
    success: true,
    skipped: true,
    duration_ms: null,
    message: `${label} đã bỏ qua theo lựa chọn người dùng.`,
  };
}

/**
 * Chạy toàn bộ automation cho một masterData.
 *
 * @param {object} masterData  Dữ liệu form (đã gắn sẵn file_* nếu có).
 * @param {object} opts
 * @param {object} opts.config     { headless, slowMo, run_mode }
 * @param {object} opts.testMode   { cskh, cauhinh, bccs }
 * @param {function} [opts.captcha] callback captcha cho BCCS:
 *        (imageDataUri, round) => Promise<{ action:'answer'|'reload'|'timeout'|'cancel', code? }>
 *        Bỏ trống → BCCS dùng cầu nối localhost mặc định (captcha-bridge).
 * @returns {Promise<{ results, ranNothing:boolean }>}
 */
async function runAutomation(masterData, opts = {}) {
  const {
    config = {},
    testMode = {},
    captcha = null,
    billing = null,
  } = opts;

  const headless = config.headless ?? false;
  const slowMo = config.slowMo ?? 60;
  const runMode = config.run_mode ?? "parallel";

  const testModeCskh = !!testMode.cskh;
  const testModeCauhinh = !!testMode.cauhinh;
  const testModeBccs = !!testMode.bccs;

  const automationOptions = masterData.automation_options || {};
  const runCskh =
    automationOptions.run_cskh !== undefined
      ? automationOptions.run_cskh !== false
      : automationOptions.run_main_flow !== false;
  const runViettel =
    automationOptions.run_cauhinh !== undefined
      ? automationOptions.run_cauhinh !== false
      : automationOptions.run_main_flow !== false;
  const runBccs = automationOptions.run_bccs !== false;

  const results = {
    cskh: runCskh ? null : formatSkippedResult("CSKH"),
    cauhinh: runViettel ? null : formatSkippedResult("Cấu hình Viettel"),
    bccs: runBccs ? null : formatSkippedResult("BCCS"),
  };

  if (!runCskh && !runViettel && !runBccs) {
    return { results, ranNothing: true };
  }

  console.log(
    `   CSKH:     ${testModeCskh ? "🧪 TEST (dry-run, không insert DB)" : "🟢 THẬT (ghi vào Supabase)"}`
  );
  console.log(
    `   Cấu hình: ${testModeCauhinh ? "🧪 TEST (không click Lưu Viettel)" : "🟢 THẬT (lưu vào Viettel DB)"}`
  );
  console.log(
    `   BCCS:     ${testModeBccs ? "🧪 TEST (không click Lưu BCCS)" : "🟢 THẬT (lưu vào BCCS)"}`
  );
  console.log(
    `   Luồng bật: ${[runCskh ? "CSKH" : "", runViettel ? "Viettel" : "", runBccs ? "BCCS" : ""]
      .filter(Boolean)
      .join(", ")}`
  );
  console.log("═".repeat(60));

  let browser;
  try {
    let pageCauhinh = null;
    let cauhinhInitError = null;

    if (runViettel) {
      const effectiveHeadless = testModeCauhinh ? false : headless;
      try {
        browser = await chromium.launch({
          headless: effectiveHeadless,
          slowMo,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        console.log(`\n🌐 Browser khởi động (headless=${effectiveHeadless}) — dùng cho Viettel`);

        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: "vi-VN",
          timezoneId: "Asia/Ho_Chi_Minh",
          ignoreHTTPSErrors: true,
        });
        context.setDefaultTimeout(30_000);
        pageCauhinh = await context.newPage();
        console.log(`\n📑 Đã tạo tab Playwright cho Viettel.`);
      } catch (err) {
        cauhinhInitError = err;
        results.cauhinh = {
          success: false,
          error: `Không thể khởi động browser Viettel: ${err.message}`,
          message: "Cấu hình thất bại.",
        };
        console.error("❌ Không thể khởi động Playwright cho Viettel:", err.message);
      }
    } else {
      console.log(`\n⏭️  Bỏ qua Viettel theo lựa chọn người dùng.`);
    }

    if (runMode === "parallel") {
      const tasks = [];
      if (runCskh) {
        tasks.push({ key: "cskh", label: "CSKH", fn: () => insertCSKH(masterData, testModeCskh) });
      }
      if (runViettel && !cauhinhInitError && pageCauhinh) {
        tasks.push({
          key: "cauhinh",
          label: "Cấu hình",
          fn: () => runCauhinh(pageCauhinh, masterData, testModeCauhinh),
        });
      }
      if (runBccs) {
        tasks.push({
          key: "bccs",
          label: "BCCS",
          fn: () => runBCCS(masterData, testModeBccs, { captcha, billing }),
        });
      }

      console.log(`\n⚡ Chế độ SONG SONG: chạy ${tasks.map((t) => t.label).join(" + ")}\n`);
      const settled = await Promise.allSettled(tasks.map((task) => task.fn()));
      settled.forEach((settledResult, index) => {
        const task = tasks[index];
        results[task.key] = formatSettledResult(settledResult, task.label);
      });
    } else {
      console.log(`\n🔁 Chế độ TUẦN TỰ theo các luồng đã bật\n`);
      if (runCskh) {
        const [cskhSettled] = await Promise.allSettled([insertCSKH(masterData, testModeCskh)]);
        results.cskh = formatSettledResult(cskhSettled, "CSKH");
      }
      if (runViettel && !cauhinhInitError && pageCauhinh) {
        const [cauhinhSettled] = await Promise.allSettled([
          runCauhinh(pageCauhinh, masterData, testModeCauhinh),
        ]);
        results.cauhinh = formatSettledResult(cauhinhSettled, "Cấu hình");
      }
      if (runBccs) {
        const [bccsSettled] = await Promise.allSettled([
          runBCCS(masterData, testModeBccs, { captcha, billing }),
        ]);
        results.bccs = formatSettledResult(bccsSettled, "BCCS");
      }
    }
  } catch (err) {
    console.error("❌ Lỗi không mong muốn:", err.message);
    results.cskh = runCskh
      ? { success: false, error: "Lỗi hệ thống: " + err.message, message: "CSKH thất bại." }
      : formatSkippedResult("CSKH");
    results.cauhinh = runViettel
      ? { success: false, error: "Lỗi hệ thống: " + err.message, message: "Cấu hình thất bại." }
      : formatSkippedResult("Cấu hình Viettel");
    results.bccs = runBccs
      ? { success: false, error: "Lỗi hệ thống: " + err.message, message: "BCCS thất bại." }
      : formatSkippedResult("BCCS");
  } finally {
    if (browser) {
      await browser.close();
      console.log("\n🔒 Browser đã đóng.");
    }
  }

  return { results, ranNothing: false };
}

module.exports = { runAutomation, formatSettledResult, formatSkippedResult };
