# Hướng Dẫn Sử Dụng API Claude Quota Monitor (v2 — Opportunity Engine)

Cloudflare Worker phục vụ Web Dashboard và REST API theo dõi hạn mức 5 giờ của Claude Code cho cả team, trả lời câu hỏi:
**tài khoản nào, lúc nào, còn thừa bao nhiêu quota** để tận dụng trước khi hết hạn.

Trong tài liệu này `<ACCESS_KEY>` là Secret Key của team (lấy từ người quản trị, không ghi vào tài liệu).

## Danh Sách Endpoints

| Method | Endpoint | Định dạng | Mô tả | Cache-Control |
|---|---|---|---|---|
| `GET` | `/` hoặc `/dashboard` | HTML | Dashboard (SSR + dữ liệu snapshot nhúng sẵn) | `private, no-store` |
| `GET` | `/status` hoặc `/api/status` | JSON | Snapshot đã tính sẵn (có `ETag`, hỗ trợ `If-None-Match` → 304) | `private, no-store` |
| `POST` | `/update` hoặc `/api/update` | JSON | Client đẩy báo cáo quota / báo lỗi token | `private, no-store` |
| `GET` | `/health` | JSON | Kiểm tra Worker còn sống (không cần key) | - |
| `GET` | `/favicon.ico` | - | `204`, không cần key (tránh lỗi 401 trên console) | `public, max-age=86400` |

Xác thực (một key duy nhất, so sánh constant-time): query `?key=<ACCESS_KEY>`, header `x-api-key: <ACCESS_KEY>`,
hoặc `Authorization: Bearer <ACCESS_KEY>`. Sai/thiếu key → `401` (JSON) hoặc màn hình nhập key (HTML).

## Chính sách tính toán (quan trọng)

- Số liệu **chỉ được tính lại khi có client gửi `POST /update`**. `GET /status` và Dashboard chỉ trả snapshot đã lưu,
  không tính lại theo từng phút.
- Khi một tài khoản gửi báo cáo: dòng của tài khoản đó được tính lại đầy đủ tại thời điểm POST. Các tài khoản khác giữ
  nguyên số liệu tính ở lần báo cáo gần nhất của chính chúng, chỉ áp dụng các chuyển trạng thái chắc chắn tại thời điểm đó:
  (a) đã qua `resets_at` → đóng chu kỳ vào lịch sử, chuyển sang `FRESH` (trống 100%);
  (b) cờ `stale` khi báo cáo quota **hợp lệ** cuối cách hơn 75 phút (độ tin cậy hạ xuống `low`, dự báo giữ nguyên).
- Tổng hợp toàn team (tổng, gợi ý, timeline, heatmap) được tính lại ở mỗi POST.
- Hệ quả: các trường tương đối như `resets_in`, `last_updated_ago`, `status` (mọi trường `*_ago` / `*_in`) được "chốt"
  tại `computed_at` của dòng (hoặc của snapshot), **không** còn tính theo thời điểm gọi GET như bản cũ. Để tự tính tuổi
  báo cáo theo giờ hiện tại, dùng các mốc tuyệt đối `last_report_at` (báo cáo bất kỳ) và `last_valid_at` (báo cáo quota
  hợp lệ), đều là ISO 8601.

## Lưu trữ

Mỗi provider một Durable Object SQLite (`TeamStore`; claude `idFromName("team")`, agy `idFromName("agy")` — xem mục
"Providers"), mỗi object có bảng `accounts`, `samples` (giữ 14 ngày),
`windows` (chu kỳ đã đóng, 30 ngày), `gaps` (khoảng rảnh giữa các chu kỳ, 30 ngày), `machines` (mỗi cặp tài khoản + máy một dòng, giữ vĩnh viễn, rất nhỏ), `meta` (snapshot + version).
Mọi POST được xử lý tuần tự và ghi nguyên tử. KV `CLAUDE_QUOTA_KV` chỉ còn được đọc **một lần** để nhập dữ liệu cũ
(`account:<email>`), sau đó không bao giờ ghi KV nữa. Bản ghi/điểm lịch sử hỏng được bỏ qua; nếu cả lần nhập lỗi, Worker
vẫn chạy bình thường, ghi `kv_import_failed_at` và chỉ thử lại sau ít nhất 6 giờ.

