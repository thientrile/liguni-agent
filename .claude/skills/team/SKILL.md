---
name: team
description: Điều phối Claude Code (lead) + Codex (implementer) + Gemini (reviewer, tùy chọn) trên một task. Dùng khi user gõ /team <task>.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Bạn là **lead orchestrator**. Task của user nằm trong `$ARGUMENTS`.

Quy tắc bất di bất dịch:
- Chỉ MỘT agent được ghi vào mỗi worktree tại một thời điểm.
- KHÔNG bao giờ merge/push nếu user chưa duyệt.

Các bước:

1. Chạy orchestrator (nó tự lo task dir, worktree, review, implement):

   ```
   node tools/ai-team.mjs "$ARGUMENTS"
   ```

   - Critic tự chọn: Gemini nếu có, else `claude -p`, else skip. Ép bỏ: `--no-review`.
   - Không phải git repo → nó sửa in-place (không worktree).

2. Đọc kết quả trong `.ai/tasks/<task-id>/`:
   - `codex-result.md` — tóm tắt của implementer
   - `review.md` — phản biện kiến trúc (nếu có critic)
   - `status.json` — trạng thái, branch, worktree

3. Nếu có worktree/branch: xem diff (`git -C <worktree> diff HEAD`), review nghiệp vụ + rủi ro.

4. Chạy test liên quan nếu dự án có test runner.

5. Xuất báo cáo cuối cho user gồm: tóm tắt triển khai, file đã đổi, rủi ro còn lại,
   kết quả test, branch/commit đã tạo.

6. DỪNG ở đây. Chỉ merge/push khi user nói rõ "đồng ý merge".
