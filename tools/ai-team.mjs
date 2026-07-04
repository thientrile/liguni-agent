#!/usr/bin/env node
// ai-team.mjs — orchestrator "một lead, nhiều worker".
// Lead (Claude Code, người gọi) điều phối:
//   - Implementer = Codex CLI (codex exec, GHI code, sandbox workspace-write, network TẮT)
//   - Critic      = Gemini nếu có, else `claude -p` (read-only). Tự skip nếu không có cái nào.
//
// Nguyên tắc: 1 writer / 1 worktree tại 1 thời điểm; KHÔNG bao giờ tự merge/push.
//
// Dùng:
//   node tools/ai-team.mjs "<task>"
//   node tools/ai-team.mjs --no-review "<task>"   # bỏ critic
//   node tools/ai-team.mjs --in-place  "<task>"   # sửa thẳng cwd, không worktree
//
// Env: CODEX_MODEL, GEMINI_MODEL, CODEX_TIMEOUT_MS, REVIEW_TIMEOUT_MS

import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { openSync, writeSync, unlinkSync, createWriteStream, readFileSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS) || 20 * 60_000;
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS) || 5 * 60_000;

// env allowlist truyền cho worker — KHÔNG rò secret của lead (API key…) sang codex/gemini.
// Worker tự đọc credential từ file config của chúng (~/.codex, ~/.gemini). ponytail: thêm var nếu worker thiếu.
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "CODEX_HOME", "CODEX_MODEL", "GEMINI_MODEL"];
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => ENV_ALLOW.includes(k)),
);

// --- args ---------------------------------------------------------------
// --review-file <path>: dùng phân tích của specialist (do lead Claude tạo) thay cho critic nội bộ.
// --task-id <id>: id cố định để lead biết trước .ai/tasks/<id>/ (đọc status.json, diff).
const opts = { noReview: false, inPlace: false, taskId: null, reviewFile: null, provider: null };
const positional = [];
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--no-review") opts.noReview = true;
  else if (a === "--in-place") opts.inPlace = true;
  else if (a === "--task-id") opts.taskId = rawArgs[++i];
  else if (a.startsWith("--task-id=")) opts.taskId = a.slice(10);
  else if (a === "--review-file") opts.reviewFile = rawArgs[++i];
  else if (a.startsWith("--review-file=")) opts.reviewFile = a.slice(14);
  else if (a === "--provider") opts.provider = rawArgs[++i];
  else if (a.startsWith("--provider=")) opts.provider = a.slice(11);
  else if (a.startsWith("--")) { console.error(`Cờ lạ: ${a}`); process.exit(1); }
  else positional.push(a);
}

// lệnh con `review`: chạy review CHỈ-ĐỌC trên 1 provider (mặc định Codex/OpenAI) để trải
// tải khỏi quota Claude. Lead gộp stdout vào review file. Không tạo worktree/lock/task dir.
if (positional[0] === "review") {
  const subTask = positional.slice(1).join(" ").trim();
  if (!subTask) { console.error('Usage: node tools/ai-team.mjs review [--provider codex|gemini|claude] "<task>"'); process.exit(1); }
  const provider = opts.provider || (probe("codex") ? "codex" : probe("gemini") ? "gemini" : "claude");
  const prompt = `Bạn là software architect CHỈ ĐỌC. KHÔNG sửa file.

Task:
${subTask}

Khảo sát repo hiện tại rồi trả về ngắn gọn:
1. Kế hoạch triển khai (các bước nhỏ)
2. Rủi ro kiến trúc / coupling
3. Rủi ro bảo mật & concurrency
4. Test case cần có
5. File có khả năng thay đổi`;
  let r;
  if (provider === "codex") {
    const a = ["exec", "-", "-s", "read-only"]; // read-only: không ghi được, an toàn cho review
    if (git(["rev-parse", "--is-inside-work-tree"]).out !== "true") a.push("--skip-git-repo-check");
    r = await run("codex", a, { timeoutMs: REVIEW_TIMEOUT_MS, input: prompt });
  } else if (provider === "gemini") {
    r = await run("gemini", [], { timeoutMs: REVIEW_TIMEOUT_MS, input: prompt });
  } else {
    r = await run("claude", ["-p"], { timeoutMs: REVIEW_TIMEOUT_MS, input: prompt });
  }
  process.exit(r.ok ? 0 : 1); // stdout đã stream ra sẵn
}