---

## 1. `GET /status`

```bash
curl -s -H "x-api-key: <ACCESS_KEY>" "https://team-ai-quota.your-worker.workers.dev/status"

# Chỉ tải lại khi có thay đổi:
curl -s -i -H "x-api-key: <ACCESS_KEY>" -H 'If-None-Match: "1532"' "https://team-ai-quota.your-worker.workers.dev/status"
# -> HTTP 304 nếu snapshot vẫn là version 1532
```

Response headers: `ETag: "<version>"`, `Cache-Control: private, no-store`. JSON không pretty-print.

### Cấu trúc snapshot (rút gọn)

```json
{
  "version": 1532,
  "computed_at": "2026-10-27T16:37:00.000Z",
  "computed_at_gmt7": "2026-10-27 23:37:00 GMT+7",
  "updated_at_gmt7": "2026-10-27 23:37:00 GMT+7",
  "trigger_email": "admin@example.com",
  "total_accounts": 6,
  "totals": { "free_now_sum": 216, "free_now_windows": 2.2, "at_risk_waste_sum": 72, "fresh_count": 1,
              "active_count": 3, "cooldown_count": 1, "auth_count": 1, "capped_count": 1, "exhaust_count": 2,
              "stale_count": 1, "weekly_warning_count": 0, "warning_count": 4 },
  "opportunity": { "use_before_reset": [...], "fresh_now": [...], "will_exhaust": [...],
                   "timeline_12h": { "from": "...", "to": "...", "lanes": [...] } },
  "heatmap": { "unit": "% của một chu kỳ 5h, trung bình mỗi ngày", "span_days": 14,
               "accounts": [{ "email": "...", "values": [24 số], "observed_days": 14 }], "team": [24 số] },
  "golden_hours": [{ "hour": 7, "value": 109.5, "label": "07:00–08:00" }],
  "history_14d": { "days": ["14/10", "..."], "daily": [{ "email": "...", "waste_pct": [14], "idle_h": [14] }],
                   "windows": [{ "email": "...", "start": 1793084220275, "end": 1793102220275, "used": 68, "waste": 32, "unc": 25 }] },
  "accounts": [ { "...": "xem bên dưới" } ]
}
```

`totals.warning_count` = số tài khoản **khác nhau** cần chú ý (AUTH, chạm trần tuần, hoặc sẽ cạn trước reset).

### Trường của mỗi tài khoản (`accounts[]`)

Giữ nguyên tên trường cũ, thêm trường mới. Mọi `%` là "% của chu kỳ 5h của tài khoản đó" trừ khi có tiền tố `weekly_`.

**Văn bản do server sinh ra** (`prediction_text`, `pacing_badge_text`, `auth_label`, `resets_in` khi sẵn sàng, `text` trong
`opportunity`, `intensity_label`, `heatmap.unit`, `name` của máy không có tên...) là **tiếng Anh**. Mỗi trường như vậy có thêm
`<trường>_key` (khoá i18n, `srv_*` trong `src/i18n.js`) và `<trường>_params` (giá trị thô: số, mốc thời gian epoch ms, khoảng
thời gian tính bằng ms, email). Dashboard dựng lại câu theo ngôn ngữ đang chọn từ khoá + tham số; client khác cứ đọc trường văn
bản như cũ. Tên máy do client gửi không bao giờ bị dịch.

- Trường cũ: `email`, `used_percent`, `remaining_percent`, `resets_in`, `resets_at_gmt7`, `last_updated_ago`,
  `last_updated_gmt7`, `status` (`online` nếu báo cáo ≤ 75 phút, ngược lại `offline`), `velocity` (%/h),
  `projected_percent`, `pacing_status` (`safe`|`moderate`|`danger`), `prediction_text`, `history`
  (24h gần nhất, dạng gọn `{timestamp, used_percent}`; đã bỏ `time_gmt7`).
