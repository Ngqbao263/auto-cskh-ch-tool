/**
 * captcha-supabase.js
 * ===================
 * Bản captcha callback cho WORKER MODE (remote qua Supabase).
 *
 * Cùng interface với cầu nối localhost (captcha-bridge) nhìn từ bccs-handler:
 *   captcha(imageDataUri, round) => Promise<{ action:'answer'|'reload'|'timeout'|'cancel', code? }>
 *
 * Luồng:
 *   - Worker (bccs-handler) chụp ảnh captcha → gọi captcha(image, round).
 *   - Ta ghi captcha_image + status='captcha_pending' lên job → điện thoại hiện ảnh.
 *   - Poll job đến khi điện thoại gọi RPC submit_captcha (status='captcha_submitted').
 *   - Trả { action, code } cho bccs-handler; đặt job về 'running' để vòng sau sạch.
 */

"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase  client service-role
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.pollMs=2500]   nhịp poll đọc đáp án
 * @param {number} [opts.timeoutMs=180000] tối đa chờ 1 lần captcha (3 phút)
 * @returns {(image:string, round:number)=>Promise<{action:string, code?:string}>}
 */
function makeSupabaseCaptcha(supabase, jobId, opts = {}) {
  const pollMs = opts.pollMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 180000;

  return async function captcha(image, round) {
    // 1) Đẩy ảnh captcha lên job → điện thoại hiện cho người nhập.
    const { error: upErr } = await supabase
      .from("automation_jobs")
      .update({
        captcha_image: image,
        captcha_round: round,
        captcha_answer: null,
        captcha_action: null,
        status: "captcha_pending",
      })
      .eq("id", jobId);
    if (upErr) {
      console.warn(`  ⚠️  [captcha] Không đẩy được ảnh lên job: ${upErr.message}`);
      return { action: "cancel" };
    }
    console.log(`  📤 [captcha] Đã đẩy ảnh (round ${round}) lên điện thoại, chờ nhập...`);

    // 2) Poll đợi điện thoại gửi đáp án (submit_captcha → status='captcha_submitted').
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const { data, error } = await supabase
        .from("automation_jobs")
        .select("status, captcha_action, captcha_answer")
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        console.warn(`  ⚠️  [captcha] Lỗi poll: ${error.message}`);
        continue;
      }
      if (!data) {
        // Job biến mất (bị xoá/huỷ) → coi như cancel.
        return { action: "cancel" };
      }
      if (data.status === "captcha_submitted") {
        const action = data.captcha_action === "reload" ? "reload" : "answer";
        const code = data.captcha_answer || "";
        // Đưa job về 'running' để vòng captcha sau bắt đầu sạch.
        await supabase
          .from("automation_jobs")
          .update({ status: "running", captcha_action: null, captcha_answer: null })
          .eq("id", jobId);
        console.log(`  📥 [captcha] Nhận từ điện thoại: ${action}${action === "answer" ? " (đã có mã)" : ""}`);
        return action === "reload" ? { action: "reload" } : { action: "answer", code };
      }
      // Trường hợp job bị chuyển 'error' từ nơi khác (requeue_stale) → dừng.
      if (data.status === "error" || data.status === "done") {
        return { action: "cancel" };
      }
    }

    console.warn(`  ⏱  [captcha] Hết thời gian chờ nhập captcha (${timeoutMs / 1000}s).`);
    return { action: "timeout" };
  };
}

module.exports = { makeSupabaseCaptcha };
