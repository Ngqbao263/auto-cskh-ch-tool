/**
 * worker.js
 * =========
 * "Worker mode" — chạy nền trong exe trên máy có SFive. Nhận job remote từ
 * Supabase (do hub/điện thoại tạo), chạy automation, đẩy captcha & kết quả về.
 *
 * Tái dùng nguyên orchestrator runAutomation + handler BCCS/Viettel/CSKH.
 * Điểm khác duy nhất so với luồng HTTP: captcha đi qua Supabase (captcha-supabase)
 * thay vì cầu nối localhost.
 *
 * Kích hoạt: đặt WORKER_ENABLED=true trong .env. server.js gọi start(deps).
 */

"use strict";

const path = require("path");
const fs = require("fs");

const { runAutomation } = require("./run-automation");
const { makeSupabaseCaptcha } = require("./captcha-supabase");
const { makeSupabaseBilling } = require("./billing-supabase");

const BUCKET = "automation-docs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabase  service-role client
 * @param {object} deps.config      { headless, slowMo, run_mode }
 * @param {object} deps.testMode    { cskh, cauhinh, bccs }
 * @param {string} deps.machineId
 * @param {string} deps.uploadsDir  thư mục lưu file tải về
 * @param {string} [deps.label]
 * @param {number} [deps.pollMs=3000]
 * @param {number} [deps.heartbeatMs=15000]
 * @param {number} [deps.staleMinutes=15]
 */