- `state_code`: `ACTIVE` (đang trong chu kỳ) · `FRESH` (không có chu kỳ đang chạy, trống 100%; chu kỳ 5h chỉ bắt đầu
  khi dùng) · `COOLDOWN` (đã dùng 100%, chờ reset) · `AUTH` (token hết hạn / cần đăng nhập / lỗi đọc quota —
  quota không xác định, bị loại khỏi mọi gợi ý và tổng).
- `computed_at`: thời điểm số liệu của dòng này được tính (lần báo cáo gần nhất của chính tài khoản).
- `free_now`: trống ngay (ACTIVE `100-used`, FRESH 100, COOLDOWN 0, AUTH `null`; 0 nếu chạm trần tuần).
- `rate_window`, `rate_recent`, `velocity`, `confidence` (`high`|`medium`|`low`): tốc độ dùng %/h.
  `rate_recent` = độ dốc các mẫu cùng chu kỳ trong 90 phút gần nhất (≥ 2 điểm, cách ≥ 15 phút);
  `velocity = 0.6*rate_recent + 0.4*rate_window` (hoặc `rate_window` nếu thiếu `rate_recent`); `0` nếu `stale`.
- `raw_projection` (có thể > 100), `projected_percent`, `at_risk_waste` (% sẽ mất khi reset nếu giữ nhịp hiện tại),
  `exhaust_at` (ISO, nếu sẽ cạn trước reset), `burn_needed_per_h` (nhịp cần để dùng hết trước reset).
- `weekly_used` (`null` = client cũ / API không có giới hạn tuần nào mang số % hiện hành), `weekly_capped` (≥ 95%, bị loại khỏi gợi ý),
  `weekly_warning` (80–95%), `weekly_resets_at`.
- `auth_state` (`expired_idle`|`auth_required`|`error`), `auth_label`, `auth_at`, `auth_error`, `error_kind`:
  chỉ có khi `state_code = AUTH`.
- `auth_warning`: `null` hoặc `{ "state": "expired_idle"|"auth_required"|"error", "label": "<nhãn tiếng Việt>",
  "at": "<ISO>", "error": "<thông điệp client>"|null, "error_kind": "<vd usage_parse_error>"|null }`.
  Có khi một máy báo lỗi token/lỗi đọc quota trong lúc tài khoản vẫn có báo cáo hợp lệ trong 75 phút gần nhất
  (nhiều máy dùng chung một tài khoản). Dòng vẫn giữ trạng thái và số liệu của báo cáo hợp lệ; đây chỉ là ghi chú phụ.
  Báo cáo hợp lệ tiếp theo sẽ xoá cảnh báo. Thêm `from_other_machine` (`true` chỉ khi lần đo hợp lệ gần nhất đến từ một
  `machine_id` khác máy báo lỗi) và `last_valid_at` (ISO): giao diện dùng chúng để chỉ nói "từ máy khác" khi đúng như vậy.
- `machines[]` (tối đa 20, báo cáo mới nhất trước): các máy đã báo tài khoản này. Mỗi phần tử `{machine_id, id_short, name, os,
  first_seen, last_seen, last_valid, reports_ok, reports_err, last_error_kind, last_error_at, client_version, ip, country,
  last_used_percent, status}`, `status` = `ok` | `silent` (không có số đo hợp lệ > 75 phút) | `error` (lần báo gần nhất là lỗi).
  Quota tính theo tài khoản, nên danh sách này cho biết máy nào **đo** tài khoản, không phải máy nào đã tiêu bao nhiêu. Client cũ
  không có `machine_id` được gom thành một máy `unknown` (`name` = "unknown machine (old client)", kèm `name_key`). `ip` lấy từ header `CF-Connecting-IP`,
  `country` từ `request.cf.country`; chỉ nằm trong snapshot, cần key để đọc. Cấp snapshot có thêm `total_machines`.
