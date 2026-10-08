# AI & Tech YouTube Shorts

Pipeline NestJS/TypeScript tạo một bản tin tiếng Việt mỗi ngày: tìm nguồn → chọn 3 mục → script/verify → storyboard → voice + visuals → subtitle → FFmpeg → QC → Telegram review → YouTube.

## Chạy demo ngay trên Windows

Yêu cầu Node.js 22+. Không cần PostgreSQL, Redis hay API key cho demo.

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run check
npm.cmd run demo
```

Demo chạy database PostgreSQL mô phỏng trong RAM, điều phối từng step trực tiếp và dùng FFmpeg thật. `storage/demo-latest.json` ghi run, logs, QC và đường dẫn MP4/thumbnail. Video 55 giây, 1080×1920, 30fps, H.264/AAC, có motion và subtitle tiếng Việt. Dữ liệu demo là giả; voice demo là âm thanh thử nghiệm, không phải TTS. YouTube/Telegram đều mock. Không dùng demo để kiểm chứng chất lượng tin hoặc giọng đọc thật.

FFmpeg/ffprobe cho dev được cung cấp qua package theo hệ điều hành; nếu không chạy được, cài FFmpeg có libass rồi đặt `FFMPEG_PATH` và `FFPROBE_PATH`. Production cần cài FFmpeg/ffprobe trực tiếp trên máy chạy worker. Font hiện dùng Arial/Liberation Sans để hỗ trợ tiếng Việt.

## Chạy với PostgreSQL/Redis

Chạy Node.js trực tiếp trên Windows hoặc Linux. Cài [PostgreSQL native](https://www.postgresql.org/download/windows/) hoặc dùng server PostgreSQL riêng. Với Redis trên Windows, dùng [Memurai hoặc Redis qua WSL theo hướng dẫn chính thức](https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-on-windows/); cũng có thể trỏ đến Redis server riêng.

Tạo role/database `shorts`, đặt password đúng giá trị `POSTGRES_PASSWORD` được `setup` tạo trong `.env`; cập nhật `DATABASE_URL` và `REDIS_URL` theo host/port thực tế. `POSTGRES_PASSWORD` là giá trị hỗ trợ thiết lập database, app kết nối bằng `DATABASE_URL`. Có thể tạo bằng SQL dưới đây, hoặc điền `POSTGRES_ADMIN_URL` ở `.env` rồi chạy `npm.cmd run db:init`. Lệnh chỉ tạo role/database chưa có, giữ nguyên password của role đã tồn tại. Admin connection chỉ được script khởi tạo sử dụng; API/worker dùng role riêng trong `DATABASE_URL`.

```sql
CREATE ROLE shorts LOGIN PASSWORD '<password-tu-env>';
CREATE DATABASE shorts OWNER shorts;
```

```powershell
npm.cmd run setup
# Nếu dùng Ubuntu WSL đã có Redis (mặc định distro Ubuntu-22.04):
npm.cmd run redis:start
# Sau khi điền POSTGRES_ADMIN_URL vào .env:
npm.cmd run db:init
npm.cmd run doctor
npm.cmd run migrate
npm.cmd run build
npm.cmd start
# Terminal thứ hai:
npm.cmd run worker
```

`setup` tạo `.env` với admin token và mật khẩu DB ngẫu nhiên, giữ nguyên file nếu đã có. `.env` và `storage` được gitignore. `doctor` kiểm tra kết nối PostgreSQL/Redis và FFmpeg, không in secrets. Nếu dịch vụ chưa cài/chưa chạy hoặc URL chưa đúng, sửa cấu hình trước khi migrate/start.

`redis:start` dùng Redis binary đã có trong Ubuntu WSL, tạo instance riêng ở cổng 6380, chỉ bind loopback/IP của WSL, có mật khẩu ngẫu nhiên, AOF persistence và `noeviction`. Không thay đổi Redis hiện có ở cổng 6379. Data/config/log nằm ở `storage/redis`; `REDIS_URL` được cập nhật cục bộ, không in password. Có thể chọn distro bằng `REDIS_WSL_DISTRO`. Sau khi reboot/WSL đổi IP, chạy lại lệnh rồi restart API/worker. Helper không cài Redis, không đăng ký startup service cho Windows/WSL.

Queue được tách namespace qua `QUEUE_PREFIX=ai-tech-shorts`, tránh trộn job với các app khác trên cùng Redis.

API mặc định bind `127.0.0.1:3000` qua `HOST`; cần truy cập từ máy khác thì cấu hình bind/reverse proxy. PostgreSQL và Redis nên chỉ nhận kết nối từ app. Nếu triển khai webhook Telegram từ internet, đặt API sau reverse proxy HTTPS và chỉ expose đường dẫn webhook cần thiết. Production chạy API và worker thành hai process/service riêng; khi restart, worker phục hồi job từ DB/Redis.

## Trigger và duyệt

Đọc `ADMIN_TOKEN` từ `.env` và đặt vào biến shell cục bộ, không gửi token lên chat.

```powershell
$shortsHeaders = @{ Authorization = "Bearer $shortsAdminToken" }
$shortsRun = Invoke-RestMethod http://localhost:3000/pipeline/run -Method Post -Headers $shortsHeaders
Invoke-RestMethod "http://localhost:3000/pipeline/$($shortsRun.id)" -Headers $shortsHeaders
# Chỉ thực hiện sau khi run có status WAITING_APPROVAL:
$shortsBody = @{ revision = 1 } | ConvertTo-Json
Invoke-RestMethod "http://localhost:3000/pipeline/$($shortsRun.id)/publish" -Method Post -Headers $shortsHeaders -ContentType application/json -Body $shortsBody
```

Endpoints:

| Endpoint                              | Body                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `POST /pipeline/run`                  | Không cần body; trả lại run đã có nếu cùng ngày       |
| `GET /pipeline/today`                 | —                                                     |
| `GET /pipeline/:id`                   | —                                                     |
| `POST /pipeline/:id/publish`          | `{ "revision": 1 }`                                   |
| `POST /pipeline/:id/skip`             | `{ "revision": 1 }`                                   |
| `POST /pipeline/:id/regenerate`       | `{ "revision": 1, "target": "script" }`               |
| `POST /pipeline/:id/retry`            | `{ "revision": 1, "step": "upload" }`                 |
| `POST /pipeline/:id/reconcile-upload` | `{ "revision": 1, "video_id": "..." }`                |
| `GET /health`                         | DB readiness; không thể hiện worker/Redis readiness   |
| `POST /telegram/webhook`              | Telegram update; xác thực webhook secret và whitelist |

`target` nhận `script`, `voice`, `visuals`, `render`. Mỗi regenerate tạo revision mới, tái sử dụng step upstream đã thành công, chạy lại các bước phụ thuộc và hủy approval cũ. Bản đã bắt đầu upload không được regenerate để tránh tạo video trùng.

## Nối OpenAI thật

Trong `.env`, đặt `OPENAI_API_KEY`, `MOCK_OPENAI=false`, chọn các model qua `OPENAI_*_MODEL`. Model defaults là cấu hình khởi điểm; cần kiểm tra quyền truy cập model của project trước khi dùng.

Web Search chạy trên Responses API; lấy URL từ citation/source annotations rồi đọc bài nguồn, chỉ chấp nhận HTTPS trên allowlist. Thời gian đăng lấy từ `datePublished` hoặc metadata publication, không lấy `dateModified`. Trang không lấy được ngày hoặc nội dung sẽ bị loại. Structured outputs có JSON schema và được kiểm tra lại bằng Zod. Fact verification dùng đoạn bằng chứng; không phải bảo đảm tuyệt đối về độ đúng của tin.

Web Search bắt buộc thực hiện tìm kiếm; nếu API không trả `web_search_call`, run báo lỗi rõ thay vì coi là thiếu tin. Log trong `storage/diagnostics/<runId>/rev-<revision>/discovery-<hours>h.json` ghi nguồn, ngày công bố và lý do loại. Mặc định tìm trong 24 giờ rồi mở rộng tối đa 48 giờ. Có thể đặt `MAX_NEWS_AGE_HOURS=168` trong `.env` để thử bản tin tổng hợp 7 ngày; tin quá 24 giờ luôn đọc rõ ngày nguồn và description ghi ngày từng bài. Restart API/worker sau khi đổi cấu hình; regenerate từ `discover` để tìm lại nguồn.

Prompt nằm trong `prompts/*.md` với version đầu file. Tin thiếu thì mở rộng 48h; chọn 3 tin hoặc 2 tin + 1 tool có nguồn. Không đủ thì skip. Tin đã dùng trong run đã upload sẽ bị dedup ở các ngày sau.

TTS tạo riêng từng scene để có timing thật, sau đó ghép audio. Ngoài 40–65 giây cần sửa script; 45–60 giây đạt mục tiêu. Subtitle chia chunk tối đa 6 từ/2 dòng, timing theo scene và tỷ lệ từ; chưa có word alignment chính xác. Image API dùng ảnh portrait rồi scale/crop về 9:16, thẻ tiêu đề/source được render bằng code. Provider image lỗi tạm thời dùng headline card; lỗi credentials/budget dừng run.

Chi phí hiện là **reservation theo cấu hình**, không phải hóa đơn thực tế. Mỗi lần gọi kể cả retry đều giữ reservation; lưu thêm usage/tokens nếu provider trả. Đặt các giá trị reserve đủ cao cho model, search tool và chất lượng ảnh đang dùng. `MAX_RUN_COST_USD` chặn khi tổng reservation vượt ngân sách; không phải giới hạn spend tuyệt đối tại nhà cung cấp. V1 chưa tự tải bảng giá hoặc tính chính xác search/image/TTS billing.

## Telegram

Tạo bot qua BotFather; đặt `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS` (ID user, phân cách bằng dấu phẩy), `TELEGRAM_WEBHOOK_SECRET` (ngẫu nhiên ít nhất 32 ký tự), `MOCK_TELEGRAM=false`.

Đăng ký webhook qua Bot API `setWebhook` với HTTPS URL trỏ tới `/telegram/webhook` và `secret_token` đúng giá trị `.env`. Webhook ghi update vào inbox bền vững; worker xử lý theo `update_id`. Cần cả chat ID và user ID đúng whitelist. Commands luôn có run ID và revision:

```text
/publish <runId> <revision>
/regenerate <runId> <revision> script|voice|visuals|render
/skip <runId> <revision>
/status <runId> <revision>
```

Bot gửi video preview, nguồn, QC, reservation chi phí và các lệnh. Approval hết hạn sau 24h kể từ QC; cần regenerate script để kiểm chứng lại. Preview quá 49 MiB bị chặn, cần giảm bitrate/độ phức tạp rồi render lại. Telegram gửi message có thể lặp khi provider timeout; publish và các thay đổi trạng thái có kiểm tra revision/idempotency nên không upload lặp theo số message.

## YouTube OAuth và private upload

1. Tạo Google Cloud project, bật YouTube Data API v3.
2. Cấu hình OAuth consent và Web OAuth client; thêm test user nếu app đang Testing.
3. Đăng ký redirect chính xác `http://127.0.0.1:8765/oauth/callback`.
4. Đặt `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`, chạy `npm.cmd run oauth`.
5. Mở consent URL được in ở terminal, chọn tài khoản sở hữu kênh. Scope gồm `youtube.upload` và `youtube.readonly` để đối soát ownership.
6. Script lưu refresh token tại `storage/youtube-oauth.json`. Copy token vào `.env` mục `YOUTUBE_REFRESH_TOKEN`; token không được in ra console.
7. Đặt `MOCK_YOUTUBE=false`, `YOUTUBE_PRIVACY_STATUS=private`. Cần `MOCK_OPENAI=false`; startup chặn live upload nội dung mock.

Token được refresh tự động khi hết hạn. Nếu OAuth app đang Testing hoặc grant bị thu hồi, có thể cần consent lại; xem cấu hình OAuth trên Google Cloud trước khi vận hành lâu dài.

Upload chia chunk 8 MiB, lưu resumable session trước khi truyền file. Retry chỉ chạy step upload, kiểm tra byte offset từ YouTube trước khi tiếp tục. Nếu không xác định được kết quả khởi tạo/session hết hạn, chuyển `UPLOAD_UNCERTAIN`; không tự tạo upload mới. Kiểm tra YouTube Studio, lấy ID video đã tồn tại và gọi reconcile endpoint; ownership được đối chiếu với kênh OAuth. Endpoint này là quyết định của admin rằng video ID đúng với revision đang đối soát. Không có endpoint tự reset session để tránh duplicate vô ý.

Upload private có status `UPLOADED_PRIVATE`; chỉ `PUBLISHED` khi response xác nhận public. V1 chưa tự chờ YouTube processing xong và chưa chuyển video private sang public bằng một lệnh riêng. Project API chưa qua audit có thể bị buộc private; thay env sang public không gỡ được giới hạn này.

## Scheduler và phục hồi

Mặc định `SCHEDULE_ENABLED=false`, `AUTO_PUBLISH=false`, privacy private. Sau khi đã chạy manual live thành công, bật `SCHEDULE_ENABLED=true`; worker đăng ký BullMQ Job Scheduler lúc 07:30 `Asia/Ho_Chi_Minh`. Một run duy nhất cho mỗi ngày địa phương, timestamp DB lưu UTC.

DB transaction ghi trạng thái bước và outbox cùng nhau. Dispatcher đẩy outbox vào BullMQ với job ID `runId-step-rN`. Job hoàn thành không được chạy lại nếu step đã thành công. Các bước assets chạy độc lập; render chờ visuals và subtitles. Worker heartbeat lease; lease hết hạn được đưa lại vào outbox. Retry tạm thời tối đa 3 lần thực thi; `FAILED`, `NEEDS_REVISION`, `SKIPPED`, `UPLOAD_UNCERTAIN` được lưu với step/lỗi cụ thể.

Regenerate target từ API có thể khôi phục run thất bại trước upload; upstream nào chưa thành công sẽ chạy lại. `retry` chỉ áp dụng run `FAILED`, chạy lại đúng step lỗi với revision hiện tại và giữ các bước đã thành công. Với upload có session hợp lệ, retry sẽ đối chiếu trạng thái session rồi tiếp tục; `UPLOAD_UNCERTAIN` cần kiểm tra Studio và đối soát, không dùng regenerate hoặc tự mở session mới. Không có cron catch-up cho ngày đã bỏ lỡ; trigger manual tạo run cho ngày hiện tại.

Chỉ bật auto-publish sau giai đoạn review ổn định: tất cả providers live, fact verification pass, tất cả hard QC pass, score ≥85, duration 45–60s. V1 vẫn upload theo privacy config, mặc định private.

## Kiểm tra và giới hạn nghiệm thu

`npm run check`: TypeScript build và tests cho timezone, dedup/diversity, source parsing, subtitle, revision/approval, dependency join, cost budget và upload gates. Tests DB mặc định dùng pg-mem, không chứng minh được transaction/row locking của PostgreSQL thật. `npm run demo` kiểm tra FFmpeg/ffprobe và toàn bộ mock flow.

Khi PostgreSQL/Redis đã kết nối: `npm run test:redis` kiểm tra retry/dedup BullMQ bằng namespace riêng; `npm run test:native` chạy full mock pipeline trên PostgreSQL/Redis thật, kiểm tra 8 trigger đồng thời, lease hết hạn, regenerate voice/tái sử dụng visuals, từ chối approval cũ và 8 yêu cầu publish đồng thời. Test native tạo run với ngày thử nghiệm xa tương lai để không chiếm run hôm nay, giữ assets/log để audit và ghi `storage/native-latest.json`. Chỉ chạy khi tất cả provider mock và scheduler/auto-publish tắt. Test native tự đóng API/worker của lượt test khi xong; không xóa dữ liệu dự án. Test HTTP cần quyền kết nối localhost, nếu môi trường sandbox chặn socket thì chạy ở terminal máy.

Trước production cần chạy với PostgreSQL/Redis thật, thử concurrent trigger, kill/restart worker, Telegram live, OpenAI live (nghe/xem tiếng Việt), OAuth refresh và upload private trên đúng kênh. Chưa nghiệm thu dịch vụ ngoài chỉ bằng mock pass.

Backup database PostgreSQL và thư mục storage; bật persistence Redis và giữ revision đang chờ duyệt/đang upload. V1 không tự xóa assets, không có analytics feedback, UI admin, text-to-video hay đa nền tảng. Scheduler và auto-publish là opt-in. Mốc vận hành 7 ngày/30 ngày trong đặc tả cần theo dõi thực tế sau deployment.

Nguồn kỹ thuật: [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [Image API](https://developers.openai.com/api/docs/guides/image-generation), [BullMQ Job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [Job Schedulers](https://docs.bullmq.io/guide/job-schedulers), [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert).