function start(deps) {
  const {
    supabase,
    config,
    testMode,
    machineId,
    uploadsDir,
    label = machineId,
    pollMs = 3000,
    heartbeatMs = 15000,
    staleMinutes = 15,
  } = deps;

  if (!supabase) {
    console.error("❌ [worker] Thiếu Supabase client (SUPABASE_URL / SERVICE_ROLE_KEY). Worker không chạy.");
    return;
  }
  fs.mkdirSync(uploadsDir, { recursive: true });

  console.log("\n" + "═".repeat(60));
  console.log(`🤖 [worker] Bật WORKER MODE — máy: ${machineId}`);
  console.log(`   Poll job mỗi ${pollMs / 1000}s • heartbeat ${heartbeatMs / 1000}s`);
  console.log("═".repeat(60) + "\n");

  let busyJobId = null;
  let stopped = false;

  // ── Heartbeat: để điện thoại biết máy online ───────────────────────────────
  async function heartbeat() {
    try {
      await supabase.from("automation_workers").upsert({
        worker_id: machineId,
        label,
        busy_job_id: busyJobId,
        last_seen: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`  ⚠️  [worker] heartbeat lỗi: ${err.message}`);
    }
  }

  // ── Tải ảnh giấy tờ từ Storage về máy ──────────────────────────────────────
  async function downloadDocs(job) {
    const docPaths = job.doc_paths || {};
    const localByField = {};
    const downloaded = [];
    for (const [field, storagePath] of Object.entries(docPaths)) {
      if (!storagePath) continue;
      try {
        const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
        if (error) throw error;
        const buf = Buffer.from(await data.arrayBuffer());
        const localPath = path.join(uploadsDir, `${job.id}_${field}_${path.basename(storagePath)}`);
        fs.writeFileSync(localPath, buf);
        localByField[field] = localPath;
        downloaded.push(localPath);
      } catch (err) {
        console.warn(`  ⚠️  [worker] Không tải được ${field} (${storagePath}): ${err.message}`);
        localByField[field] = null;
      }
    }
    return { localByField, downloaded };
  }

  // ── Dọn dẹp: xoá file tạm + xoá thư mục Storage của job ────────────────────
  async function cleanup(job, localFiles) {
    localFiles.forEach((p) => {
      try { fs.unlinkSync(p); } catch { /* bỏ qua */ }
    });
    const paths = Object.values(job.doc_paths || {}).filter(Boolean);
    if (paths.length) {
      try {
        await supabase.storage.from(BUCKET).remove(paths);
      } catch (err) {
        console.warn(`  ⚠️  [worker] Không xoá được ảnh Storage: ${err.message}`);
      }
    }
  }

  // ── Xử lý 1 job ────────────────────────────────────────────────────────────
  async function processJob(job) {
    console.log(`\n▶️  [worker] Nhận job ${job.id} — tàu ${job.master_data?.ship_code}`);
    busyJobId = job.id;
    await heartbeat();

    const { localByField, downloaded } = await downloadDocs(job);
    const masterData = { ...job.master_data, ...localByField };

    try {
      const outcome = await runAutomation(masterData, {
        config,
        testMode,
        captcha: makeSupabaseCaptcha(supabase, job.id, { pollMs }),
        billing: makeSupabaseBilling(supabase, job.id, { pollMs }),
      });

      // Nếu user đã HỦY giữa chừng (status='error') → giữ nguyên, không ghi đè 'done'.
      let cancelled = false;
      try {
        const { data: cur } = await supabase
          .from("automation_jobs")
          .select("status")
          .eq("id", job.id)
          .maybeSingle();
        cancelled = cur && cur.status === "error";
      } catch { /* bỏ qua */ }

      if (cancelled) {
        console.log(`🛑 [worker] Job ${job.id} đã bị hủy — không ghi kết quả.`);
      } else {
        // Luồng nào trả success:false → đánh dấu CẢ job là 'error' + gắn câu lỗi,
        // để hub hiện "Lỗi" + banner đỏ (vẫn giữ result để xem chi tiết từng luồng).
        const flows = outcome.results || {};
        const failed = Object.entries(flows)
          .filter(([, r]) => r && r.success === false)
          .map(([key, r]) => r.error || r.message || `${key} lỗi`);

        if (failed.length) {
          await supabase
            .from("automation_jobs")
            .update({ status: "error", result: outcome.results, error: failed.join(" | ") })
            .eq("id", job.id);
          console.warn(`⚠️  [worker] Job ${job.id} có luồng lỗi: ${failed.join(" | ")}`);
        } else {
          await supabase
            .from("automation_jobs")
            .update({ status: "done", result: outcome.results, error: null })
            .eq("id", job.id);
          console.log(`✅ [worker] Job ${job.id} hoàn tất.`);
        }
      }
    } catch (err) {
      console.error(`❌ [worker] Job ${job.id} lỗi: ${err.message}`);
      await supabase
        .from("automation_jobs")
        .update({ status: "error", error: err.message })
        .eq("id", job.id);
    } finally {
      await cleanup(job, downloaded);
      busyJobId = null;
      await heartbeat();
    }
  }

  // ── Vòng lặp chính: claim job ──────────────────────────────────────────────
  async function claimLoop() {
    while (!stopped) {
      try {
        const { data, error } = await supabase.rpc("claim_next_job", { p_worker: machineId });
        if (error) {
          console.warn(`  ⚠️  [worker] claim lỗi: ${error.message}`);
          await sleep(pollMs);
          continue;
        }
        // RPC trả 1 hàng (object) hoặc null khi hết job.
        const job = Array.isArray(data) ? data[0] : data;
        if (!job || !job.id) {
          await sleep(pollMs);
          continue;
        }
        await processJob(job);
      } catch (err) {
        console.warn(`  ⚠️  [worker] Vòng claim lỗi: ${err.message}`);
        await sleep(pollMs);
      }
    }
  }

  // ── Dọn job treo định kỳ (mỗi ~1 phút) ─────────────────────────────────────
  async function staleLoop() {
    while (!stopped) {
      try {
        await supabase.rpc("requeue_stale_jobs", { p_minutes: staleMinutes });
      } catch (err) {
        console.warn(`  ⚠️  [worker] requeue_stale_jobs lỗi: ${err.message}`);
      }
      await sleep(60000);
    }
  }

  heartbeat();
  const hb = setInterval(heartbeat, heartbeatMs);
  claimLoop();
  staleLoop();

  return {
    stop() {
      stopped = true;
      clearInterval(hb);
    },
  };
}

module.exports = { start };