- `idle_since` (FRESH: rảnh từ lúc nào, `null` nếu chưa rõ), `window_start`, `remaining_hours`, `stale`,
  `client_version`, `last_report_at`, `last_valid_at`.
- `stats_14d`: `windows_closed`, `avg_waste_per_window`, `total_wasted`, `idle_hours`,
  `used_windows`/`wasted_windows`/`idle_windows` (đơn vị "chu kỳ 5h"), `efficiency` (%).

Đã bỏ: `opportunity_report` và biểu đồ "24 khung giờ" cũ (trung bình `used_percent` tích luỹ theo giờ — không phản ánh
mức dùng hay phần thừa). Thay bằng `opportunity`, `heatmap`, `golden_hours`, `history_14d`.

### Gợi ý (`opportunity`)

1. `use_before_reset`: tài khoản ACTIVE (không chạm trần tuần) có `at_risk_waste ≥ 10`, xếp theo
   `at_risk_waste / max(giờ còn lại, 0.25)` giảm dần. Ví dụ: "~42% sẽ mất lúc 00:20 (còn 1h 10m) — cần đốt ~36%/h để dùng hết".
2. `fresh_now`: tài khoản FRESH, xếp theo thời gian rảnh lâu nhất.
3. `will_exhaust`: ACTIVE sẽ cạn trước reset (không gồm TK đã chạm trần tuần — đã nằm trong cảnh báo trần tuần),
   kèm `alternative`: ưu tiên FRESH, sau đó TK ACTIVE trống nhiều nhất; không bao giờ là TK AUTH, chạm trần tuần,
   `stale`, hoặc chính nó cũng sẽ cạn trước reset (`null` nếu không có).
4. `timeline_12h`: mỗi tài khoản (trừ AUTH) một lane với các sự kiện `reset` (+100%) và `exhaust` trong 12 giờ tới.

### Heatmap / "khi nào thừa"

Mỗi chu kỳ đã đóng: `waste = 100 − final_used` (final_used = mẫu cuối trong chu kỳ; `unc` = số phút từ mẫu cuối tới
reset), trải đều trên 5 giờ của chu kỳ (`waste/5` mỗi giờ). Khoảng rảnh giữa hai chu kỳ tính 20/giờ (= 100%/5h); khi
đang FRESH chỉ tính tới `min(now, báo cáo hợp lệ cuối + 30 phút)`. Chia theo giờ GMT+7 (24 ô), trung bình theo số ngày
quan sát (thực, tối thiểu 1, tối đa 14). Hàng team = tổng các tài khoản. `golden_hours` = 3 giờ thừa nhiều nhất.

---

## 2. `POST /update`

```bash
curl -s -X POST "https://team-ai-quota.your-worker.workers.dev/update" \
  -H "x-api-key: <ACCESS_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dev@example.com",
    "used_percent": 53.0,
    "resets_at": "2026-10-27T17:20:00.169588+00:00",
    "token_state": "ok",
    "client_version": "3.0",
    "parse_source": "regex",
    "limits": [
      { "kind": "weekly", "group": "weekly", "percent": 0, "resets_at": "2026-10-29T10:00:00+00:00", "is_active": true, "scope_name": "Fable" }
    ]
  }'
```

### Payload

