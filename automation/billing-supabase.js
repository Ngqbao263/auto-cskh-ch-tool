/**
 * billing-supabase.js
 * ===================
 * Cầu nối "sửa Địa chỉ hóa đơn cước" cho WORKER MODE (remote qua Supabase).
 * Cùng interface với cầu nối localhost (billing-bridge) nhìn từ bccs-handler:
 *   billing(currentValue) => Promise<{ value: string }>
 *
 * Luồng: worker đọc giá trị BCCS render → đẩy lên job (billing_pending) → điện thoại
 * sửa → RPC submit_billing (billing_submitted) → worker đọc billing_answer → điền lại.
 */

"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSupabaseBilling(supabase, jobId, opts = {}) {
  const pollMs = opts.pollMs ?? 2500;
  // BẮT BUỘC người dùng xác nhận địa chỉ mới qua captcha → nới thời gian chờ (10 phút),
  // hết giờ mà chưa xác nhận thì KHÔNG tự đi tiếp (confirmed=false → bccs-handler dừng).
  const timeoutMs = opts.timeoutMs ?? 600000;

  return async function billing(currentValue) {
    const { error: upErr } = await supabase
      .from("automation_jobs")
      .update({ billing_address: currentValue, billing_answer: null, status: "billing_pending" })
      .eq("id", jobId);
    if (upErr) {
      console.warn(`  ⚠️  [billing] Không đẩy được địa chỉ lên job: ${upErr.message}`);
      return { value: currentValue, confirmed: false };
    }
    console.log(`  📤 [billing] Đã đẩy "Địa chỉ hóa đơn cước" lên điện thoại, chờ XÁC NHẬN...`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const { data, error } = await supabase
        .from("automation_jobs")
        .select("status, billing_answer")
        .eq("id", jobId)
        .maybeSingle();
      if (error) {
        console.warn(`  ⚠️  [billing] Lỗi poll: ${error.message}`);
        continue;
      }
      if (!data) return { value: currentValue, confirmed: false, cancelled: true }; // job biến mất
      if (data.status === "billing_submitted") {
        const val = data.billing_answer != null ? data.billing_answer : currentValue;
        await supabase
          .from("automation_jobs")
          .update({ status: "running", billing_answer: null })
          .eq("id", jobId);
        console.log(`  📥 [billing] Người dùng đã XÁC NHẬN địa chỉ.`);
        return { value: val, confirmed: true };
      }
      if (data.status === "error" || data.status === "done")
        return { value: currentValue, confirmed: false, cancelled: true };
    }

    console.warn(`  ⏱  [billing] Hết thời gian chờ XÁC NHẬN địa chỉ — KHÔNG tự sang captcha.`);
    return { value: currentValue, confirmed: false };
  };
}

module.exports = { makeSupabaseBilling };
