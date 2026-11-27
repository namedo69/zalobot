# Zalo bot — thông báo chấm công OBee

Bot độc lập: **EXE → API có khóa thiết bị → tài khoản Zalo bot → Zalo người nhận**. Có trang quản trị, đăng nhập QR, ghép người nhận, gửi tin thử và thu hồi quyền. Không nhận mật khẩu/cookie OBee. **Chưa tích hợp với EXE chấm công.**

> Dùng `zca-js`, API Zalo cá nhân **không chính thức**: có thể mất phiên, bị hạn chế hoặc khóa tài khoản. Nên dùng tài khoản bot riêng, không dùng đây là kênh cảnh báo duy nhất.

## Render Free — đọc trước khi deploy

Blueprint [`render.yaml`](render.yaml) dùng **Free**, không tạo disk/dịch vụ trả phí.

**Bản này lưu SQLite trên filesystem tạm của Render. Mỗi lần restart, redeploy hoặc sleep sẽ mất phiên Zalo, liên kết người nhận, khóa thiết bị và lịch sử chống gửi trùng.** Cần quét QR và tạo/ghép lại thiết bị sau đó. Giữ nguyên biến môi trường không khôi phục được database đã mất.

Cron bên ngoài gọi `GET https://<service>.onrender.com/healthz` mỗi 5 phút có thể tránh sleep do idle, nhưng **không đảm bảo uptime và không bảo vệ dữ liệu khỏi restart/redeploy**. Chưa tích hợp database ngoài (Neon/Supabase). Đây là bản **thử nghiệm**, chưa sẵn sàng làm cảnh báo chấm công đáng tin cậy cho nhiều người.