- `email` (bắt buộc): email hợp lệ, khác `unknown@user`.
- `used_percent` (bắt buộc với báo cáo quota): số hữu hạn, được kẹp vào 0..100 (chấp nhận alias cũ `utilization`).
- `resets_at`: chuỗi ISO 8601 hoặc `null` (không có chu kỳ đang chạy).
- Tuỳ chọn (client mới): `limits` (mảng ≤ 12 phần tử `{kind, group, percent, resets_at, is_active, scope_name}`),
  `token_state` (`ok`|`expired_idle`|`auth_required`), `client_version`, `error_kind`, `error`,
  `fetched_at` (epoch ms hoặc ISO: lúc client nhận được số liệu; nhiều máy cùng một tài khoản thì giờ này bị kẹp trong [nhận − 15 phút, nhận + 2 phút]
  và chỉ dùng để phân xử khi `resets_at` = null), `machine_id` (chuỗi ngẫu nhiên ổn định của từng máy, ≤ 64 ký tự; dùng để theo dõi
  cảnh báo token theo máy và bảng "máy ↔ tài khoản"), `machine_name` (hostname, ≤ 64 ký tự) và `os` (≤ 32 ký tự) chỉ để hiển thị (client ≥ 3.2). Báo cáo thuộc chu kỳ cũ hơn chu kỳ đang theo dõi, hoặc `used` thấp hơn trong cùng chu kỳ, chỉ
  được bỏ qua (không đổi trạng thái, không tạo mẫu). Client cũ không gửi các trường này vẫn hoạt động.
- Client v3 gửi thêm `parse_source` (`regex`|`llm_fallback`), `parse_status` (`ok`|`partial`|`llm_verified`) và, với kết quả dự phòng do LLM, `low_confidence: true`. Server hiện bỏ qua các trường này (dành cho dùng sau); `error_kind` của client v3: `parse_error`, `usage_timeout`, `claude_failed`, `auth_required` (máy không có `claude`/`agy` không gửi gì, nên không còn `claude_missing`/`agy_missing`). Lệnh `claude -p /usage` quét session cục bộ nên có thể lâu (máy 18 GB: ~100 giây): client cho 300 giây, nếu quá giờ thì chờ ~90 giây và thử lại một lần (chạy ở mức ưu tiên thấp) rồi mới báo `usage_timeout`, kèm tải máy (load avg) trong thông điệp.
- Client ≥ 3.4 gửi thêm `update_status` (chuỗi ≤ 80 ký tự: `current`, `updated_from_<ver>`, `gh_missing`, `gh_unauthenticated`, `unverified_commit`, `failed:<lý do>`, `disabled`) và `update_checked_at` (epoch ms, lần kiểm tra bản mới gần nhất; bị kẹp ≤ giờ nhận). Lưu theo từng máy; snapshot có `latest_client_version` và mỗi máy có `outdated`, `update_status`, `update_checked_at`.
- Client cũ vẫn hợp lệ: `{email, used_percent, resets_at}` và báo lỗi `{email, status: "auth_required", error}`.
- Sai kiểu / thiếu trường → `400` kèm `{ "error": "..." }`.

### Báo lỗi token / lỗi đọc quota

`status: "auth_required"`, `token_state` khác `ok`, hoặc có `error_kind` → **không** đổi `used`/`resets_at`, **không**
thêm mẫu.
- Nếu tài khoản có báo cáo quota hợp lệ trong 75 phút gần nhất (máy khác vẫn dùng bình thường): giữ nguyên trạng thái,
  chỉ ghi `auth_warning`.
- Nếu không: chuyển sang `AUTH` (`auth_state`).
Báo cáo quota hợp lệ tiếp theo sẽ xoá cả `auth_state` lẫn `auth_warning`.

### Báo cáo trùng

Nhiều máy cùng tài khoản: nếu cùng chu kỳ, cùng `used` và mẫu cuối < 10 phút → chỉ cập nhật thời điểm báo cáo,
không thêm mẫu (`sample_added: false`).

### Response

```json
{
  "success": true,
  "message": "Account quota updated successfully",
  "version": 1533,
  "computed_at": "2026-10-27T15:30:21.097Z",
  "sample_added": true,
  "record": {
    "email": "dev@example.com",
    "state_code": "ACTIVE",
    "used_percent": 53,
    "resets_at": "2026-10-27T17:20:00.169Z",
    "auth_state": null,
    "updated_at": "2026-10-27T15:30:21.097Z"
  }
}
```

---

## Providers

