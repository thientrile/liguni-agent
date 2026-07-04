# ai-team

CLI orchestrator kiểu **một lead, nhiều worker**. Claude Code làm tech lead, phân việc cho Codex (triển khai) và một critic read-only (phản biện kiến trúc), mỗi worker chạy cô lập, **không bao giờ tự merge/push**.

```
Claude Code (lead)
   ├─ critic (gemini nếu có, else `claude -p`)  → phản biện read-only
   └─ Codex (codex exec)                        → triển khai trong git worktree riêng
Human → duyệt & merge thủ công
```

## Yêu cầu

| Công cụ | Bắt buộc | Ghi chú |
|---|---|---|
| Node.js ≥ 18 | ✅ | chạy orchestrator |
| [Codex CLI](https://developers.openai.com/codex/cli) | ✅ | implementer — `codex login` trước |
| [Claude Code](https://code.claude.com) | ✅ | lead + critic fallback |
| Gemini CLI | ⬜ | critic ưu tiên; thiếu thì tự dùng `claude -p` |
| Git | ⬜ | có repo → worktree cô lập; không có → sửa in-place |

Kiểm tra nhanh:
```bash
node --version && codex login status && claude --version
```

## Cài & chạy

```bash
git clone <repo-url> && cd liguni-agent
```

**Cách 1 — qua Claude Code (khuyến nghị):** mở Claude Code trong thư mục này rồi gõ:
```
/team xây retry + idempotency cho notification service
```

**Cách 2 — chạy tay:**
```bash
node tools/ai-team.mjs "xây retry + idempotency cho notification service"
# hoặc: npm run team -- "..."
```

Cờ:
- `--no-review` — bỏ critic
- `--in-place` — sửa thẳng thư mục hiện tại, không tạo worktree
- `--task-id <id>` — id cố định cho `.ai/tasks/<id>/` (lead dùng để đọc status/diff)
- `--review-file <path>` — dùng phân tích của specialist thay critic nội bộ (lead bơm vào)

Env (tùy chọn): `CODEX_MODEL`, `GEMINI_MODEL`, `CODEX_TIMEOUT_MS` (mặc định 20 phút), `REVIEW_TIMEOUT_MS` (5 phút).

## Luồng chạy

Khi gọi qua `/team`, lead **phân công cho specialist agent** theo domain (Backend Architect, Security Architect, Code Reviewer…) — xem `.claude/skills/team/SKILL.md`:

1. **Phân công** — lead in bảng ai làm gì.
2. **Review** — specialist khảo sát repo read-only, trả kế hoạch + rủi ro + test case → gộp vào `.ai/reviews/<id>.md`.
3. **Codex** triển khai trong branch cô lập `ai/codex-<id>` (worktree) với guidance của specialist.
4. **Review đối kháng** — Code Reviewer / chuyên gia bảo mật soi diff.
5. Lead báo cáo + in **diff + hướng dẫn merge**. Bạn review rồi merge **thủ công**.

Chạy tay `node tools/ai-team.mjs` (không qua `/team`) thì bước review dùng critic CLI (gemini/`claude -p`) thay vì specialist.

Kết quả lưu ở `.ai/tasks/<task-id>/`:
```
request.md · review.md · codex-result.md · status.json · *.log
```

## An toàn (mặc định)

- **1 writer / 1 worktree** — không có chuyện nhiều AI sửa chung cây thư mục.
- **Không bao giờ tự merge/push** — luôn có human gate trước khi vào nhánh chính.
- Codex chạy sandbox `workspace-write`, **network TẮT** → dù bị prompt-injection cũng không exfiltrate/push ra ngoài được.
- Không truyền secret của lead sang worker (env allowlist).
- `.ai/` và worktree được `.gitignore` để không lọt log/artifact vào git.

## Dùng ở mọi dự án ("bật đâu cũng được")

Mặc định skill này **project-scoped** (chỉ chạy trong thư mục repo). Muốn `/team` dùng được ở bất kỳ dự án nào:

```bash
# 1. Copy skill sang global
cp -r .claude/skills/team ~/.claude/skills/team

# 2. Sửa ~/.claude/skills/team/SKILL.md: đổi
#      node tools/ai-team.mjs "$ARGUMENTS"
#    thành path tuyệt đối:
#      node /đường/dẫn/liguni-agent/tools/ai-team.mjs "$ARGUMENTS"
```

Lúc đó lead chạy ở repo nào cũng gọi được, và Codex sẽ triển khai vào **repo đang mở** (cwd), không phải repo liguni-agent.

## Cấu trúc

```
tools/ai-team.mjs          # orchestrator
.claude/skills/team/       # lệnh /team cho Claude Code
.ai/                       # artifacts theo task (gitignored)
```

## Còn hoãn (roadmap)

JSON output-schema cho worker · `trace.jsonl` mỗi bước · task state machine đầy đủ · giới hạn token/chi phí. Thêm khi thực sự cần (YAGNI).
