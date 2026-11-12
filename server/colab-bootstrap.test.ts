import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_CANONICAL_BACKEND_SOURCE,
  BOOTSTRAP_WORKER_SOURCE,
  BOOTSTRAP_CANONICAL_INSTALL_SOURCE,
  BOOTSTRAP_CANONICAL_PREFLIGHT_SOURCE,
  buildBootstrapResetCode,
  buildBootstrapStartCode,
  buildBootstrapStatusCode,
} from "./colab-bootstrap";

const root = resolve(process.cwd());
const workerPath = resolve(root, "colab/api_bootstrap_worker.py");
const notebookPath = resolve(root, "colab/accentlab_seedvc_backend.ipynb");
const workerSource = readFileSync(workerPath, "utf8");

function compilePython(source: string, filename: string) {
  execFileSync(
    "python3",
    [
      "-c",
      "import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])",
      filename,
    ],
    { input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
}

function canonicalNotebookSources() {
  const extractor = String.raw`
import ast
import json
import sys
notebook = json.load(open(sys.argv[1], encoding="utf-8"))
cells = [cell for cell in notebook["cells"] if cell.get("cell_type") == "code"]
final_tree = ast.parse("".join(cells[2]["source"]))
assignment = next(
    node for node in final_tree.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "backend_source" for target in node.targets)
)
print(json.dumps([
    "".join(cells[0]["source"]),
    "".join(cells[1]["source"]),
    ast.literal_eval(assignment.value),
]))
`;
  return JSON.parse(
    execFileSync("python3", ["-c", extractor, notebookPath], {
      encoding: "utf8",
    })
  ) as [string, string, string];
}

describe("Colab bootstrap builders", () => {
  it("exports synchronous start and status execute_code payloads", () => {
    expect(buildBootstrapStartCode()).toEqual(expect.any(String));
    expect(buildBootstrapStatusCode()).toEqual(expect.any(String));
    expect(buildBootstrapResetCode("repair-click")).toContain(
      'REPAIR_ATTEMPT = "repair-click"'
    );
    expect(buildBootstrapStartCode).toHaveLength(0);
    expect(buildBootstrapStatusCode).toHaveLength(0);
  });

  it("embeds the exact canonical setup, preflight, and backend sources", () => {
    const [install, preflight, backend] = canonicalNotebookSources();
    expect(BOOTSTRAP_CANONICAL_INSTALL_SOURCE).toBe(install);
    expect(BOOTSTRAP_CANONICAL_PREFLIGHT_SOURCE).toBe(preflight);
    expect(BOOTSTRAP_CANONICAL_BACKEND_SOURCE).toBe(backend);

    const workerExtractor = String.raw`
import ast, json, sys
tree = ast.parse(sys.stdin.read())
assignment = next(
    node for node in tree.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "BACKEND_SOURCE" for target in node.targets)
)
print(json.dumps(ast.literal_eval(assignment.value)))
`;
    const embeddedBackend = JSON.parse(
      execFileSync("python3", ["-c", workerExtractor], {
        input: workerSource,
        encoding: "utf8",
      })
    ) as string;
    expect(BOOTSTRAP_WORKER_SOURCE).toBe(workerSource);
    expect(embeddedBackend).toBe(backend);

    const start = buildBootstrapStartCode();
    expect(start).toContain("apt-get");
    expect(start).toContain("51383efd921027683c89e5348211d93ff12ac2a8");
    expect(start).toContain("initialize_runtime()");
    expect(start).toContain("demo.launch");
  });

  it("uses one locked worker, strict private status writes, and stale-process recovery", () => {
    const start = buildBootstrapStartCode();
    const status = buildBootstrapStatusCode();
    expect(start).toContain("/content/accentlab-api");
    expect(start).toContain("fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)");
    expect(start).toContain("start_new_session=True");
    expect(start).toContain("stdout=subprocess.DEVNULL");
    expect(start).toContain("stderr=subprocess.DEVNULL");
    expect(start).toContain("os.fchmod(status_fd, 0o600)");
    expect(start).toContain("os.fchmod(directory_fd, 0o700)");
    expect(start).toContain('current.get("attempt") == BOOTSTRAP_ATTEMPT');
    expect(start).toContain("processStartTicks");
    expect(start).toContain("os.getpgid(pid) == pid");
    expect(buildBootstrapResetCode("repair-click")).toContain("SIGTERM");
    expect(status).toContain("The Colab backend worker stopped");
    expect(workerSource).toContain(
      "fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)"
    );
    expect(workerSource).toContain("threading.Event().wait()");
  });

  it("retries dead workers only on a new user launch and never replaces live workers", () => {
    const runner = String.raw`
import contextlib, io, json, os, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
code = sys.stdin.read()
cases = [
    ("prior_failure", {"stage": "error", "pid": None, "attempt": "old-click"}),
    ("same_attempt_failure", {"stage": "error", "pid": None, "attempt": "new-click"}),
    ("live_failure", {"stage": "error", "pid": os.getpid(), "attempt": "old-click"}),
    ("live_ready", {"stage": "ready", "pid": os.getpid(), "attempt": "old-click"}),
    ("dead_loading", {"stage": "loading", "pid": None, "attempt": "old-click"}),
    ("same_attempt_loading_dead", {"stage": "loading", "pid": None, "attempt": "new-click"}),
]
results = {}
for label, current in cases:
    with tempfile.TemporaryDirectory() as directory:
        source = code.replace('/content/accentlab-api', directory)
        path = pathlib.Path(directory) / "status.json"
        if label in ("live_failure", "live_ready"):
            current["processStartTicks"] = "12345"
        path.write_text(json.dumps(current))
        fake = type('Child', (), {'pid': os.getpid()})()
        with contextlib.ExitStack() as patches:
            if label in ("live_failure", "live_ready"):
                original_read_text = pathlib.Path.read_text
                original_read_bytes = pathlib.Path.read_bytes
                pid = os.getpid()
                worker_path = str(pathlib.Path(directory) / "api_bootstrap_worker.py")
                stat_fields = ["S", "1", str(pid), str(pid)] + ["0"] * 15 + ["12345"]
                def fake_read_text(item, *args, **kwargs):
                    if str(item) == f"/proc/{pid}/stat":
                        return f"{pid} (python) " + " ".join(stat_fields)
                    return original_read_text(item, *args, **kwargs)
                def fake_read_bytes(item):
                    if str(item) == f"/proc/{pid}/cmdline":
                        return b"/usr/bin/python" + bytes([0]) + worker_path.encode() + bytes([0])
                    return original_read_bytes(item)
                patches.enter_context(patch.object(pathlib.Path, "read_text", fake_read_text))
                patches.enter_context(patch.object(pathlib.Path, "read_bytes", fake_read_bytes))
                patches.enter_context(patch.object(os, "getpgid", lambda value: value))
            spawn_context = patches.enter_context(patch.object(subprocess, 'Popen', return_value=fake))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                exec(compile(source, '<offline-bootstrap>', 'exec'), {})
            spawn = spawn_context
            result = json.loads(output.getvalue())
            results[label] = {"spawned": spawn.call_count, "stage": result["stage"], "attempt": result["attempt"]}
            if spawn.call_count:
                assert spawn.call_args.kwargs['env']['ACCENTLAB_BOOTSTRAP_ATTEMPT'] == 'new-click'
                assert spawn.call_args.kwargs['stdout'] == subprocess.DEVNULL
                assert path.stat().st_mode & 0o777 == 0o600
print(json.dumps(results))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapStartCode("new-click"),
        encoding: "utf8",
      })
    );
    expect(result.prior_failure).toEqual({
      spawned: 1,
      stage: "installing",
      attempt: "new-click",
    });
    expect(result.same_attempt_failure).toEqual({
      spawned: 0,
      stage: "error",
      attempt: "new-click",
    });
    expect(result.live_failure).toEqual({
      spawned: 0,
      stage: "error",
      attempt: "old-click",
    });
    expect(result.live_ready).toEqual({
      spawned: 0,
      stage: "ready",
      attempt: "old-click",
    });
    expect(result.dead_loading).toEqual({
      spawned: 1,
      stage: "installing",
      attempt: "new-click",
    });
    expect(result.same_attempt_loading_dead).toEqual({
      spawned: 0,
      stage: "error",
      attempt: "new-click",
    });
  });

  it("keeps the startup lock free during installation and the long-lived server wait", () => {
    const runner = String.raw`
import fcntl, json, os, pathlib, sys, tempfile
os.environ['ACCENTLAB_BOOTSTRAP_ATTEMPT'] = 'offline-attempt'
with tempfile.TemporaryDirectory() as directory:
    source = sys.stdin.read().replace('/content/accentlab-api', directory)
    namespace = {'__name__': 'offline_worker'}
    exec(compile(source, '<offline-worker>', 'exec'), namespace)
    path = pathlib.Path(directory) / 'status.json'
    path.write_text(json.dumps({'stage': 'installing', 'pid': os.getpid(), 'attempt': 'offline-attempt'}))
    observed = []
    def lock_is_free(*args, **kwargs):
        with (pathlib.Path(directory) / 'bootstrap.lock').open('a+') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        observed.append(True)
    namespace['_run_child'] = lock_is_free
    namespace['_require_tesla_t4'] = lock_is_free
    namespace['_load_and_launch'] = lambda: ('https://offline-placeholder.gradio.live', 'offline-placeholder-access-code')
    namespace['threading'].Event = lambda: type('Wait', (), {'wait': staticmethod(lock_is_free)})()
    namespace['_run']()
    result = json.loads(path.read_text())
    print(json.dumps({'lockChecks': len(observed), 'stage': result['stage'], 'attempt': result['attempt']}))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: workerSource,
        encoding: "utf8",
      })
    );
    expect(result).toEqual({
      lockChecks: 4,
      stage: "ready",
      attempt: "offline-attempt",
    });
    expect(workerSource).toContain("os.chdir(managed_seed_vc_root)");
    expect(workerSource).toContain('SEED_VC_ROOT"] = managed_seed_vc_root');
    expect(workerSource).toContain("/content/accentlab-runtime/seed-vc");
  });

  it("uses the exact same managed-ownership marker as the canonical installer", () => {
    const runner = String.raw`
import ast, json, sys
payload = json.load(sys.stdin)
reset_tree = ast.parse(payload["reset"])
expected = ast.literal_eval(next(node.value for node in reset_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "EXPECTED_MARKER" for target in node.targets)))
worker_tree = ast.parse(payload["worker"])
install_source = ast.literal_eval(next(node.value for node in worker_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "INSTALL_SOURCE" for target in node.targets)))
install_tree = ast.parse(install_source)
installed = ast.literal_eval(next(node.value for node in install_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "marker_text" for target in node.targets)))
print(json.dumps({"matches": expected == installed}))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: JSON.stringify({
          reset: buildBootstrapResetCode("repair-click"),
          worker: workerSource,
        }),
        encoding: "utf8",
      })
    );
    expect(result.matches).toBe(true);
  });

  it("clears only the marked AccentLab checkout and exact worker files", () => {
    const runner = String.raw`
import ast, contextlib, io, json, pathlib, sys, tempfile
code = sys.stdin.read()
tree = ast.parse(code)
marker = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "EXPECTED_MARKER" for target in node.targets)))
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    content.mkdir()
    managed = content / "accentlab-runtime"
    seed = managed / "seed-vc"
    seed.mkdir(parents=True)
    (seed / "model.py").write_text("managed code")
    (managed / ".accentlab-managed").write_text(marker)
    (managed / "accentlab-requirements.txt").write_text("pinned requirements")
    legacy = content / "seed-vc"
    legacy.mkdir()
    (legacy / "user-change.py").write_text("preserve legacy checkout")
    api = content / "accentlab-api"
    api.mkdir()
    (api / "status.json").write_text(json.dumps({"stage": "error", "pid": None, "attempt": "old-click"}))
    (api / "api_bootstrap_worker.py").write_text("worker source")
    (api / "accentlab_seedvc_backend.py").write_text("backend source")
    audio = content / "tmp" / "accentlab_outputs" / "previous.wav"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"preserve")
    model_cache = content / ".cache" / "huggingface" / "models"
    model_cache.mkdir(parents=True)
    (model_cache / "weights.bin").write_bytes(b"preserve cache")
    notebook = content / "user-notebook.ipynb"
    notebook.write_text("preserve")
    source = code.replace("/content", str(content))
    try:
        with contextlib.redirect_stdout(io.StringIO()) as output:
            exec(compile(source, "<offline-repair>", "exec"), {})
    except SystemExit:
        pass
    status = json.loads((api / "status.json").read_text())
    print(json.dumps({
        "stage": status.get("stage"),
        "attempt": status.get("attempt"),
        "seed_removed": not seed.exists(),
        "marker_removed": not (managed / ".accentlab-managed").exists(),
        "requirements_removed": not (managed / "accentlab-requirements.txt").exists(),
        "worker_files_removed": not (api / "api_bootstrap_worker.py").exists() and not (api / "accentlab_seedvc_backend.py").exists(),
        "lock_preserved": (api / "bootstrap.lock").exists(),
        "audio_preserved": audio.read_bytes() == b"preserve",
        "legacy_preserved": (legacy / "user-change.py").read_text() == "preserve legacy checkout",
        "cache_preserved": (model_cache / "weights.bin").read_bytes() == b"preserve cache",
        "notebook_preserved": notebook.read_text() == "preserve",
    }))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapResetCode("repair-click"),
        encoding: "utf8",
      })
    );
    expect(result).toEqual({
      stage: "repairing",
      attempt: "repair-click",
      seed_removed: true,
      marker_removed: true,
      requirements_removed: true,
      worker_files_removed: true,
      lock_preserved: true,
      audio_preserved: true,
      legacy_preserved: true,
      cache_preserved: true,
      notebook_preserved: true,
    });
  });

  it("aborts repair without deletion when the worker PID identity does not match", () => {
    const runner = String.raw`
import ast, contextlib, io, json, os, pathlib, sys, tempfile
code = sys.stdin.read()
tree = ast.parse(code)
marker = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "EXPECTED_MARKER" for target in node.targets)))
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    managed = content / "accentlab-runtime"
    seed = managed / "seed-vc"
    seed.mkdir(parents=True)
    (seed / "model.py").write_text("must remain")
    (managed / ".accentlab-managed").write_text(marker)
    api = content / "accentlab-api"
    api.mkdir()
    (api / "status.json").write_text(json.dumps({"stage": "ready", "pid": os.getpid(), "processStartTicks": "not-the-current-process", "attempt": "old-click"}))
    source = code.replace("/content", str(content))
    try:
        with contextlib.redirect_stdout(io.StringIO()) as output:
            exec(compile(source, "<offline-repair-identity>", "exec"), {})
    except SystemExit:
        pass
    print(json.dumps({"stage": json.loads(output.getvalue()).get("stage"), "seed_preserved": (seed / "model.py").read_text() == "must remain", "status_preserved": (api / "status.json").exists()}))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapResetCode("repair-click"),
        encoding: "utf8",
      })
    );
    expect(result).toEqual({
      stage: "error",
      seed_preserved: true,
      status_preserved: true,
    });
  });

  it("stops only a fully verified worker process group before repairing", () => {
    const runner = String.raw`
import ast, contextlib, io, json, os, pathlib, signal, sys, tempfile
from unittest.mock import patch
code = sys.stdin.read()
tree = ast.parse(code)
marker = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "EXPECTED_MARKER" for target in node.targets)))
pid = 424242
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    managed = content / "accentlab-runtime"
    seed = managed / "seed-vc"
    seed.mkdir(parents=True)
    (seed / "model.py").write_text("managed code")
    (managed / ".accentlab-managed").write_text(marker)
    api = content / "accentlab-api"
    api.mkdir()
    (api / "status.json").write_text(json.dumps({"stage": "ready", "pid": pid, "processStartTicks": "777", "attempt": "old-click"}))
    worker = api / "api_bootstrap_worker.py"
    worker.write_text("worker")
    audio = content / "tmp" / "accentlab_outputs" / "preserve.wav"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"keep")
    original_read_text = pathlib.Path.read_text
    original_read_bytes = pathlib.Path.read_bytes
    original_kill = os.kill
    signals = []
    terminated = [False]
    worker_cmdline = f"/usr/bin/python{chr(0)}{worker}{chr(0)}".encode()
    stat_fields = ["S", "1", str(pid), str(pid)] + ["0"] * 15 + ["777"]
    def fake_read_text(item, *args, **kwargs):
        if str(item) == f"/proc/{pid}/stat":
            return f"{pid} (python) " + " ".join(stat_fields)
        return original_read_text(item, *args, **kwargs)
    def fake_read_bytes(item):
        if str(item) == f"/proc/{pid}/cmdline":
            return worker_cmdline
        return original_read_bytes(item)
    def fake_kill(process_id, sig):
        if process_id == pid and sig == 0:
            return None
        return original_kill(process_id, sig)
    def fake_killpg(process_group, sig):
        signals.append([process_group, int(sig)])
        if process_group != pid:
            raise AssertionError("repair targeted an unrelated process group")
        if sig == signal.SIGTERM:
            terminated[0] = True
            return None
        if sig == 0 and terminated[0]:
            raise ProcessLookupError
        raise AssertionError("repair sent an unexpected signal")
    patches = [
        patch.object(pathlib.Path, "read_text", fake_read_text),
        patch.object(pathlib.Path, "read_bytes", fake_read_bytes),
        patch.object(os, "kill", fake_kill),
        patch.object(os, "getpgid", lambda process_id: process_id),
        patch.object(os, "killpg", fake_killpg),
    ]
    source = code.replace("/content", str(content))
    try:
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            with contextlib.redirect_stdout(io.StringIO()):
                try:
                    exec(compile(source, "<offline-repair-verified-worker>", "exec"), {})
                except SystemExit:
                    pass
    except SystemExit:
        pass
    status = json.loads((api / "status.json").read_text())
    print(json.dumps({"stage": status.get("stage"), "attempt": status.get("attempt"), "signals": signals, "seed_removed": not seed.exists(), "audio_preserved": audio.read_bytes() == b"keep"}))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapResetCode("repair-click"),
        encoding: "utf8",
      })
    );
    expect(result.stage).toBe("repairing");
    expect(result.attempt).toBe("repair-click");
    expect(result.signals).toContainEqual([424242, 15]); // SIGTERM only
    expect(result.signals).not.toContainEqual([424242, 9]); // never SIGKILL
    expect(result.seed_removed).toBe(true);
    expect(result.audio_preserved).toBe(true);
  });

  it("does not signal a worker when its start identity cannot be verified", () => {
    const runner = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
code = sys.stdin.read()
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    api = content / "accentlab-api"
    api.mkdir(parents=True)
    (api / "status.json").write_text(json.dumps({"stage": "error", "pid": None, "attempt": "old-click"}))
    signals = []
    class Child:
        pid = 424242
        def terminate(self):
            signals.append("terminate")
        def wait(self, *args, **kwargs):
            signals.append("wait")
    original_read_text = pathlib.Path.read_text
    def fake_read_text(item, *args, **kwargs):
        if str(item) == "/proc/424242/stat":
            raise FileNotFoundError
        return original_read_text(item, *args, **kwargs)
    source = code.replace("/content", str(content))
    with patch.object(pathlib.Path, "read_text", fake_read_text), patch.object(subprocess, "Popen", return_value=Child()):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            exec(compile(source, "<offline-start-no-identity>", "exec"), {})
    status = json.loads((api / "status.json").read_text())
    print(json.dumps({"stage": status.get("stage"), "message": status.get("message"), "signals": signals}))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapStartCode("new-click"),
        encoding: "utf8",
      })
    );
    expect(result.stage).toBe("error");
    expect(result.message).toContain("not signaled");
    expect(result.signals).toEqual([]);
  });

  it("preserves targets when worker or backend paths are pre-existing symlinks", () => {
    const runner = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
payload = json.loads(sys.stdin.read())
start_code = payload["start"]
worker_code = payload["worker"]
results = {}
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    api = content / "accentlab-api"
    api.mkdir(parents=True)
    target = pathlib.Path(directory) / "worker-target.py"
    target.write_text("keep worker target")
    worker_link = api / "api_bootstrap_worker.py"
    worker_link.symlink_to(target)
    (api / "status.json").write_text(json.dumps({"stage": "error", "pid": None, "attempt": "old-click"}))
    source = start_code.replace("/content", str(content))
    with patch.object(subprocess, "Popen") as spawn:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(source, "<offline-worker-symlink>", "exec"), {})
    results["worker"] = {"target": target.read_text(), "is_symlink": worker_link.is_symlink(), "spawned": spawn.call_count}
    managed = content / "accentlab-runtime" / "seed-vc"
    managed.mkdir(parents=True)
    backend_target = pathlib.Path(directory) / "backend-target.py"
    backend_target.write_text("keep backend target")
    backend_link = api / "accentlab_seedvc_backend.py"
    backend_link.symlink_to(backend_target)
    namespace = {"__name__": "offline-worker"}
    worker_source = worker_code.replace("/content", str(content))
    exec(compile(worker_source, "<offline-worker>", "exec"), namespace)
    try:
        namespace["_load_and_launch"]()
    except Exception:
        pass
    results["backend"] = {"target": backend_target.read_text(), "is_symlink": backend_link.is_symlink()}
print(json.dumps(results))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: JSON.stringify({
          start: buildBootstrapStartCode("new-click"),
          worker: workerSource,
        }),
        encoding: "utf8",
      })
    );
    expect(result).toEqual({
      worker: { target: "keep worker target", is_symlink: true, spawned: 0 },
      backend: { target: "keep backend target", is_symlink: true },
    });
  });

  it("performs zero cleanup when a marker changes after SIGTERM", () => {
    const runner = String.raw`
import contextlib, io, json, os, pathlib, signal, sys, tempfile
from unittest.mock import patch
code = sys.stdin.read()
tree = __import__("ast").parse(code)
marker = __import__("ast").literal_eval(next(node.value for node in tree.body if isinstance(node, __import__("ast").Assign) and any(isinstance(target, __import__("ast").Name) and target.id == "EXPECTED_MARKER" for target in node.targets)))
pid = 424242
with tempfile.TemporaryDirectory() as directory:
    content = pathlib.Path(directory) / "content"
    managed = content / "accentlab-runtime"
    seed = managed / "seed-vc"
    seed.mkdir(parents=True)
    (seed / "model.py").write_text("keep seed")
    marker_path = managed / ".accentlab-managed"
    marker_path.write_text(marker)
    (managed / "accentlab-requirements.txt").write_text("keep requirements")
    api = content / "accentlab-api"
    api.mkdir()
    (api / "status.json").write_text(json.dumps({"stage": "ready", "pid": pid, "processStartTicks": "777", "attempt": "old-click"}))
    worker = api / "api_bootstrap_worker.py"
    backend = api / "accentlab_seedvc_backend.py"
    worker.write_text("keep worker")
    backend.write_text("keep backend")
    original_read_text = pathlib.Path.read_text
    original_read_bytes = pathlib.Path.read_bytes
    signals = []
    terminated = [False]
    worker_cmdline = f"/usr/bin/python{chr(0)}{worker}{chr(0)}".encode()
    stat_fields = ["S", "1", str(pid), str(pid)] + ["0"] * 15 + ["777"]
    def fake_read_text(item, *args, **kwargs):
        if str(item) == f"/proc/{pid}/stat":
            return f"{pid} (python) " + " ".join(stat_fields)
        return original_read_text(item, *args, **kwargs)
    def fake_read_bytes(item):
        if str(item) == f"/proc/{pid}/cmdline":
            return worker_cmdline
        return original_read_bytes(item)
    def fake_kill(process_id, sig):
        if process_id == pid and sig == 0:
            return None
        return None
    def fake_killpg(process_group, sig):
        if sig == signal.SIGTERM:
            signals.append([process_group, int(sig)])
            terminated[0] = True
            marker_path.write_text("changed marker")
            return None
        if sig == 0 and terminated[0]:
            raise ProcessLookupError
        raise AssertionError("unexpected signal")
    source = code.replace("/content", str(content))
    patches = [
        patch.object(pathlib.Path, "read_text", fake_read_text),
        patch.object(pathlib.Path, "read_bytes", fake_read_bytes),
        patch.object(os, "kill", fake_kill),
        patch.object(os, "getpgid", lambda process_id: process_id),
        patch.object(os, "killpg", fake_killpg),
    ]
    with contextlib.ExitStack() as stack:
        for item in patches:
            stack.enter_context(item)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                exec(compile(source, "<offline-marker-mismatch>", "exec"), {})
            except SystemExit:
                pass
    print(json.dumps({
        "signals": signals,
        "seed": (seed / "model.py").read_text() == "keep seed",
        "marker": marker_path.read_text() == "changed marker",
        "requirements": (managed / "accentlab-requirements.txt").read_text() == "keep requirements",
        "status": (api / "status.json").exists(),
        "worker": worker.read_text() == "keep worker",
        "backend": backend.read_text() == "keep backend",
    }))
`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", runner], {
        input: buildBootstrapResetCode("repair-click"),
        encoding: "utf8",
      })
    );
    expect(result).toEqual({
      signals: [[424242, 15]],
      seed: true,
      marker: true,
      requirements: true,
      status: true,
      worker: true,
      backend: true,
    });
  });

  it("enforces T4-only readiness and the approved quiet Gradio launch contract", () => {
    const start = buildBootstrapStartCode();
    expect(workerSource).toContain('name != "Tesla T4"');
    expect(workerSource).toContain("torch.cuda.is_available()");
    expect(workerSource).toContain(
      "gpu_available is not True or model is None"
    );
    expect(workerSource).toContain("share=True");
    expect(workerSource).toContain("debug=False");
    expect(workerSource).toContain("prevent_thread_lock=True");
    expect(workerSource).toContain('max_file_size="20mb"');
    expect(workerSource).toContain('"Colab backend is ready."');
    expect(workerSource).toContain("accessKey=access_key");
    expect(workerSource).toContain("gradio.live");
    expect(workerSource).toContain("redirect_stdout");
    expect(workerSource).toContain("redirect_stderr");
    expect(workerSource).toContain("quiet_stdout");
    expect(start).toContain("WORKER_SOURCE = ");
  });

  it("passes offline Python AST validation without importing model dependencies", () => {
    compilePython(workerSource, workerPath);
    compilePython(buildBootstrapStartCode(), "colab-bootstrap-start.py");
    compilePython(buildBootstrapStatusCode(), "colab-bootstrap-status.py");
  });
});