Mỗi provider một Durable Object + một snapshot riêng: `claude` (mặc định, giữ `idFromName("team")` nên dữ liệu cũ không
đổi; chỉ object này nhập KV cũ) `agy` (`idFromName("agy")`) và `codex` (`idFromName("codex")`). Danh sách provider/pool cố định trong
`PROVIDERS` (`src/analytics.js`), thêm provider mới = thêm một mục ở đó.

| provider | label | pools (`id` → `label`) |
|---|---|---|
| `claude` | Claude | *(không có pool)* |
| `agy` | Agy | `gemini` → "Gemini (Flash/Pro)", `claude` → "Claude & GPT-OSS" |
| `codex` | Codex | *(không có pool)* |

### Chọn provider

- `GET /status?provider=agy`, `GET /?provider=agy` (Dashboard). Thiếu/rỗng → `claude`. Provider lạ → `400`.
- `ETag`: claude giữ nguyên `"<version>"`; provider khác `"<provider>-<version>"` (vd `"agy-12"`). `If-None-Match`
  của provider khác không bao giờ khớp (không có 304 nhầm giữa hai object có version trùng số).
- `POST /update`: provider lấy từ body. `POST /__dev/seed?provider=agy` (chỉ local).

### Payload `POST /update` (thêm)

- `provider`: `"claude"` (mặc định khi thiếu/`null`) | `"agy"` | `"codex"`. Giá trị khác → `400`.
- Codex: như claude (không pool). `used_percent`/`resets_at` = cửa sổ 5h; `limits` chứa một mục `kind/group: "weekly"` (`scope_name: null`) cho cửa sổ 7 ngày; `client_version` dạng `codex-<x.y>`.
- `pool`: `null` với claude (gửi pool cho claude → `400`). Với agy **bắt buộc** cho báo cáo quota: `"gemini"` | `"claude"`.
  Báo lỗi/token của agy (`error_kind`, `token_state`, `status: "auth_required"`) **có thể không có pool**: server áp
  cho **mọi pool** của tài khoản (token là của tài khoản); có pool thì chỉ áp cho pool đó.
- Agy, mỗi pool một POST: `used_percent`/`resets_at` = bucket 5h của pool; `limits` chứa bucket tuần
  `{kind:"weekly", group:"weekly", percent:<% đã dùng>, resets_at, is_active:true, scope_name:"<pool>"}` → các trường
  `weekly_*` của dòng tính như claude (`weekly_capped` ≥ 95, `weekly_warning` 80–95).
- `five_hour_disabled: true` (boolean; khác boolean → `400`): bucket 5h bị tắt vì đã chạm trần tuần. Server **bỏ qua**
  `used_percent` và `resets_at` của báo cáo này (không bắt buộc gửi). Xử lý:
  - đóng chu kỳ 5h đang mở (nếu có) tại thời điểm nhận; đóng khoảng rảnh đang mở (giới hạn như đuôi FRESH: tối đa
    báo cáo hợp lệ trước + 30 phút) và **không** tính thời gian bị khóa là "rảnh" trong heatmap; **không** thêm mẫu;
  - dòng thành `state_code: "COOLDOWN"`, `five_hour_disabled: true`, `weekly_capped: true`, `weekly_warning: false`,
    `used_percent: 100`, `free_now: 0`, `at_risk_waste: 0`, `resets_at` = `weekly_resets_at` = mốc reset tuần của pool
    (lấy từ `limits`; thiếu thì giữ mốc trước nếu còn ở tương lai, không thì `null` → `resets_in: "N/A"`),
    `window_start: null`, `pacing_badge_text: "Weekly cap reached"` (+ `pacing_badge_text_key: "srv_badge_weekly_cap"`);
  - bị loại khỏi gợi ý và tổng như mọi dòng chạm trần tuần. Khi qua mốc reset tuần, chuyển cứng sang `FRESH` ở lần POST
    bất kỳ kế tiếp; báo cáo 5h bình thường kế tiếp cũng xoá cờ.