const task = positional.join(" ").trim();

if (!task) {
  console.error('Usage: node tools/ai-team.mjs [--no-review] [--in-place] [--task-id <id>] [--review-file <path>] "<task>"');
  console.error('       node tools/ai-team.mjs review [--provider codex|gemini|claude] "<task>"');
  process.exit(1);
}

// --- helpers ------------------------------------------------------------
// probe: tool có tồn tại & chạy được không (thay `command -v`/`where` vốn hỏng trên POSIX/Win).
function probe(cmd) {
  const r = spawnSync(cmd, ["--version"], { shell: IS_WIN, stdio: "ignore" });
  return !r.error; // error.code === 'ENOENT' nghĩa là thiếu
}
function loginOk(cmd, args) {
  const r = spawnSync(cmd, args, { shell: IS_WIN, stdio: "ignore" });
  return (r.status ?? 1) === 0;
}
function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function killTree(child, sig) {
  if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  }
}

// run: KHÔNG reject theo exit code — trả {ok,code,stdout,stderr}. Prompt đi qua STDIN
// (input) để né giới hạn 8191 ký tự & quoting/injection của cmd.exe trên Windows.
function run(command, args, { cwd = process.cwd(), timeoutMs = 0, logFile, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: IS_WIN, // cần để nạp shim .cmd trên Windows; payload đi qua stdin nên an toàn
      detached: !IS_WIN, // tạo process group để kill cả cây con khi timeout
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer, killTimer;
    const logStream = logFile ? createWriteStream(logFile, { flags: "a" }) : null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), 5000);
        killTimer.unref();
      }, timeoutMs);
    }

    const sink = (buf, out) => {
      const s = buf.toString();
      if (out) stdout += s; else stderr += s;
      (out ? process.stdout : process.stderr).write(buf);
      logStream?.write(s);
    };
    child.stdout.on("data", (b) => sink(b, true));
    child.stderr.on("data", (b) => sink(b, false));

    const done = (res) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      logStream?.end();
      resolve(res);
    };
    child.on("error", (err) =>
      done({ ok: false, code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` }));
    child.on("close", (code) => {
      if (timedOut) done({ ok: false, code: 124, stdout, stderr: stderr + `\n[timeout ${timeoutMs}ms]` });
      else done({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });

    if (input != null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

// --- preflight ----------------------------------------------------------
if (!probe("codex")) {
  console.error("❌ Cần Codex CLI (không tìm thấy). Cài rồi `codex login`.");
  process.exit(1);
}
if (!loginOk("codex", ["login", "status"])) {
  console.error("❌ Codex chưa đăng nhập. Chạy: codex login");
  process.exit(1);
}

// review: --review-file (specialist) ưu tiên; else critic CLI gemini > claude -p > none
let reviewer = null; // { name, cmd, args }
let externalReview = null;
if (opts.reviewFile) {
  try { externalReview = readFileSync(opts.reviewFile, "utf8"); }
  catch (e) { console.error(`❌ Không đọc được --review-file ${opts.reviewFile}: ${e.message}`); process.exit(1); }
} else if (!opts.noReview) {
  if (probe("gemini")) reviewer = { name: "gemini", cmd: "gemini", args: [] };
  else if (probe("claude")) reviewer = { name: "claude", cmd: "claude", args: ["-p"] };
}

const gitRoot = git(["rev-parse", "--is-inside-work-tree"]).out === "true";
const useWorktree = gitRoot && !opts.inPlace;

// --- process lock (atomic O_EXCL) ---------------------------------------
await mkdir(".ai", { recursive: true });
const lockFile = path.resolve(".ai", "team.lock");
let ownLock = false;
try {
  const fd = openSync(lockFile, "wx");
  writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
  ownLock = true;
} catch (e) {
  if (e.code === "EEXIST") {
    console.error(`❌ Đã có /team đang chạy. Nếu chắc chắn không, xoá: ${lockFile}`);
    process.exit(1);
  }
  throw e;
}
process.on("exit", () => { if (ownLock) try { unlinkSync(lockFile); } catch {} });

// --- task setup ---------------------------------------------------------
const taskId = opts.taskId
  ? opts.taskId.replace(/[^A-Za-z0-9._-]/g, "-")
  : `task-${Date.now()}`;
const taskDir = path.resolve(".ai", "tasks", taskId);
await mkdir(taskDir, { recursive: true });
const statusFile = path.join(taskDir, "status.json");

const status = {
  id: taskId,
  state: "starting",
  task,
  reviewer: externalReview ? "specialist" : (reviewer?.name ?? "none"),
  workspace: { mode: useWorktree ? "worktree" : "in_place", dir: null, branch: null },
  completed: [],
  createdAt: new Date().toISOString(),
};
const saveStatus = () => writeFile(statusFile, JSON.stringify(status, null, 2));
await writeFile(path.join(taskDir, "request.md"), `# Task\n\n${task}\n`);
await saveStatus();

let worktreeToClean = null; // { dir, branch, baseSha }
// Chỉ dọn worktree khi RỖNG (Codex chưa kịp làm gì). Có việc dở → GIỮ để chạy tiếp,
// tránh mất công khi lỗi tạm thời (hết limit, timeout). Thành công thì cũng giữ để người review.
async function fail(msg) {
  console.error(`\n❌ ${msg}`);
  status.state = "failed";
  status.error = msg;
  await saveStatus().catch(() => {});
  if (worktreeToClean) {
    const { dir, branch, baseSha } = worktreeToClean;
    const dirty = git(["-C", dir, "status", "--porcelain"]).out !== "";
    const moved = git(["-C", dir, "rev-parse", "HEAD"]).out !== baseSha;
    if (dirty || moved) {
      console.error(`\n   💾 GIỮ LẠI worktree (có việc dở): ${dir}`);
      console.error(`      Branch: ${branch}`);
      console.error(`      Xem: git -C "${dir}" diff HEAD`);
      console.error(`      Xong việc thì merge/dọn thủ công; muốn bỏ: git worktree remove --force "${dir}"`);
    } else {
      git(["worktree", "remove", "--force", dir]);
      git(["branch", "-D", branch]);
    }
  }
  process.exit(1);
}

console.log(`\n▶ ai-team ${taskId}`);
console.log(`  review  : ${externalReview ? "specialist (--review-file)" : (reviewer?.name ?? "skipped")}`);
console.log(`  git     : ${gitRoot ? "repo" : "no repo"} → ${useWorktree ? "worktree" : "in-place"}\n`);

// --- 1. Review: phản biện kiến trúc (read-only) -------------------------
let reviewText = "(bỏ qua — không có critic)";
if (externalReview) {
  reviewText = externalReview.trim() || "(rỗng)";
  await writeFile(path.join(taskDir, "review.md"), reviewText);
  status.completed.push("review");
  console.log("── [1/2] review: dùng phân tích specialist (--review-file) ──");
} else if (reviewer) {
  console.log(`── [1/2] ${reviewer.name}: phản biện kiến trúc (read-only) ──`);
  status.state = "reviewing";
  await saveStatus();
  const prompt = `Bạn là software architect CHỈ ĐỌC. KHÔNG sửa file.

Task:
${task}

Khảo sát repo hiện tại rồi trả về ngắn gọn:
1. Kế hoạch triển khai (các bước nhỏ)
2. Rủi ro kiến trúc / coupling
3. Rủi ro bảo mật & concurrency
4. Test case cần có
5. File có khả năng thay đổi`;
  const r = await run(reviewer.cmd, reviewer.args, {
    timeoutMs: REVIEW_TIMEOUT_MS,
    logFile: path.join(taskDir, "review.log"),
    input: prompt,
  });
  reviewText = (r.stdout.trim() || r.stderr.trim()) || "(rỗng)";
  await writeFile(path.join(taskDir, "review.md"), reviewText);
  status.completed.push("review");
  if (!r.ok) console.warn("⚠ critic lỗi — tiếp tục với ghi chú rỗng.");
} else {
  console.log("── [1/2] critic: SKIPPED ──");
}

// --- 2. Codex: triển khai trong worktree cô lập -------------------------
console.log(`\n── [2/2] codex: triển khai ──`);
status.state = "implementing";

let workDir = process.cwd();
if (useWorktree) {
  git(["worktree", "prune"]); // dọn record chết từ lần crash trước
  const branch = `ai/codex-${taskId}`;
  const dir = path.resolve("..", `.ai-worktrees-${path.basename(process.cwd())}`, taskId);
  const add = git(["worktree", "add", "-B", branch, dir, "HEAD"]);
  if (add.code !== 0) await fail(`Không tạo được worktree: ${add.err}. (Dùng --in-place nếu muốn sửa thẳng.)`);
  workDir = dir;
  worktreeToClean = { dir, branch, baseSha: git(["-C", dir, "rev-parse", "HEAD"]).out };
  status.workspace.dir = dir;
  status.workspace.branch = branch;
  console.log(`  worktree: ${dir}  (branch ${branch})`);
}
await saveStatus();

const codexPrompt = `Triển khai task sau.

## Task
${task}

## Phản biện kiến trúc (tham khảo)
${reviewText}

## Yêu cầu
- Thay đổi nhỏ nhất mà vẫn maintainable, theo convention sẵn có.
- Viết/chạy test liên quan nếu có test runner.
- TUYỆT ĐỐI KHÔNG git push, KHÔNG merge, KHÔNG tạo PR.
- Kết thúc bằng tóm tắt: file đã đổi, quyết định chính, rủi ro còn lại, cách chạy test.`;

// `exec -` đọc prompt từ stdin. Network TẮT mặc định ở workspace-write (lá chắn chống exfil/auto-push).
const codexArgs = ["exec", "-", "-s", "workspace-write"];
if (process.env.CODEX_MODEL) codexArgs.push("-m", process.env.CODEX_MODEL);
if (!gitRoot) codexArgs.push("--skip-git-repo-check");
codexArgs.push("-o", path.join(taskDir, "codex-last-message.md"));

const c = await run("codex", codexArgs, {
  cwd: workDir,
  timeoutMs: CODEX_TIMEOUT_MS,
  logFile: path.join(taskDir, "codex.log"),
  input: codexPrompt,
});
await writeFile(path.join(taskDir, "codex-result.md"), c.stdout.trim() || c.stderr.trim());
status.completed.push("implementation");
if (!c.ok) {
  // nhận diện hết-limit/nghẽn để báo là "thử lại sau", không phải bug
  const rate = /rate.?limit|quota|usage limit|too many requests|429|insufficient.*credit|overloaded/i
    .test(c.stdout + c.stderr);
  status.error_kind = rate ? "rate_limit" : (c.code === 124 ? "timeout" : "error");
  await fail(rate
    ? `Codex hết limit/nghẽn (đã lưu việc dở). Chờ limit reset rồi chạy lại: node tools/ai-team.mjs --task-id ${taskId} --in-place "<task>". Log: ${path.join(taskDir, "codex.log")}`
    : `Codex thất bại (code ${c.code}). Xem ${path.join(taskDir, "codex.log")}`);
}

// --- báo cáo ------------------------------------------------------------
status.state = "done";
status.finishedAt = new Date().toISOString();
await saveStatus();

console.log(`\n✅ Xong: ${taskDir}`);
console.log(`   request.md · review.md · codex-result.md · status.json · *.log`);
if (status.workspace.branch) {
  const stat = git(["-C", status.workspace.dir, "--no-pager", "diff", "--stat", "HEAD"]).out;
  console.log(`\n   Branch cô lập: ${status.workspace.branch}`);
  if (stat) console.log("\n" + stat);
  console.log(`\n   Review rồi merge THỦ CÔNG (chưa merge tự động):`);
  console.log(`     git -C "${status.workspace.dir}" diff HEAD`);
  console.log(`     git merge ${status.workspace.branch}`);
  console.log(`     git worktree remove "${status.workspace.dir}"`);
} else {
  console.log(`\n   Đã sửa trực tiếp trong ${workDir} — review trước khi commit.`);
}