Theo [Render Free docs](https://render.com/docs/free): dịch vụ ngủ sau 15 phút không có inbound traffic; workspace có 750 giờ Free/tháng dùng chung; Render có thể restart bất kỳ lúc nào. Free Postgres Render hết hạn sau 30 ngày nên không phải lựa chọn lưu lâu dài miễn phí. Theo dõi quota bandwidth/build và billing của workspace.

## 1. Deploy

1. Render Dashboard → **New → Blueprint** → chọn repo `namedo69/zalobot`, branch `main`.
2. Blueprint Path: **`render.yaml`**. Mã nguồn ở gốc repo, **không đặt Root Directory**.
3. Nhập `PUBLIC_URL` là origin HTTPS dự kiến, ví dụ `https://attendance-zalo-notifier.onrender.com`, **không có `/` cuối**. Nếu tên thực tế khác, sửa Environment thành URL Render thực cấp rồi redeploy trước khi đăng nhập bot.
4. Kiểm tra plan là **Free**, không có persistent disk, rồi deploy.
5. Render tự sinh `ADMIN_TOKEN` và `SESSION_KEY`; lưu riêng trong password manager, không gửi qua chat hoặc đưa lên Git.
6. Khi Live, mở `/healthz`: phải trả `{"ok":true}`. Endpoint chỉ xác nhận HTTP sống, không xác nhận Zalo đã kết nối.
7. Mở `/admin`, nhập `ADMIN_TOKEN` từ Environment.

Nếu tạo **Web Service** thủ công:

| Mục | Giá trị |
| --- | --- |
| Branch | `main` |
| Root Directory | Để trống |
| Runtime / Region / Plan | Node / Singapore / Free |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Environment | `NODE_ENV=production`, `NODE_VERSION=24.12.0`, `DATA_DIR=./data`, `PUBLIC_URL=https://<URL-thực-tế>`, `ADMIN_TOKEN`, `SESSION_KEY` |

Tạo **hai khóa khác nhau** bằng cách chạy lệnh sau hai lần, điền mỗi kết quả vào một biến tương ứng:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`SESSION_KEY` phải là base64 chuẩn của đúng 32 byte. Auto-deploy trong blueprint đã tắt; cập nhật bằng Manual Deploy sẽ làm mất dữ liệu tạm hiện có.

## 2. Đăng nhập, ghép người nhận, gửi thử

1. Tại `/admin`, bấm **Tạo QR đăng nhập**, quét bằng Zalo điện thoại của **tài khoản bot**, xác nhận đăng nhập.
2. Chờ **Đã kết nối — sẵn sàng gửi tin**. QR hết hạn thì tạo lại.
3. Nhập tên người nhận/thiết bị → **Tạo mã liên kết**. Lưu khóa thiết bị chỉ hiện **một lần** để cấu hình EXE sau.
4. Từ Zalo **người nhận**, kết bạn bot nếu cần, nhắn trực tiếp `OBEE <mã>` theo hướng dẫn trên trang. Mã có hạn 10 phút, dùng một lần; không gửi vào nhóm.
5. Khi hiện **Đã liên kết**, bấm **Gửi tin thử**, kiểm tra điện thoại người nhận. API Zalo chấp nhận gửi không có nghĩa người nhận đã nhận/đọc.
6. Tạo mã riêng cho từng người; mỗi người nhận chỉ liên kết một thiết bị đang hoạt động. Muốn đổi máy hoặc mất khóa thì **Thu hồi quyền**, tạo và ghép mới.
7. Đóng tab hoặc bấm **Khóa trang quản trị**. Không chia sẻ khóa quản trị, QR hoặc phiên Zalo.

**Bot không tự ghép với chính mình.** Nếu dùng Zalo cá nhân của bạn làm bot, cần tài khoản Zalo khác để nhận thử. Nên dùng bot riêng để bạn vẫn nhận cảnh báo vào Zalo chính.

Không mở Zalo Web khác cùng tài khoản vì có thể ngắt listener bot. Mất kết nối thì bấm **Kết nối lại phiên đã lưu**; nếu hết phiên thì **Xóa phiên Zalo**, quét lại. Không tự reconnect vô hạn, không có hàng đợi tự gửi lại. Database gắn với bot đầu tiên, không cho âm thầm đổi tài khoản bot mà giữ liên kết người nhận cũ.

## 3. API cho EXE (tích hợp sau)

HTTPS, header `Authorization: Bearer <khóa-thiết-bị>`. Không nhúng `ADMIN_TOKEN` vào EXE, không dùng khóa trong query string.

- `GET /api/v1/status`: `{ "linked": true, "bot": { "state": "connected", "ready": true } }` khi sẵn sàng.
- `POST /api/v1/alerts`, `Content-Type: application/json`:

```json
{
  "eventId": "961c8a01-260d-4eb3-8344-8484f76a144b",
  "kind": "failed",
  "punch": "in",
  "scheduledAt": "2026-11-27T07:55:00+07:00",
  "reason": "ip_invalid"
}
```

- `eventId`: UUID tạo một lần, lưu bền vững cho sự kiện. Dùng lại cùng ID/payload; không tạo ID mới khi kết quả chưa rõ.
- `kind`: `failed` / `missed`; `punch`: `in` / `out`.
- `scheduledAt`: ISO 8601 có offset, trong ±7 ngày so với giờ dịch vụ. Tin hiển thị giờ Việt Nam.
- `reason`: `ip_invalid`, `gps_invalid`, `wifi_failed`, `login_expired`, `no_shift`, `server_rejected`, `network_error`, `unknown_result`, `app_unavailable`.
- Từ chối trường ngoài hợp đồng, nội dung tin tùy ý, ID người nhận, tọa độ, cookie/mật khẩu.

| HTTP | Ý nghĩa |
| --- | --- |
| 200 `sent` | API Zalo nhận yêu cầu gửi; `duplicate: true` nếu sự kiện này đã gửi, không gửi lại. |
| 400 / 413 | Sai hợp đồng / body quá 4 KB. |
| 401 / 403 | Khóa sai/bị thu hồi hoặc origin bị chặn. |
| 409 `device_not_paired` | Chưa ghép Zalo. |
| 409 `sending` / `unknown` | Đang gửi hoặc kết quả chưa rõ; không gửi lại bằng ID mới. |
| 409 `event_payload_conflict` | Cùng ID nhưng payload khác. |
| 429 | Đạt giới hạn. |
| 503 | Bot chưa kết nối hoặc đang gửi sự kiện khác; chưa claim gửi. |
| 502 `unknown` | Gửi lỗi/timeout, có thể Zalo đã nhận; không tự thử lại bằng ID mới. |

Một tin đang gửi tại một thời điểm. Giới hạn 3 tin/phút/thiết bị, 20 tin/24 giờ/thiết bị, 60 tin/giờ toàn bot, gồm tin thử/kết quả không rõ. Claim ghi trước khi gửi; nếu process dừng nhưng database còn thì claim chuyển `unknown` khi mở lại. **Render Free xóa database khi restart nên không giữ được bảo vệ này qua restart.**

## 4. Bảo mật và giới hạn

- Phiên Zalo mã hóa AES-256-GCM; token và mã ghép lưu hash. Người có quyền Render và khóa mã hóa vẫn có thể giải mã phiên; bật 2FA cho tài khoản Render.
- SQLite lưu ID người nhận, tên thiết bị, hash event và trạng thái; không lưu nội dung hội thoại/cảnh báo. Bot chỉ xử lý lệnh ghép trực tiếp, không phản hồi/lưu chat riêng.
- QR chỉ trả qua endpoint quản trị có Bearer token; không lưu QR ra disk/log. Khóa quản trị chỉ giữ trong RAM tab, không lưu cookie/localStorage.
- Không mở CORS, kiểm tra origin, dùng CSP. Không bật debug log có cookie/auth header.
- Thu hồi khóa chặn request mới, không thu hồi tin đã gửi. Lộ khóa quản trị: đổi trên Render/redeploy và xem lại thiết bị. Lộ phiên: đăng xuất thiết bị Web trong Zalo rồi đăng nhập lại.
- `node:sqlite` có cảnh báo experimental trên Node đã pin; `zca-js` dùng gián tiếp `crypto-js` đã ngừng bảo trì. Audit không có lỗ hổng đã biết không đồng nghĩa an toàn tuyệt đối.
- Chưa có database ngoài, heartbeat theo dõi máy tắt, tự chuyển Wi-Fi hoặc tích hợp EXE. Máy tắt/mất mạng không tự gửi cảnh báo ngay được.
- Trước khi dùng lâu dài: thay SQLite tạm bằng database ngoài lưu bền vững và kiểm thử restart/redeploy. Không chỉ đổi `DATA_DIR` thành một đường dẫn khác trên Free.

## 5. Chạy cục bộ và kiểm thử

Node **24.12.0**:

```powershell
npm ci
Copy-Item .env.example .env
# Điền ADMIN_TOKEN, SESSION_KEY khác nhau trong .env bằng lệnh tạo khóa ở trên.
npm run dev
```

Mở `http://localhost:10000/admin`. Development chỉ bind loopback; production yêu cầu HTTPS origin. Không commit `.env`, `data/`, `node_modules/`, cookie hoặc QR.

```powershell
npm run check
npm audit --omit=dev
```

Tests dùng SQLite thật và bot giả lập: auth, bảo vệ QR, ghép/hết hạn/thu hồi, mã hóa/tamper, khóa danh tính bot, khôi phục claim, chống trùng, rate limit, timeout. Không đăng nhập/gửi Zalo thật trong test.

**Kiểm tra thủ công trên Render:** quét QR, ghép một Zalo khác, nhận một tin thử, kiểm tra khóa thu hồi bị từ chối. Khi dùng Free, restart/redeploy phải được coi là mất toàn bộ dữ liệu tạm và cần setup lại. Chưa được xác nhận hoạt động thực tế trên Render/Zalo chỉ bằng kết quả test giả lập.