- Response thêm `provider`; `record` thêm `account_key`, `provider`, `pool` (báo lỗi agy không pool: `record` là của
  pool cuối, `version` là version sau khi áp cho mọi pool).

### Snapshot (`GET /status`) — trường thêm

```json
{
  "version": 12,
  "provider": "agy",
  "providers": [{ "id": "claude", "label": "Claude" }, { "id": "agy", "label": "Agy" }],
  "pools": [{ "id": "gemini", "label": "Gemini (Flash/Pro)" }, { "id": "claude", "label": "Claude & GPT-OSS" }],
  "totals": { "...": "gộp mọi pool — giao diện có pool KHÔNG dùng, xem by_pool" },
  "opportunity": { "...": "như trên, gợi ý thay thế chỉ trong cùng pool" },
  "by_pool": {
    "gemini": { "total_accounts": 3, "totals": {}, "opportunity": {}, "heatmap": {}, "golden_hours": [], "history_14d": {} },
    "claude": { "total_accounts": 3, "totals": {}, "opportunity": {}, "heatmap": {}, "golden_hours": [], "history_14d": {} }
  },
  "accounts": [
    { "email": "dev@example.com", "account_key": "dev@example.com#gemini", "pool": "gemini",
      "pool_label": "Gemini (Flash/Pro)", "five_hour_disabled": false, "state_code": "ACTIVE", "...": "như claude" }
  ]
}
```

- `provider`: provider của snapshot. `providers`: danh sách cho thanh chọn provider. `pools`: `[]` với claude.
- `by_pool[<pool id>]`: **cùng hình dạng** các trường tổng hợp cấp snapshot của claude (`totals`, `opportunity`,
  `heatmap`, `golden_hours`, `history_14d`) + `total_accounts`, tính riêng trên các dòng của pool đó → mỗi pool một cột,
  không gộp số. Claude: `by_pool = {}`. Danh sách dòng của một pool: lọc `accounts` theo `pool`.
- Cấp snapshot (`totals`, `opportunity`, `heatmap`, …) vẫn có cho mọi provider (gộp tất cả dòng); với claude không đổi gì.
- `trigger_email`: luôn là email gốc.
- Mỗi `accounts[]`: `email` = email gốc (hai pool cùng email → hai dòng cùng `email`), `account_key` = khóa duy nhất
  của dòng (`email` với claude, `email#pool` với agy; dùng làm key khi render/so khớp), `pool` (`null` với claude),
  `pool_label` (`null` với claude), `five_hour_disabled` (`true` chỉ khi đang khóa 5h; dòng cũ có thể thiếu → coi là `false`).
  `machines`, `history`, `stats_14d` là của riêng dòng (pool) đó.
- Phần tử mang email trong `opportunity` (`use_before_reset`, `fresh_now`, `will_exhaust` và `alternative` của nó,
  `timeline_12h.lanes`), `heatmap.accounts`, `history_14d.daily`, `history_14d.windows` đều có thêm `account_key`
  (các phần tử opportunity và `heatmap.accounts` có thêm `pool`). `will_exhaust[].alternative` luôn cùng pool.
- `totals.warning_count` đếm theo `account_key` (với agy: mỗi pool cần chú ý tính một).
- Lưu trữ: trong mỗi object, cột `email` của các bảng `accounts`/`samples`/`windows`/`gaps`/`machines` chứa
  `account_key` (claude: đúng email như cũ; không đổi schema).

---

## 3. Chạy local

```bash
# .dev.vars (đã gitignore): API_SECRET_KEY=local-test-key  (DEV_SEED=1 để bật route seed dữ liệu giả)
npx -y wrangler@4.153.0 dev --local --port 8799
npm test                       # node:test, không cần dependency
npm run seed:local             # chỉ seed DO local qua POST /__dev/seed (route 404 nếu không có DEV_SEED=1)
node test/tools/seed-fake.mjs --provider agy --post http://127.0.0.1:8799 --key local-test-key   # seed DO agy
```
