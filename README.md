# Personal AI Orchestrator

Nền tảng điều phối AI cá nhân có kiểm soát, nhận yêu cầu từ terminal và Telegram, lập kế hoạch, chờ phê duyệt, thực thi trong giới hạn, kiểm chứng kết quả và lưu bằng chứng. Dự án ưu tiên baseline đơn-agent; Multi-Agent System chỉ được xem xét sau khi baseline ổn định và có số liệu.

## Trạng thái

P0 - Preparation. Repository mới chỉ có cấu hình, khung mã nguồn và fixture an toàn. Chưa có CLI, Telegram bot, state machine, worker, Git automation hoặc chức năng runtime của P1 trở đi.

## Kiến trúc dự kiến

```text
src/
  telegram/  # Bot, handlers, authentication
  cli/       # Terminal commands
  core/      # State machine, planner, task queue
  runner/    # Model subprocess, timeout, cancellation
  policy/    # Allowlist, approvals, safety checks
  verify/    # Tests, diff and done checks
  git/       # Branch, commit and push controls
  storage/   # Durable state, artifacts and cost logs
  hooks/     # Guard scripts
config/      # Policy and environment templates
tests/       # Unit, integration, safety tests and fixtures
_bmad-output/orchestrator/<run-id>/  # Generated artifacts; ignored by Git
```

Các thư mục chức năng sẽ chỉ được tạo khi pha tương ứng được duyệt. State store sẽ là nguồn trạng thái chuẩn; Markdown và JSON/JSONL là các artifact phục vụ kiểm tra và truy vết.

Luồng dự kiến: terminal/Telegram -> router và xác thực -> orchestrator -> planner hoặc worker -> safety gates -> verifier và artifact store. Git chỉ được thao tác qua policy và approval gate.

## Quyền mặc định

| Giai đoạn | Cho phép | Mặc định chặn |
| --- | --- | --- |
| Discussion | Đọc, grep, glob | Ghi file và chạy shell |
| Execution | Chỉ quyền/lệnh được duyệt theo task | Mọi quyền hoặc lệnh không có trong allowlist |

[`config/permissions.example.json`](config/permissions.example.json) là cấu hình mẫu fail-closed, chưa được nối vào runtime. Secret thật chỉ được đặt trong `.env` cục bộ; không ghi vào config, artifact hoặc log.

## Cài đặt

Yêu cầu môi trường đã kiểm tra cho P0: Node.js 24.x, npm 11.x và Git 2.55.x.

```bash
npm ci
npm run typecheck
npm run build
```

Sao chép `.env.example` thành `.env` khi bắt đầu cấu hình cục bộ. Không commit `.env`, token, API key, credential hoặc dữ liệu cá nhân.

## Lộ trình

| Pha | Phạm vi |
| --- | --- |
| P0 | Repo, môi trường, cấu hình, sơ đồ quyền và fixture |
| P1 | Terminal/Telegram, discussion artifacts và read-only policy |
| P2 | Lập kế hoạch, hash phiên bản và approval |
| P3 | Worker, state machine, queue, timeout, retry và recovery |
| P4 | Git controller và safety gates |
| P5 | Stop/resume, process cancellation và limits |
| P6 | Kiểm thử lỗi, ổn định và đo baseline |
| P7 | Đánh giá MAS sau khi baseline đạt yêu cầu |

Không chuyển pha nếu điều kiện nghiệm thu của pha hiện tại chưa đạt hoặc chưa được phê duyệt.
