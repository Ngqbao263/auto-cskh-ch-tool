# Kế hoạch: Remote master form (điện thoại) → máy có SFive chạy tool

> Mục tiêu: người dùng mở **csku-tasker-hub trên điện thoại**, điền master form, gửi đi;
> **1 máy tính có SFive** nhận và chạy automation (CSKH/Viettel/BCCS); **captcha giải ngay trên điện thoại**.
>
> Điều kiện thuận lợi: hub và tool **đã dùng chung 1 Supabase** (`exueouggmbjtjvsvpfya`).

---

## 1. Kiến trúc tổng quan

```
📱 Hub (React, điện thoại)                          💻 Tool worker (máy có SFive)
  1. Điền master form                                 chạy nền, poll Supabase 2-3s/lần
  2. Đọc ảnh AI (qua Edge Function)                   ┌───────────────────────────────┐
  3. Upload ảnh giấy tờ → Storage                     │ - claim job (queued→running)  │
  4. Tạo job (queued)  ───────────►  ☁️ SUPABASE ────►│ - tải ảnh từ Storage          │
                                     • automation_jobs │ - chạy insertCSKH/runCauhinh/ │
  6. Theo dõi realtime  ◄───────────  • Storage        │   runBCCS                     │
  7. Nhập captcha (khi cần) ◄────────  • automation_    │ - captcha → ghi lên job       │
     → ghi captcha_answer  ──────────►   workers        │ - đọc captcha_answer → điền   │
  8. Xem kết quả  ◄─────────────────  (result)          │ - ghi result (done/error)     │
                                                        └───────────────────────────────┘
```

**Không cần mở port/NAT/IP tĩnh**: cả 2 đầu chỉ gọi **ra** Supabase.

---

## 2. Supabase schema

### 2.1 Bảng `automation_jobs`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK, default gen_random_uuid() | |
| `created_by` | uuid | = auth.uid() của người trên phone |
| `status` | text | `queued`→`running`→`captcha_pending`→`captcha_submitted`→`done`/`error` |
| `master_data` | jsonb | toàn bộ dữ liệu form (như masterData hiện tại) |
| `automation_options` | jsonb | `{run_cskh, run_cauhinh, run_bccs}` |
| `doc_paths` | jsonb | map field→path Storage (bbnt, cmnd_truoc/sau, hop_dong, phu_luc) |
| `captcha_image` | text | data URI base64 ảnh captcha (nhỏ, vài KB) |
| `captcha_round` | int, default 0 | tăng mỗi lần đổi/nhập lại |
| `captcha_answer` | text | mã do phone nhập |
| `captcha_action` | text | `answer` \| `reload` |
| `result` | jsonb | kết quả 3 luồng (giống response /api/run-automation) |
| `error` | text | thông báo lỗi nếu có |
| `worker_id` | text | máy nào đang chạy |
| `claimed_at`, `created_at`, `updated_at` | timestamptz | |

Index: `(status, created_at)` để worker lấy job cũ nhất.

### 2.2 Bảng `automation_workers` (heartbeat — để phone biết máy online)
| Cột | Kiểu |
|---|---|
| `worker_id` | text PK (vd "PC-VungTau-01") |
| `label` | text |
| `last_seen` | timestamptz |
| `busy_job_id` | uuid null |

### 2.3 Storage bucket `automation-docs` (private)
- Path: `jobs/{job_id}/{field}.{ext}` (vd `jobs/abc/file_cmnd_truoc.jpg`).
- **Private** + RLS. Xóa cả thư mục sau khi job `done`/`error`.

### 2.4 RLS (tóm tắt)
- `automation_jobs`:
  - INSERT/SELECT: `created_by = auth.uid()` (phone chỉ thấy job của mình).
  - Captcha submit qua **RPC** `submit_captcha(job_id, answer, action)` (security definer, kiểm tra ownership) — tránh cho phone sửa cột khác.
  - Worker dùng **service role key** → bỏ qua RLS (đọc/ghi mọi job).
- `automation_workers`: SELECT cho user đã đăng nhập (phone xem online); ghi chỉ worker (service key).
- Storage: owner upload/đọc thư mục của mình; worker (service key) đọc tất cả.

### 2.5 RPC atomic claim (tránh chạy trùng)
```sql
create or replace function claim_next_job(p_worker text)
returns automation_jobs language plpgsql security definer as $$
declare j automation_jobs;
begin
  select * into j from automation_jobs
   where status = 'queued'
   order by created_at
   for update skip locked
   limit 1;
  if not found then return null; end if;
  update automation_jobs
     set status='running', worker_id=p_worker, claimed_at=now(), updated_at=now()
   where id = j.id returning * into j;
  return j;
end $$;
```

---

## 3. Vòng đời job + captcha (state machine)

```
queued ──(worker claim)──► running ──► (điền form)
                                     │
                     cần captcha ────┤
                                     ▼
              captcha_pending  (worker set + captcha_image, round++)
                   │  phone hiện ảnh
                   ▼
              phone gọi submit_captcha:
                 action=answer → captcha_submitted (worker điền vào SFive)
                 action=reload → worker đổi mã → captcha_pending (round++)
                                     │
             sai mã ──(worker)──► captcha_pending (round++)  ── lặp
             đúng ─────────────► done (result)
                                     │
             lỗi bất kỳ ─────────► error (error msg)
```

- Worker **poll** job của mình mỗi 2-3s để đọc `captcha_answer/action`.
- Phone dùng **Supabase Realtime** subscribe job → cập nhật tức thì (đỡ poll).

---

## 4. Phía Tool (máy SFive) — "worker mode"

