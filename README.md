# Personal AI Orchestrator

Nền tảng điều phối AI cá nhân có kiểm soát, nhận yêu cầu từ terminal và Telegram, lập kế hoạch, chờ phê duyệt, thực thi trong giới hạn, kiểm chứng kết quả và lưu bằng chứng. Dự án ưu tiên baseline đơn-agent; Multi-Agent System chỉ được xem xét sau khi baseline ổn định và có số liệu.

## Trạng thái

P2 - Planning + Approval. P1 remains available; P2 adds validated plans, version/hash binding, authenticated approval and a frozen PENDING queue. No model calls, Telegram transport, execution worker or Git automation.

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

Codex SDK đã có adapter và tùy chọn dự kiến `read-only`, không approval, không network. P1 chưa gọi model vì sandbox read-only chưa chứng minh được yêu cầu cấm hoàn toàn shell; adapter sẽ từ chối an toàn thay vì chỉ dựa vào prompt.

## Cài đặt

Yêu cầu môi trường đã kiểm tra cho P0: Node.js 24.x, npm 11.x và Git 2.55.x.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Sao chép `.env.example` thành `.env` khi bắt đầu cấu hình cục bộ. Không commit `.env`, token, API key, credential hoặc dữ liệu cá nhân.

## CLI P1

Chỉ truyền tên lệnh qua arguments. Prompt được đọc từ stdin (file UTF-8 cục bộ được bảo vệ), không truyền nội dung prompt qua arguments hoặc lệnh chứa prompt trực tiếp.

Windows Command Prompt (`cmd.exe`):

```bat
npm run cli -- /ban-luan < "C:\private\topic.txt"
```

Bash:

```bash
npm run cli -- /ban-luan < /private/topic.txt
```

```bash
npm run cli -- /xem
npm run cli -- /giao-tele
```

`/ban-luan` ghi artifact hệ thống vào `_bmad-output/orchestrator/<run-id>/`, sau đó trả trạng thái bị chặn vì AI chưa được phép chạy. `/xem` chỉ đọc artifact gần nhất. `/giao-tele` dùng interface gửi tin nhưng sẽ bị chặn cho tới khi Telegram transport được cấu hình và kiểm thử.

CLI từ chối prompt trong arguments và stdin rỗng; không nhập trực tiếp tại TTY để tránh echo. Npm vẫn có thể in arguments nếu người dùng truyền sai cách; CLI không thể xóa output đã được tiến trình cha in ra. File prompt do người dùng quản lý; không đặt vào repo hoặc log.

P1 chỉ cho phép `RECORDED` → một kết quả `BLOCKED` hoặc `DISCUSSION_READY`; không append sau kết quả cuối. Cả Markdown và event log được xác thực trước khi append/đọc. Run mới nhất dựa trên timestamp đầy đủ của event `discussion.recorded`, không dựa trên hậu tố ID; nếu timestamp mới nhất trùng hoàn toàn thì báo lỗi an toàn. Mọi entry mang tên run hợp lệ nhưng hỏng hoặc là link đều chặn việc đọc, kể cả run cũ.

Giới hạn: chưa có khóa chống ghi đồng thời, chưa ghi hai file theo transaction/atomic và chưa loại bỏ TOCTOU. Lỗi giữa hai lần ghi có thể để lại artifact dở; cặp dữ liệu lệch bị chặn khi đọc, không tự khôi phục. Run chỉ có `RECORDED` vẫn có thể là run bị gián đoạn; chưa có recovery trong P1.

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

## CLI P2: internal planning and approval

Set `WORKSPACE_ROOT`, `PLANNING_HMAC_KEY` (a persistent, randomly generated 32-byte key encoded as 64 lowercase hex characters), and `PLANNING_APPROVERS` (exact OS usernames, comma-separated) through a trusted environment. Keep the key outside the repository/artifacts and out of arguments/logs. CLI does not load `.env` automatically. Missing key/allowlist or a changed key blocks access. Removing an approver invalidates their existing approval.

CLI identity comes from `node:os.userInfo().username`, never stdin. The internal service's `authenticate` callback must obtain identity from a trusted authenticated channel, never an arbitrary payload. OS accounts able to read the key are trusted; remote/multi-user authentication is outside P2.

After `/ban-luan` has created a P1 discussion artifact (including BLOCKED while the model is disabled):

