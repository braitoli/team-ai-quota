# Hướng Dẫn Cài Đặt Claude Quota Monitor Trên Linux

Hệ thống theo dõi Quota Claude Code 5 giờ tập trung toàn team qua Cloudflare Worker & KV.

- **Dashboard Cockpit**: `https://team-ai-quota.your-worker.workers.dev/?key=<ACCESS_KEY>`
- **Worker Status API**: `https://team-ai-quota.your-worker.workers.dev/status?key=<ACCESS_KEY>`
- **Secret Key**: (xem `.secrets/quota-key.txt`, không commit; hướng dẫn: [LOCAL_SECRETS.md](LOCAL_SECRETS.md))

---

## 1. Cài Đặt Tự Động (Khuyến Nghị)

Script cần chạy từ bên trong một bản clone của repo (không còn cài qua 1-liner `curl | bash` / `irm | iex`). Mở Terminal và chạy:

```bash
gh repo clone braitoli/team-ai-quota   # hoặc: git clone https://github.com/braitoli/team-ai-quota.git
cd team-ai-quota
bash scripts/setup-linux.sh
```

**Cập nhật bản cài đặt có sẵn**: vào thư mục clone, chạy `git pull` rồi chạy lại script trên.

---

## 2. Cơ Chế Hoạt Động (Cron: @reboot & 15 phút)

**Chỉ báo cho CLI đã cài.** Khi chạy, setup dò `claude` (Claude Code) và `agy` (Antigravity CLI) bằng chính các đường dẫn tìm kiếm của client (`report_quota.py --detect`, `report_agy.py --detect`) và chỉ cài job cho CLI tìm thấy; in rõ máy này có CLI nào. Không tìm thấy CLI nào thì không cài job báo cáo nào. Client cũng tự im lặng: thiếu `claude` thì `report_quota.py` (hoặc thiếu `agy` thì `report_agy.py`) thoát với mã 0 và **không gửi gì** (không báo lỗi, không số liệu giả). Còn CLI đã cài nhưng chưa đăng nhập thì vẫn gửi báo lỗi `auth_required`. Job `agy` chỉ được thêm khi máy có `agy`: `@reboot sleep 45` và `7,22,37,52 * * * *` (lệch với job Claude, log `~/.claude/quota-monitor/agy-quota.log`).

Trên Linux, script tự động thiết lập crontab kép:
1. **`@reboot sleep 15 && ...`**: Chạy ngay 15 giây sau khi máy khởi động (sau khi mạng đã kết nối), giúp tài khoản lập tức hiển thị trạng thái Online trên Cockpit Dashboard.
2. **`*/2 * * * * ...`**: Kích hoạt cron mỗi 2 phút; script tự động đo tốc độ đốt token trên tài khoản hiện tại để điều chỉnh tần suất cập nhật thông minh từ 2 phút (khi đốt nhanh) đến 15 phút (khi rảnh/idle). Nếu chưa tới chu kỳ, script bỏ qua ngay lập tức.
3. **Overload Suppression**: Tự động ngủ đông khi chạm 100% quota đến mốc reset, không lãng phí request.
4. **Không đụng vào token**: Client v3 chạy `claude -p "/usage"` (0 token); không đọc credentials, không cache token. Script tự tìm `claude` ở `~/.local/bin`, `/usr/local/bin`, nvm, `~/.local/node*/bin`, npm global... vì cron có PATH tối thiểu (hoặc đặt `CLAUDE_QUOTA_CLAUDE_BIN`). Email lấy từ `claude auth status`.
5. **Chống chạy chồng & lệch giờ**: khoá `run.lock`, trễ ngẫu nhiên 0–30 giây.
6. **Dự phòng Haiku**: Client v3 hỏi chính Claude Code (`claude -p "/usage"`, **0 token**, không trừ quota) rồi dùng regex tách thành JSON. Chỉ khi regex không đọc được (Anthropic đổi câu chữ) mới có **một** lần gọi dự phòng `claude -p --model haiku` (≈4k token đầu vào Haiku, vài phần nghìn USD), tối đa 1 lần mỗi lượt chạy, và không gọi lại trong 6 giờ nếu chính đoạn text đó đã thất bại (sau 3 lần thất bại liên tiếp cũng chỉ thử lại mỗi 6 giờ). Kết quả dự phòng chỉ được nhận khi số % và giờ reset khớp từng chữ số với text gốc, reset nằm trong 8 ngày tới; ngược lại gửi `error_kind=parse_error` chứ không bao giờ gửi 0%.

Setup tự xoá `.token_cache.json` của các bản cũ.

Từ client v3.4, client **tự cập nhật** chính nó bằng `gh` (cần `gh auth login` trên máy này; tắt bằng `CLAUDE_QUOTA_NO_UPDATE=1` hoặc file rỗng `~/.claude/quota-monitor/no_update`). Việc tự cập nhật chỉ thay file `report_quota.py` (và `report_agy.py` trên máy có `agy`, cùng quy tắc); đổi lịch chạy hay script cài đặt vẫn cần chạy lại `scripts/setup-*`. Chi tiết: mục "Tự cập nhật client" trong README.

---

## 2b. Agy (Antigravity CLI) — tuỳ chọn

Nếu máy có lệnh `agy`, `setup-linux.sh` copy thêm `client/report_agy.py` vào `~/.claude/quota-monitor/` và thêm 2 dòng crontab (`@reboot sleep 45` và `7,22,37,52 * * * *`, lệch với job Claude chạy phút 0/15/30/45; log `~/.claude/quota-monitor/agy-quota.log`). Không có `agy` thì in thông báo bỏ qua, không báo lỗi. Script chạy `agy -p /usage --output-format json` (0 token, từ thư mục rỗng, timeout 120s) và gửi **mỗi pool một báo cáo** (`provider="agy"`, `pool="gemini"|"claude"`). Email lấy từ trường `id_token_email` trong `~/.gemini/antigravity-cli/antigravity-oauth-token`; token không bao giờ được in, lưu hay gửi. Khi bucket 5h bị `disabled` (đã chạm trần tuần) client gửi `five_hour_disabled: true`, `resets_at: null`. Chạy thử: `python3 ~/.claude/quota-monitor/report_agy.py --no-jitter`. Gỡ: `(crontab -l 2>/dev/null | grep -v "report_agy.py") | crontab -`.

---

## 3. Quản Lý & Xem Log

- **Xem crontab**:
  ```bash
  crontab -l
  ```
- **Chạy thử bằng tay**:
  ```bash
  python3 ~/.claude/quota-monitor/report_quota.py
  ```
- **Xem nhật ký log**:
  ```bash
  tail -f ~/.claude/quota-monitor/quota.log
  ```
- **Gỡ cài đặt**:
  ```bash
  (crontab -l 2>/dev/null | grep -v -e "report_quota.py" -e "report_agy.py") | crontab -
  ```