### 4.1 File mới `automation/worker.js`
- Khởi tạo Supabase client bằng **service role key** (đã có trong .env).
- `heartbeat()` mỗi 15s → upsert `automation_workers` (last_seen=now).
- Vòng lặp:
  1. `claim_next_job(MACHINE_ID)`; nếu null → chờ 3s.
  2. Tải ảnh từ Storage `jobs/{id}/*` về `logs/uploads/`.
  3. Ghép `masterData = { ...job.master_data, file_* : <path đã tải> }`.
  4. Chạy `insertCSKH / runCauhinh / runBCCS` theo `automation_options` (tái dùng nguyên si).
  5. Ghi `result` + `status=done` (hoặc `error`).
  6. Xóa file tạm + xóa thư mục Storage của job.

### 4.2 Sửa nhỏ `bccs-handler.js` — captcha "cắm được"
- Hiện tại `handleCaptchaViaBridge` gọi `captcha-bridge` (localhost). Cần **tách captcha thành callback tiêm vào**:
  - `runBCCS(masterData, testMode, { captcha })` — `captcha` là hàm:
    `captcha(imageDataUri, round) => Promise<{ action:'answer'|'reload', code? }>`.
  - **Local mode** (dùng tool trực tiếp trên PC): callback = cầu nối localhost hiện tại.
  - **Worker mode** (remote): callback = ghi `captcha_image`+`captcha_pending` lên job, rồi poll `captcha_answer/action`.
- Phần chụp ảnh captcha, điền vào SFive, bấm Đấu nối… **giữ nguyên**.

### 4.3 Đóng gói
- exe vẫn chạy **web server local** (cho ai dùng trực tiếp trên PC) **+ worker loop** nền (nhận job remote). Thêm `MACHINE_ID` vào `.env`.

---

## 5. Phía Hub (điện thoại, React)

### 5.1 Trang mới "Nhập liệu tự động"
- Port master form sang React/shadcn: các trường + validate + autocomplete (`ma_cang`, `ma_nganh_nghe`, `tinh_thanh`) + logic AI đọc ảnh.
- **AI đọc ảnh**: gọi **Edge Function** `extract-image` (giữ `OPENAI_API_KEY` phía server) thay cho `localhost:3000/api/extract-image`.
- **Submit**:
  1. Upload ảnh giấy tờ (bbnt, cmnd truoc/sau, hop dong, phu luc) → Storage `jobs/{tempId}/...`.
  2. `insert automation_jobs { master_data, automation_options, doc_paths, status:'queued' }`.
- **Theo dõi**: subscribe realtime job → hiện tiến trình + kết quả.

### 5.2 Modal captcha (remote)
- Khi `status='captcha_pending'` → hiện `captcha_image` + ô nhập + nút Đổi mã.
- Xác nhận → `rpc submit_captcha(id, code, 'answer')`.
- Đổi mã → `rpc submit_captcha(id, null, 'reload')`.

### 5.3 Chỉ báo máy online
- Đọc `automation_workers.last_seen` → nếu > 30s coi như offline → cảnh báo "Máy SFive đang offline, không gửi được".

### 5.4 Edge Function `extract-image`
- Deno function: nhận ảnh (base64) → gọi OpenAI vision (bê prompt từ `image-extract-handler.js`) → trả JSON fields.
- `OPENAI_API_KEY` để trong **Supabase secrets** (không lộ ra phone).

---

## 6. Bảo mật & riêng tư
- **service role key CHỈ ở PC worker**. Phone dùng anon key + RLS.
- **OPENAI_API_KEY** chỉ trong Edge Function (Supabase secret).
- Bucket **private**, RLS theo `created_by`; **xóa ảnh** sau khi job xong.
- Captcha do **người thật trên phone** giải (không auto-solve).

---

## 7. Các bước triển khai (phase, test xong mới qua bước sau)

**Phase 1 — Supabase**
1. SQL: bảng `automation_jobs`, `automation_workers`, bucket, RLS, RPC `claim_next_job`, `submit_captcha`.
2. Chạy migration; test bằng tay (insert job, claim, submit_captcha).

**Phase 2 — Worker mode (tool)**
3. `automation/worker.js` + heartbeat + claim + tải ảnh + chạy handler + ghi kết quả.
4. Tách captcha thành callback; viết captcha-supabase cho worker.
5. Build exe worker; test: insert job tay trên Supabase → PC chạy.

**Phase 3 — Edge Function AI**
6. `extract-image` function + chuyển secret OPENAI_API_KEY.

**Phase 4 — Trang hub (phone)**
7. Master form React + validate + autocomplete + gọi Edge Function.
8. Submit (upload + tạo job) + màn theo dõi + modal captcha + chỉ báo online.

**Phase 5 — Test đầu-cuối**
9. Phone tạo job → PC nhận → chạy → captcha lên phone → nhập → PC đấu nối → kết quả về phone.

---

## 8. Rủi ro / cần lưu ý
- **Port form sang React** là phần tốn công nhất (form lớn, nhiều logic). Có thể làm dần từng section.
- **Độ trễ**: poll 2-3s → chấp nhận được; Realtime cho phone nhanh hơn.
- **Job treo**: worker chết giữa chừng → cần cơ chế timeout (job `running` quá X phút → trả `queued`/`error`).
- **1 máy**: nếu PC offline, job nằm `queued` chờ; phone cần báo "máy offline".
- **Ảnh CCCD lên cloud**: dữ liệu cá nhân — bắt buộc private + xóa sau xử lý.

---

## 9. Quyết định đã chốt
- 1 máy SFive duy nhất (không cần chọn máy đích; vẫn giữ `MACHINE_ID` cho heartbeat).
- Captcha giải trên **điện thoại** (remote hoàn toàn).
- Làm **kế hoạch chi tiết trước** (tài liệu này) rồi mới code.