```text
/planning-start       Create DISCUSSION from the latest validated P1 discussion
/done                 stdin JSON PlanInput -> PLANNING
/plan                 Show validated plan, hash/version, state, approval and queue
/status               Show the validated snapshot
/request-approval     PLANNING -> WAIT_APPROVAL
/ok                   stdin JSON {planId, planVersion, planHash} -> READY_FOR_EXECUTION
/no                   WAIT_APPROVAL or READY_FOR_EXECUTION -> a new PLANNING version
```

Run `npm run cli -- <command>`. For `/done`, `/ok`, `/no`, redirect stdin from a private UTF-8 file as documented for P1. `/no` accepts a replacement PlanInput, or empty redirected stdin to retain content with a new version. One P2 workflow per workspace; `/planning-start` never overwrites an existing snapshot. P2 commands are CLI/internal-service only; the Telegram adapter remains P1.

Example PlanInput (data only; content is never executed):

```json
{
  "goal": "Add regression coverage",
  "steps": [{"id": "T1", "description": "Add a test", "goal": "Prevent regression", "expectedResult": "Test passes"}],
  "expectedFiles": ["tests/example.test.ts"],
  "acceptanceCriteria": ["Regression test passes"],
  "risks": []
}
```

Validation rejects missing/extra fields, wrong types, empty/control-character strings, duplicate step IDs, absolute/traversal paths, Windows reserved names, and existing symlink/junction ancestors in expected file paths. Limits: 100 steps/items per list, 4096 characters/string, 240 characters/path, 256 KiB input. Risks may be empty; steps/files/acceptanceCriteria may not. Plan text cannot override policy or grant execution permissions.

SHA-256 hashes UTF-8 JSON in fixed order: `planId`, `version`, `createdAt`, `goal`, `steps` (each: `id`, `description`, `goal`, `expectedResult`), `expectedFiles`, `acceptanceCriteria`, `risks`, `status`. Array order matters; strings are not trimmed. Only `planHash` is excluded. The plan content's status stays `PROPOSED`; workflow state is separate so approval always refers to the same content hash.

P2's source of truth is `_bmad-output/orchestrator/planning.json`: an envelope `{body, mac}` with HMAC-SHA256 over the exact body string. Body contains plan, approval, PENDING queue and transition history. Each transition writes one exclusive temporary file, syncs/closes it, then renames it over the snapshot. Failures before rename preserve the prior snapshot. This is not a multi-file transaction or a guarantee of power-loss durability. Restart ignores orphan temporary files; missing/corrupt canonical snapshots, invalid signatures or inconsistent schema/events/state/approval/queue fail closed without fallback or repair. P1 prompts are omitted; PlanInput is deliberately persisted, so do not include secrets in plans. Events contain only state/time/version/hash.

Flow: `DISCUSSION -> PLANNING -> WAIT_APPROVAL -> READY_FOR_EXECUTION`. Only `/ok` from WAIT_APPROVAL with an exact reference creates approval (planId, planVersion, planHash, approverId, approvedAt) and a hash-bound PENDING queue. `/no` from WAIT_APPROVAL or READY_FOR_EXECUTION increments the version, clears approval/queue and returns to PLANNING. Direct file edits are rejected; supported revisions require `/no` and fresh approval. Duplicate approval and other transitions fail without writes. READY does not launch anything; there is no RUNNING state or execution API.

All P2 reads/mutations acquire an exclusive filesystem directory `planning.lock`; overlapping operations are rejected without implicit retry. A crash can leave this lock: stop all related processes, inspect the snapshot/backup, and have an administrator remove the lock only after confirming no operation is active. There is no automatic PID/timeout lock breaking. Restart verifies signature, schema, events and approval before exposing state. Workflows are capped at 1000 events and 512 KiB snapshot body.

Security limits: path checks cannot eliminate filesystem TOCTOU against a hostile local process. HMAC detects edits but cannot detect replay of an entire previously valid signed snapshot; a trusted monotonic store is required before real execution. Protect the key/workspace/artifacts with OS permissions; this is not a multi-user deployment. Missing snapshots are never automatically recreated.

Before P3: approve the execution sandbox/allowlist design, add monotonic rollback protection, then implement queue worker, timeout/retry/recovery and independent result verification. P2 never executes tasks or plan content.
