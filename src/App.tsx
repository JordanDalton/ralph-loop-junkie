import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CommandPalette } from "@cloudflare/kumo";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import CodeMirror from "@uiw/react-codemirror";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { tags } from "@lezer/highlight";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

type CommandItem = {
  id: string;
  title: string;
  description: string;
};

type Page = "home" | "create-loop" | "workspace";
type FileKind = "md" | "json" | "bash" | "text" | "image";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
type LoopStatus = "idle" | "running" | "needs-review";

type LoopFile = {
  id: string; // stable, unique within a loop (e.g. "plans/PRD.md")
  name: string; // filename incl. extension
  dir: string; // "plans" | "scripts/ralph"
  kind: FileKind;
  content: string;
};

type LoopWorkspace = {
  id: string;
  name: string;
  status: LoopStatus;
  iteration: number;
  lastRun?: number; // epoch ms of the last run start/end
  files: LoopFile[];
};

// Compact relative-time label, e.g. "4s", "2m", "1h", "3d".
function formatRelative(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// Read the current iteration count out of a loop's ralph-state.md.
function iterationFromFiles(files: LoopFile[]): number | null {
  const state = files.find((f) => f.name === "ralph-state.md");
  if (!state) return null;
  const m = state.content.match(/iteration:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Folders a user can add files into (also defines the file-browser sections).
const FOLDERS: { dir: string; label: string }[] = [
  { dir: "plans", label: "plans" },
  { dir: "scripts/ralph", label: "scripts / ralph" },
];

function kindFromName(name: string): FileKind {
  const n = name.toLowerCase();
  const ext = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".sh") || n.endsWith(".bash") || n.endsWith(".zsh")) return "bash";
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "md";
  return "text";
}

function makeFile(dir: string, name: string, content: string): LoopFile {
  return { id: `${dir}/${name}`, name, dir, kind: kindFromName(name), content };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

type DiskFile = { dir: string; name: string; content: string };

// Reconcile the in-app file list with what's actually on disk:
//  - update content of files that exist in both (preserving list order),
//  - append files the loop created on disk that we don't track yet,
//  - keep files that exist only in app state (added but not yet written).
function mergeDiskFiles(stateFiles: LoopFile[], disk: DiskFile[]): LoopFile[] {
  const diskContent = new Map(disk.map((f) => [`${f.dir}/${f.name}`, f.content]));
  const stateIds = new Set(stateFiles.map((f) => f.id));
  const updated = stateFiles.map((f) =>
    diskContent.has(f.id)
      ? { ...f, content: diskContent.get(f.id)!, kind: kindFromName(f.name) }
      : f
  );
  const created = disk
    .filter((f) => !stateIds.has(`${f.dir}/${f.name}`))
    .map((f) => makeFile(f.dir, f.name, f.content));
  return [...updated, ...created];
}

function defaultFiles(
  overrides?: Partial<Record<"prd" | "prompt" | "tasks" | "state" | "script", string>>
): LoopFile[] {
  return [
    makeFile("plans", "PRD.md", overrides?.prd ?? defaultPrd),
    makeFile("plans", "PROMPT.md", overrides?.prompt ?? defaultPrompt),
    makeFile("plans", "tasks.json", overrides?.tasks ?? defaultTasks),
    makeFile("plans", "ralph-state.md", overrides?.state ?? defaultState),
    makeFile("scripts/ralph", "ralph.sh", overrides?.script ?? defaultScript),
  ];
}

// Migrate a persisted loop from the old fixed-object file shape to the new list.
function normalizeLoopFiles(files: unknown): LoopFile[] {
  if (Array.isArray(files)) {
    return files
      .filter((f): f is LoopFile => !!f && typeof f.name === "string" && typeof f.dir === "string")
      // Always derive kind from the name so e.g. a .png saved as "text" before
      // image support is correctly reclassified as an image.
      .map((f) => ({ ...f, id: `${f.dir}/${f.name}`, kind: kindFromName(f.name) }));
  }
  if (files && typeof files === "object") {
    const o = files as Record<string, string>;
    return defaultFiles({
      prd: o.prd,
      prompt: o.prompt,
      tasks: o.tasks,
      state: o.state,
      script: o.script,
    });
  }
  return defaultFiles();
}

const commands: CommandItem[] = [
  {
    id: "open-loops",
    title: "Open loops",
    description: "Show all loop workspaces."
  },
  {
    id: "new-loop",
    title: "Create loop",
    description: "Start a new Ralph loop."
  },
  {
    id: "open-queue",
    title: "Open queue",
    description: "Review loops waiting to run."
  },
  {
    id: "open-settings",
    title: "Open settings",
    description: "Adjust app configuration."
  }
];

const defaultScript = `#!/bin/bash
# scripts/ralph/ralph.sh

set -euo pipefail

MAX_ITERATIONS=\${1:-50}
ITERATION=0

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
# ralph.sh lives at <loop>/scripts/ralph/ralph.sh, so the loop root is two
# levels up (../.. ), and plans/ sits directly under it.
LOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLANS_DIR="$LOOP_ROOT/plans"

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
  ITERATION=$((ITERATION + 1))
  echo "=== Ralph Loop: Iteration $ITERATION of $MAX_ITERATIONS ==="

  # Spawn a fresh Claude session each iteration.
  # --dangerously-skip-permissions is required for non-interactive mode.
  OUTPUT=$(claude --print --output-format text --dangerously-skip-permissions \\
    "Read $PLANS_DIR/PRD.md, $PLANS_DIR/PROMPT.md, $PLANS_DIR/tasks.json, and $PLANS_DIR/ralph-state.md. \\
     Pick the next task whose status is not 'done' and actually complete the work it describes. \\
     When (and only when) a task is genuinely finished, set its \\"status\\" to \\"done\\" in tasks.json. \\
     Do not mark a task done unless its work is actually complete. \\
     Update ralph-state.md with what changed, any blockers, and the next planned action.")

  # Show what Claude did this iteration.
  echo "$OUTPUT"

  # ── Verification step ────────────────────────────────────────────────────
  # Replace the line below with the command that verifies your project's
  # output (e.g. "npm test", "pytest", "cargo test", "make check").
  # Leave it as "true" to skip verification and rely on tasks.json status.
  VERIFY_CMD="true"
  set +e
  $VERIFY_CMD
  VERIFY_EXIT=$?
  set -e
  # ─────────────────────────────────────────────────────────────────────────

  echo "Verify exit: $VERIFY_EXIT"

  # ── Completion check ─────────────────────────────────────────────────────
  # The loop is done only when EVERY task in tasks.json is marked done AND
  # verification passes. We do not trust a self-reported promise — we read
  # the actual task statuses so the loop can't exit with work still pending.
  REMAINING=$(python3 - "$PLANS_DIR/tasks.json" <<'PY'
import json, sys, time
# Retry briefly: Claude's edits aren't atomic, so the file can be
# momentarily empty/half-written right after the iteration.
data = None
for _ in range(5):
    try:
        with open(sys.argv[1]) as f:
            data = json.load(f)
        break
    except Exception:
        time.sleep(0.2)
if data is None:
    print(-1); sys.exit()
done = {"done", "complete", "completed", "passed"}
tasks = data.get("tasks", []) if isinstance(data, dict) else []
print(sum(1 for t in tasks if str(t.get("status", "")).lower() not in done))
PY
)
  echo "Remaining tasks: $REMAINING"

  if [ "$REMAINING" = "0" ] && [ "$VERIFY_EXIT" -eq 0 ]; then
    echo "All tasks complete!"
    exit 0
  fi
  # ─────────────────────────────────────────────────────────────────────────

done

echo "Max iterations reached"
`;

const defaultPrd = `# Ralph Loop PRD

## Goal

Say \`Hi, I'm a loop\`.

## Output

The greeting "Hi, I'm a loop" appears in the loop log.

## Notes

This is a minimal working example. Edit the goal, prompt, and tasks.json to
make this loop do something real.
`;

const defaultPrompt = `# Ralph Loop Prompt

You are working inside the Ralph loop workflow.

## Objective

Complete the single starter task: greet the world with "Hi, I'm a loop".

## Instructions

- Read the current PRD, prompt, tasks, and loop state.
- Pick the next task whose status is not "done".
- Do the work it describes (for the starter task, simply output: Hi, I'm a loop).
- Set that task's "status" to "done" in tasks.json once it's complete.
- Update \`ralph-state.md\` with what changed and the next intended action.

## Completion

The loop is done when every task in tasks.json has status "done".
`;

const defaultTasks = `{
  "tasks": [
    {
      "id": "task-1",
      "title": "Say \`Hi, I'm a loop\`",
      "status": "pending"
    }
  ]
}
`;

const defaultState = `# Ralph State

## Loop Status
- iteration: 0
- current_task_id: none
- last_verify_exit: n/a
- overall_status: active

## What Changed Last Iteration
- Initial loop state created

## Current Problem
- None

## Failed Attempts
- None

## Next Action
- Review PRD, PROMPT, and tasks.json and begin the first task

## Blockers
- None
`;

function HeartbeatBars({ active }: { active: boolean }) {
  const heights = active ? [5, 9, 6, 11, 7] : [3, 3, 4, 3, 3];
  const delays = ["0s", "0.2s", "0s", "0.35s", "0.15s"];
  return (
    <span className={`heartbeat ${active ? "run" : "dim"}`}>
      {heights.map((h, i) => (
        <i key={i} style={{ height: `${h}px`, ...(active ? { animationDelay: delays[i] } : {}) }} />
      ))}
    </span>
  );
}

function FileIcon({ kind, active }: { kind: string; active: boolean }) {
  const stroke = active ? "var(--acc-bright)" : "#6b7688";
  if (kind === "bash") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M5 5h14v14H5z" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 10l2.5 2L8 14M13 14h3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M6 3h8l4 4v14H6z" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M14 3v4h4" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function statusBadgeClass(s: LoopStatus) {
  return s === "running" ? "run" : s === "needs-review" ? "review" : "idle";
}

function statusLabel(s: LoopStatus) {
  return s === "needs-review" ? "needs-review" : s;
}

const SEED_NOW = Date.now();

const initialLoops: LoopWorkspace[] = [
  {
    id: "alpha",
    name: "Alpha Loop",
    status: "idle",
    iteration: 0,
    files: defaultFiles()
  },
  {
    id: "beta",
    name: "Beta Loop",
    status: "running",
    iteration: 12,
    lastRun: SEED_NOW - 4000,
    files: defaultFiles({
      prd: defaultPrd.replace("Describe what this loop should accomplish.", "Stabilize the beta orchestration path."),
      prompt: defaultPrompt.replace("State the immediate objective for the loop.", "Reduce open failures and keep the run moving."),
      tasks: `{
  "tasks": [
    {
      "id": "task-1",
      "title": "Verify beta verification step",
      "status": "in_progress"
    }
  ]
}
`,
      state: defaultState.replace("iteration: 0", "iteration: 5").replace("current_task_id: none", "current_task_id: task-1"),
      script: defaultScript.replace("50", "75")
    })
  },
  {
    id: "gamma",
    name: "Gamma Loop",
    status: "needs-review",
    iteration: 3,
    lastRun: SEED_NOW - 120000,
    files: defaultFiles({
      prd: defaultPrd.replace("Describe the expected result of a successful run.", "Document the expected review-ready result."),
      prompt: defaultPrompt.replace("Make concrete progress.", "Prepare a reviewable change set."),
      tasks: `{
  "tasks": [
    {
      "id": "task-1",
      "title": "Resolve review comments",
      "status": "pending"
    }
  ]
}
`,
      state: defaultState.replace("iteration: 0", "iteration: 3").replace("Current Problem\n- None", "Current Problem\n- Verify still failing in review step")
    })
  }
];

const isMac = navigator.platform.toLowerCase().includes("mac");
const isTauri = () => "__TAURI_INTERNALS__" in window;

/** The signature Ralph loop icon: orbital rings + glowing core + heartbeat.
 *  Scales to any size via `size` (px). Set `animated={false}` to freeze it. */
function LoopMark({ size = 132, animated = true }: { size?: number; animated?: boolean }) {
  return (
    <span
      className={`loopmark ${animated ? "" : "static"}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="loopmark-inner" style={{ transform: `scale(${size / 132})` }}>
        <div className="splash-ring spin">
          <svg viewBox="0 0 132 132">
            <circle className="splash-track" cx="66" cy="66" r="62" />
            <circle className="splash-arc" cx="66" cy="66" r="62" strokeDasharray="270 390" />
          </svg>
        </div>
        <div className="splash-ring spin-rev">
          <svg viewBox="0 0 132 132">
            <circle className="splash-arc-2" cx="66" cy="66" r="53" strokeDasharray="60 333" />
            <circle className="splash-arc-2" cx="66" cy="66" r="53" strokeDasharray="60 333" strokeDashoffset="-196" />
          </svg>
        </div>
        <div className="splash-core">
          <div className="splash-beat"><i /><i /><i /><i /><i /></div>
        </div>
      </span>
    </span>
  );
}

function SplashScreen({
  loops,
  onEnter,
  onPalette,
}: {
  loops: LoopWorkspace[];
  onEnter: () => void;
  onPalette: () => void;
}) {
  const [visible, setVisible] = useState(0);
  const [pct, setPct] = useState(0);
  const [fill, setFill] = useState(0);
  const [status, setStatus] = useState("booting engine…");
  const [ready, setReady] = useState(false);

  const names = loops
    .map((l) => l.name.replace(/\s*loop$/i, "").trim().toLowerCase())
    .filter(Boolean);
  const attach = loops.find((l) => l.status === "running") ?? loops[0];

  const bootLines: { cls: string; mk: string; body: ReactNode }[] = [
    { cls: "ok", mk: "✓", body: <span>workspace <b>mounted</b></span> },
    {
      cls: "ok",
      mk: "✓",
      body: loops.length ? (
        <span>
          <b>{loops.length}</b> loops discovered{" "}
          <span className="dim">· {names.slice(0, 3).join(", ")}</span>
        </span>
      ) : (
        <span>
          no loops yet <span className="dim">· create one to begin</span>
        </span>
      ),
    },
    {
      cls: "wk",
      mk: "⟳",
      body: attach ? (
        <span>
          attaching to <b>loops/{attach.id}</b>{" "}
          <span className="dim">· iter {attach.iteration}</span>
        </span>
      ) : (
        <span>
          engine idle <span className="dim">· awaiting loops</span>
        </span>
      ),
    },
    { cls: "ok", mk: "✓", body: <span>ralph engine <b>online</b></span> },
  ];

  // Drives the looping boot animation (mirrors the original splash script).
  useEffect(() => {
    const lineDelays = [250, 850, 1500, 2300];
    const stages = [
      { at: 18, label: "mounting workspace…" },
      { at: 46, label: "discovering loops…" },
      { at: 74, label: "attaching worker…" },
      { at: 100, label: "ready" },
    ];
    const dur = 350 + (stages.length - 1) * 720 + 400;
    const timers: number[] = [];
    let raf = 0;

    const run = () => {
      setVisible(0);
      setPct(0);
      setFill(0);
      setStatus("booting engine…");
      setReady(false);

      lineDelays.forEach((d, i) => {
        timers.push(window.setTimeout(() => setVisible((v) => Math.max(v, i + 1)), d));
      });

      stages.forEach((s, i) => {
        timers.push(
          window.setTimeout(() => {
            setFill(s.at);
            setStatus(s.label);
            if (i === stages.length - 1) setReady(true);
          }, 350 + i * 720)
        );
      });

      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        setPct(t < 1 ? Math.round(t * 100) : 100);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      timers.push(window.setTimeout(() => { raf = requestAnimationFrame(tick); }, 350));

      timers.push(window.setTimeout(run, 5200));
    };
    run();

    return () => {
      timers.forEach((t) => clearTimeout(t));
      cancelAnimationFrame(raf);
    };
  }, [loops.length]);

  return (
    <div
      className="splash-shell"
      data-mode="dark"
      onClick={onEnter}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEnter();
        }
      }}
    >
      <div className="splash-stage" onClick={onEnter}>
        <div className="splash-mark">
          <LoopMark size={132} />
        </div>

        <div className="splash-overline">Autonomous Loop Runner</div>
        <h1 className="splash-wordmark">
          Ralph <span className="lp">Loop</span> Junkie
        </h1>
        <p className="splash-tagline">
          Just one more iteration<span className="cur">_</span>
        </p>

        <div className="splash-console">
          {bootLines.map((line, i) => (
            <div key={i} className={`splash-bootline ${i < visible ? "show" : ""}`}>
              <span className={`mk ${line.cls}`}>{line.mk}</span>
              {line.body}
            </div>
          ))}
        </div>

        <div className="splash-progress">
          <div className="splash-bar">
            <div className="splash-barfill" style={{ width: `${fill}%` }} />
          </div>
          <div className="splash-meta">
            <span className={ready ? "ready" : undefined}>{status}</span>
            <span className="pct"><b>{pct}</b>%</span>
          </div>
        </div>

        <div className="splash-cta">
          <button
            className="splash-btn primary"
            onClick={(e) => { e.stopPropagation(); onEnter(); }}
          >
            Enter workspace →
          </button>
          <button
            className="splash-btn ghost"
            onClick={(e) => { e.stopPropagation(); onPalette(); }}
          >
            {isMac ? "⌘K" : "Ctrl+K"} commands
          </button>
        </div>
      </div>

      <div className="splash-footer">
        <b>Ralph</b><span>v0.4</span>
        <span className="sep" />
        <span>{loops.length} loop{loops.length === 1 ? "" : "s"} linked</span>
      </div>
    </div>
  );
}

type LogLine = { loopId: string; line: string; stream: "stdout" | "stderr" };

// Descriptions for the well-known core files, keyed by "dir/name".
const fileDescriptions: Record<string, string> = {
  "plans/PRD.md": "Product requirements for this loop.",
  "plans/PROMPT.md": "Instruction set for the loop agent.",
  "plans/tasks.json": "Structured task list for loop execution.",
  "plans/ralph-state.md": "Autonomous worker memory across loop iterations.",
  "scripts/ralph/ralph.sh": "Editable bash entrypoint for the loop workflow.",
};

function fileDescription(file: LoopFile): string {
  return fileDescriptions[`${file.dir}/${file.name}`] ?? `${file.dir}/${file.name}`;
}

const scriptTheme = EditorView.theme({
  "&": {
    color: "#d6deeb",
    backgroundColor: "#11161f"
  },
  ".cm-content": {
    caretColor: "#d6deeb"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#d6deeb"
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "#233247"
  },
  ".cm-panels": {
    backgroundColor: "#11161f",
    color: "#d6deeb"
  },
  ".cm-activeLine": {
    backgroundColor: "#171f2c"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#171f2c",
    color: "#9db0cb"
  },
  ".cm-gutters": {
    backgroundColor: "#151b26",
    color: "#70829e",
    borderRight: "1px solid rgba(255, 255, 255, 0.06)"
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "#1a2535",
    border: "none",
    color: "#9db0cb"
  },
  ".cm-tooltip": {
    border: "1px solid rgba(255, 255, 255, 0.08)",
    backgroundColor: "#151b26"
  }
}, { dark: true });

const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment], color: "#7f8ea3" },
  { tag: [tags.string], color: "#d7c19b" },
  { tag: [tags.number, tags.integer, tags.bool], color: "#c8d4e8" },
  { tag: [tags.keyword, tags.controlKeyword], color: "#c8d4e8" },
  { tag: [tags.operator, tags.punctuation], color: "#b6c4da" },
  { tag: [tags.variableName, tags.definition(tags.variableName), tags.special(tags.variableName)], color: "#d6deeb" },
  { tag: [tags.function(tags.variableName), tags.heading, tags.labelName], color: "#d6deeb" }
]);

export default function App() {
  const loopsPanelRef = useRef<HTMLElement | null>(null);
  const newLoopBtnRef = useRef<HTMLButtonElement | null>(null);
  const fileTreeRef = useRef<HTMLElement | null>(null);
  const editorPanelRef = useRef<HTMLDivElement | null>(null);
  const createNameRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page>("home");
  const [loops, setLoops] = useState<LoopWorkspace[]>(initialLoops);
  const [activeLoopId, setActiveLoopId] = useState<string>(initialLoops[0].id);
  const [activeFileId, setActiveFileId] = useState<string>("plans/PRD.md");
  const [lastAction, setLastAction] = useState("No command selected yet.");
  const [newLoopName, setNewLoopName] = useState("");
  const [newLoopDescription, setNewLoopDescription] = useState("");
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [fileRenameValue, setFileRenameValue] = useState("");
  const [renamingLoopId, setRenamingLoopId] = useState<string | null>(null);
  const [loopRenameValue, setLoopRenameValue] = useState("");
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteFileDialogRef = useRef<HTMLDialogElement>(null);
  const uploadDirRef = useRef<string>("plans");
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current: boolean) => !current);
        return;
      }

      const target = event.target as HTMLElement | null;
      const isEditableTarget =
        Boolean(target?.closest("input, textarea, [contenteditable='true']")) ||
        Boolean(target?.isContentEditable);

      if (!event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setPage("workspace");
        if (!loops.some((loop) => loop.id === activeLoopId)) {
          setActiveLoopId(loops[0]?.id ?? initialLoops[0].id);
        }
        setActiveFileId("plans/PRD.md");
        requestAnimationFrame(() => {
          loopsPanelRef.current?.focus();
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeLoopId, loops]);

  useEffect(() => {
    if (page === "workspace") {
      requestAnimationFrame(() => {
        loopsPanelRef.current?.focus();
      });
    }
  }, [page]);

  useEffect(() => {
    if (page === "create-loop") {
      requestAnimationFrame(() => {
        createNameRef.current?.focus();
      });
    }
  }, [page]);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return commands;
    }

    return commands.filter((command) =>
      `${command.title} ${command.description}`.toLowerCase().includes(normalized)
    );
  }, [query]);

  const runCommand = (item: CommandItem) => {
    setLastAction(`${item.title} selected.`);
    setOpen(false);
    setQuery("");

    if (item.id === "open-loops") {
      setPage("workspace");
      if (!loops.some((loop) => loop.id === activeLoopId)) {
        setActiveLoopId(loops[0]?.id ?? initialLoops[0].id);
      }
      setActiveFileId("plans/PRD.md");
      return;
    }

    if (item.id === "new-loop") {
      setPage("create-loop");
      setNewLoopName("");
      setNewLoopDescription("");
    }
  };

  const activeLoop =
    loops.find((loop) => loop.id === activeLoopId) ?? loops[0];

  const activeFile =
    activeLoop?.files.find((file) => file.id === activeFileId) ?? activeLoop?.files[0];

  const editorValue = activeFile?.content ?? "";

  const editorExtensions =
    activeFile?.kind === "json"
      ? [json(), syntaxHighlighting(editorHighlightStyle)]
      : activeFile?.kind === "bash"
        ? [StreamLanguage.define(shell), syntaxHighlighting(editorHighlightStyle)]
        : [markdown(), syntaxHighlighting(editorHighlightStyle)];

  const handleEditorChange = (value: string) => {
    if (!activeFile) return;
    setLoops((currentLoops) =>
      currentLoops.map((loop) =>
        loop.id === activeLoop.id
          ? {
              ...loop,
              files: loop.files.map((f) =>
                f.id === activeFile.id ? { ...f, content: value } : f
              )
            }
          : loop
      )
    );
  };

  // Re-read a loop's files from disk and merge any changes into app state.
  const refreshLoopFiles = async (loopId: string) => {
    if (!isTauri()) return;
    try {
      const onDisk = await invoke<DiskFile[]>("read_loop_files", { loopId });
      if (Array.isArray(onDisk)) {
        setLoops((prev) =>
          prev.map((l) => {
            if (l.id !== loopId) return l;
            const files = mergeDiskFiles(l.files, onDisk);
            const iter = iterationFromFiles(files);
            return { ...l, files, iteration: iter ?? l.iteration };
          })
        );
      }
    } catch (err) {
      console.error("refreshLoopFiles error:", err);
    }
  };

  const isTasksFile = activeFile?.name === "tasks.json";

  const handleAddTask = () => {
    if (!activeFile) return;
    let data: { tasks?: unknown[] };
    try {
      data = JSON.parse(editorValue || "{}");
    } catch {
      setLastAction("tasks.json isn't valid JSON — fix it before adding a task.");
      return;
    }
    const tasks = Array.isArray(data.tasks) ? (data.tasks as Record<string, unknown>[]) : [];

    // Next id: highest existing task-N + 1, else count + 1.
    let maxN = 0;
    for (const t of tasks) {
      const m = typeof t?.id === "string" ? t.id.match(/(\d+)$/) : null;
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const nextId = `task-${Math.max(maxN + 1, tasks.length + 1)}`;

    const next = { ...data, tasks: [...tasks, { id: nextId, title: "New task", status: "pending" }] };
    handleEditorChange(JSON.stringify(next, null, 2) + "\n");
  };

  const handleAddFile = (dir: string) => {
    const name = newFileName.trim();
    if (!name || !activeLoop) return;
    if (/[\/\\]/.test(name) || name.includes("..")) return; // keep it a plain filename

    const id = `${dir}/${name}`;
    if (activeLoop.files.some((f) => f.id === id)) {
      // Already exists — just select it.
      setActiveFileId(id);
      setAddingTo(null);
      setNewFileName("");
      return;
    }

    const file = makeFile(dir, name, "");
    setLoops((prev) =>
      prev.map((l) => (l.id === activeLoop.id ? { ...l, files: [...l.files, file] } : l))
    );
    setActiveFileId(id);
    setAddingTo(null);
    setNewFileName("");
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!activeLoop) return;
    const file = activeLoop.files.find((f) => f.id === fileId);
    setConfirmDeleteFile(null);
    if (!file) return;

    const remaining = activeLoop.files.filter((f) => f.id !== fileId);
    setLoops((prev) =>
      prev.map((l) => (l.id === activeLoop.id ? { ...l, files: remaining } : l))
    );

    // If the active file was deleted, select a neighbor.
    if (activeFileId === fileId) {
      setActiveFileId(remaining[0]?.id ?? "");
    }

    // Remove it from disk too.
    if (isTauri()) {
      try {
        await invoke("delete_loop_file", {
          loopId: activeLoop.id,
          dir: file.dir,
          name: file.name,
        });
      } catch (err) {
        console.error("delete_loop_file error:", err);
      }
    }
  };

  const handleRenameFile = async (fileId: string) => {
    const newName = fileRenameValue.trim();
    setRenamingFileId(null);
    if (!activeLoop || !newName) return;
    const file = activeLoop.files.find((f) => f.id === fileId);
    if (!file || newName === file.name) return;
    if (/[\/\\]/.test(newName) || newName.includes("..")) return;

    const newId = `${file.dir}/${newName}`;
    if (activeLoop.files.some((f) => f.id === newId)) return; // name taken

    setLoops((prev) =>
      prev.map((l) =>
        l.id === activeLoop.id
          ? {
              ...l,
              files: l.files.map((f) =>
                f.id === fileId
                  ? { ...f, name: newName, id: newId, kind: kindFromName(newName) }
                  : f
              ),
            }
          : l
      )
    );
    if (activeFileId === fileId) setActiveFileId(newId);

    if (isTauri()) {
      try {
        await invoke("rename_loop_file", {
          loopId: activeLoop.id,
          dir: file.dir,
          oldName: file.name,
          newName,
        });
      } catch (err) {
        console.error("rename_loop_file error:", err);
      }
    }
  };

  const handleRenameLoop = (loopId: string) => {
    const newName = loopRenameValue.trim();
    setRenamingLoopId(null);
    if (!newName) return;
    setLoops((prev) =>
      prev.map((l) => (l.id === loopId ? { ...l, name: newName } : l))
    );
  };

  const handleUploadFiles = async (dir: string, fileList: FileList | null) => {
    if (!fileList || !activeLoop) return;
    const newFiles: LoopFile[] = [];
    for (const f of Array.from(fileList)) {
      try {
        // Images are stored as data URLs so the editor can render them;
        // everything else is read as text.
        const content =
          kindFromName(f.name) === "image" ? await fileToDataUrl(f) : await f.text();
        newFiles.push(makeFile(dir, f.name, content));
      } catch {
        continue; // skip unreadable files
      }
    }
    if (newFiles.length === 0) return;

    setLoops((prev) =>
      prev.map((l) => {
        if (l.id !== activeLoop.id) return l;
        const existingIds = new Set(l.files.map((f) => f.id));
        const merged = [...l.files];
        for (const nf of newFiles) {
          const idx = merged.findIndex((f) => f.id === nf.id);
          if (idx >= 0) merged[idx] = nf; // overwrite same-name file
          else merged.push(nf);
          existingIds.add(nf.id);
        }
        return { ...l, files: merged };
      })
    );
    setActiveFileId(newFiles[newFiles.length - 1].id);
  };

  const handleCreateLoop = () => {
    const name = newLoopName.trim();

    if (!name) {
      createNameRef.current?.focus();
      return;
    }

    const baseId =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || `loop-${Date.now()}`;

    // Ensure the id (and therefore the on-disk directory) is unique, even if a
    // renamed loop still holds the derived id.
    let loopId = baseId;
    for (let n = 2; loops.some((l) => l.id === loopId); n++) {
      loopId = `${baseId}-${n}`;
    }

    const createdLoop: LoopWorkspace = {
      id: loopId,
      name,
      status: "idle",
      iteration: 0,
      files: defaultFiles(
        newLoopDescription.trim()
          ? { prd: defaultPrd.replace("Say `Hi, I'm a loop`.", newLoopDescription.trim()) }
          : undefined
      ),
    };

    setLoops((currentLoops) => [...currentLoops, createdLoop]);
    setActiveLoopId(createdLoop.id);
    setActiveFileId("plans/PRD.md");
    setLastAction(`${createdLoop.name} created.`);
    setPage("workspace");
  };

  const handleDeleteLoop = async () => {
    setConfirmDelete(false);

    // Cancel any running execution of this loop before removing it.
    const deletedLoop = activeLoop;
    if (isTauri()) {
      try {
        if (deletedLoop.status === "running") {
          await invoke("stop_loop", { loopId: deletedLoop.id });
        }
        // Remove the loop's directory from disk so it doesn't come back.
        await invoke("delete_loop_dir", { loopId: deletedLoop.id });
      } catch (err) {
        console.error("delete loop cleanup error:", err);
      }
    }

    const remaining = loops.filter((loop) => loop.id !== activeLoop.id);

    setLoops(remaining);
    setLogLines((prev) => prev.filter((l) => l.loopId !== deletedLoop.id));

    if (remaining.length === 0) {
      setActiveLoopId(initialLoops[0].id);
      setActiveFileId("plans/PRD.md");
      setPage("home");
      setLastAction(`${activeLoop.name} deleted.`);
      return;
    }

    const deletedIndex = loops.findIndex((loop) => loop.id === activeLoop.id);
    const fallbackIndex = Math.max(0, deletedIndex - 1);
    const nextLoop = remaining[fallbackIndex] ?? remaining[0];

    setActiveLoopId(nextLoop.id);
    setActiveFileId("plans/PRD.md");
    setLastAction(`${activeLoop.name} deleted.`);

    requestAnimationFrame(() => {
      loopsPanelRef.current?.focus();
    });
  };

  const moveActiveFile = (direction: 1 | -1) => {
    const files = activeLoop?.files ?? [];
    if (files.length === 0) return;
    const currentIndex = files.findIndex((file) => file.id === activeFileId);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + files.length) % files.length;
    setActiveFileId(files[nextIndex].id);
  };

  const handleFileTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Don't hijack keys while typing in an inline input (e.g. rename/new-file).
    if ((event.target as HTMLElement).closest("input, textarea")) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveFile(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveFile(-1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      loopsPanelRef.current?.focus();
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && activeFile) {
      event.preventDefault();
      setConfirmDeleteFile(activeFile.id);
      return;
    }

    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      const editorContent = editorPanelRef.current?.querySelector<HTMLElement>(".cm-content");
      editorContent?.focus();
    }
  };

  const moveActiveLoop = (direction: 1 | -1) => {
    const currentIndex = loops.findIndex((loop) => loop.id === activeLoopId);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + loops.length) % loops.length;

    setActiveLoopId(loops[nextIndex].id);
    setConfirmDelete(false);
  };

  const handleLoopListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Don't hijack keys while typing in an inline input (e.g. loop rename).
    if ((event.target as HTMLElement).closest("input, textarea")) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setPage("home");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      // Past the last loop, move to the "+ New loop" button.
      const currentIndex = loops.findIndex((l) => l.id === activeLoopId);
      if (currentIndex === loops.length - 1) {
        newLoopBtnRef.current?.focus();
      } else {
        moveActiveLoop(1);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveLoop(-1);
      return;
    }

    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      fileTreeRef.current?.focus();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setConfirmDelete(true);
    }
  };

  // Load persisted loops from disk on startup (Tauri only).
  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    invoke<string>("load_loops")
      .then((raw) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(raw) as LoopWorkspace[] | null;
          // null === no manifest yet (first launch): keep seeded defaults.
          // An array (even empty) means the user's saved state — respect it.
          if (Array.isArray(parsed)) {
            // Migrate any loops saved in the old fixed-object file shape.
            const migrated = parsed.map((l) => ({
              ...l,
              files: normalizeLoopFiles(l.files),
              // Older manifests stored lastRun as a string ("4s") — drop those.
              lastRun: typeof l.lastRun === "number" ? l.lastRun : undefined,
            }));
            setLoops(migrated);
            setActiveLoopId(migrated[0]?.id ?? "");
          }
        } catch {
          // Malformed manifest — keep the seeded loops.
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist loops to disk whenever they change (after initial load).
  useEffect(() => {
    if (!loaded || !isTauri()) return;
    const handle = setTimeout(() => {
      invoke("save_loops", { loops: JSON.stringify(loops) }).catch((err) =>
        console.error("save_loops error:", err)
      );
    }, 300);
    return () => clearTimeout(handle);
  }, [loops, loaded]);

  // Reflect loop counts (total / running / needs-review) in the menu-bar tray.
  useEffect(() => {
    if (!isTauri()) return;
    const running = loops.filter((l) => l.status === "running").length;
    const review = loops.filter((l) => l.status === "needs-review").length;
    invoke("set_tray_status", { total: loops.length, running, review }).catch(() => {});
  }, [loops]);

  // Auto-scroll log drawer when new lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  // Drive the native <dialog> open/close
  useEffect(() => {
    const d = deleteDialogRef.current;
    if (!d) return;
    if (confirmDelete) {
      if (!d.open) d.showModal();
    } else {
      if (d.open) d.close();
    }
  }, [confirmDelete]);

  useEffect(() => {
    const d = deleteFileDialogRef.current;
    if (!d) return;
    if (confirmDeleteFile) {
      if (!d.open) d.showModal();
    } else {
      if (d.open) d.close();
    }
  }, [confirmDeleteFile]);

  // Tauri event listeners for loop output
  useEffect(() => {
    if (!isTauri()) return;

    const unlistenOutput = listen<{ loopId: string; line: string; stream: "stdout" | "stderr" }>(
      "loop-output",
      (event) => {
        setLogLines((prev) => [...prev, event.payload]);
      }
    );

    const unlistenEnded = listen<{ loopId: string; exitCode: number }>(
      "loop-ended",
      async (event) => {
        const { loopId, exitCode } = event.payload;
        setLoops((prev) =>
          prev.map((l) =>
            l.id === loopId
              ? { ...l, status: "needs-review" as LoopStatus, lastRun: Date.now() }
              : l
          )
        );
        setLogLines((prev) => [
          ...prev,
          { loopId, line: `— Loop ended (exit ${exitCode}) —`, stream: "stdout" },
        ]);

        // The loop edited files on disk (and may have created new ones) — reload
        // them so the editor reflects what happened, and refresh the iteration.
        await refreshLoopFiles(loopId);
      }
    );

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenEnded.then((fn) => fn());
    };
  }, []);

  // While the active loop is running, poll its files from disk so edits the
  // loop makes (to any file, including newly created ones) show up live.
  useEffect(() => {
    if (!isTauri()) return;
    if (activeLoop?.status !== "running") return;
    const loopId = activeLoop.id;
    const interval = window.setInterval(() => {
      refreshLoopFiles(loopId);
    }, 1500);
    return () => clearInterval(interval);
  }, [activeLoop?.id, activeLoop?.status]);

  useEffect(() => {
    if (page !== "workspace") {
      return;
    }

    const editorElement = editorPanelRef.current?.querySelector<HTMLElement>(".cm-editor");

    if (!editorElement) {
      return;
    }

    const handleEditorKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        fileTreeRef.current?.focus();
      }
    };

    editorElement.addEventListener("keydown", handleEditorKeyDown, true);

    return () => {
      editorElement.removeEventListener("keydown", handleEditorKeyDown, true);
    };
  }, [page, activeLoopId, activeFileId]);

  const handleRunLoop = async () => {
    if (!isTauri()) {
      alert("Run requires the Tauri desktop app. Launch with: npm run tauri dev");
      return;
    }
    try {
      const loopDir = await invoke<string>("write_loop_files", {
        loopId: activeLoop.id,
        files: activeLoop.files.map((f) => ({ dir: f.dir, name: f.name, content: f.content })),
      });
      setLoops((prev) =>
        prev.map((l) =>
          l.id === activeLoop.id
            ? { ...l, status: "running" as LoopStatus, lastRun: Date.now() }
            : l
        )
      );
      setLogLines((prev) => [
        ...prev,
        { loopId: activeLoop.id, line: `— Starting ${activeLoop.name} from ${loopDir} —`, stream: "stdout" },
      ]);
      setLogsOpen(true);
      await invoke("run_loop", { loopId: activeLoop.id, loopDir });
    } catch (err) {
      setLogLines((prev) => [
        ...prev,
        { loopId: activeLoop.id, line: `Error: ${err}`, stream: "stderr" },
      ]);
      setLogsOpen(true);
    }
  };

  const handleStopLoop = async () => {
    if (!isTauri()) return;
    try {
      await invoke("stop_loop", { loopId: activeLoop.id });
      setLoops((prev) =>
        prev.map((l) => (l.id === activeLoop.id ? { ...l, status: "idle" as LoopStatus } : l))
      );
      setLogLines((prev) => [
        ...prev,
        { loopId: activeLoop.id, line: "— Stopped by user —", stream: "stdout" },
      ]);
    } catch (err) {
      console.error("stop_loop error:", err);
    }
  };

  const handleMarkReviewed = () => {
    if (!activeLoop) return;
    setLoops((prev) =>
      prev.map((l) => (l.id === activeLoop.id ? { ...l, status: "idle" as LoopStatus } : l))
    );
    setLastAction(`${activeLoop.name} marked reviewed.`);
  };

  // Cmd/Ctrl+R toggles the active loop's run state (mirrors the Run/Stop button).
  // Also prevents the WebView's default page-reload on Cmd+R.
  useEffect(() => {
    const handleRunShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (page !== "workspace" || !activeLoop) return;
        if (activeLoop.status === "running") {
          void handleStopLoop();
        } else {
          void handleRunLoop();
        }
      }
    };
    window.addEventListener("keydown", handleRunShortcut);
    return () => window.removeEventListener("keydown", handleRunShortcut);
  }, [page, activeLoop]);

  const runningCount = loops.filter((l) => l.status === "running").length;
  const reviewCount = loops.filter((l) => l.status === "needs-review").length;
  const editorLang =
    activeFile?.kind === "json"
      ? "JSON"
      : activeFile?.kind === "bash"
        ? "Shell Script"
        : activeFile?.kind === "md"
          ? "Markdown"
          : activeFile?.kind === "image"
            ? "Image"
            : "Plain Text";
  const fileDirPart = activeFile ? `${activeFile.dir}/` : "";

  const palette = (
    <CommandPalette.Root
      open={open}
      onOpenChange={setOpen}
      items={filteredCommands}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(item) => item.title}
      getSelectableItems={(items) => items}
    >
      <CommandPalette.Input
        placeholder="Type a command..."
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <CommandPalette.List>
        <CommandPalette.Results>
          {(item) => {
            const command = item as CommandItem;
            return (
              <CommandPalette.Item key={command.id} value={command} onClick={() => runCommand(command)}>
                <span className="command-title">{command.title}</span>
                <span className="command-description">{command.description}</span>
              </CommandPalette.Item>
            );
          }}
        </CommandPalette.Results>
        <CommandPalette.Empty>No commands found</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
        <div className="palette-footer">
          <span>Enter select</span>
          <span>Esc close</span>
          <span>{isMac ? "Cmd+K" : "Ctrl+K"} toggle</span>
        </div>
      </CommandPalette.Footer>
    </CommandPalette.Root>
  );

  if (page === "home") {
    return (
      <>
        <SplashScreen
          loops={loops}
          onEnter={() => {
            if (loops.length === 0) {
              setPage("create-loop");
              return;
            }
            setPage("workspace");
            if (!loops.some((loop) => loop.id === activeLoopId)) {
              setActiveLoopId(loops[0].id);
            }
            setActiveFileId("plans/PRD.md");
          }}
          onPalette={() => setOpen(true)}
        />
        {palette}
      </>
    );
  }

  if (page === "create-loop") {
    return (
      <div className="home-shell" data-mode="dark">
        <div className="home-panel">
          <div className="page-head-row">
            <div>
              <p className="page-head-label">Create Loop</p>
              <p className="page-head-sub">Set up a new loop workspace</p>
            </div>
            <Button variant="ghost" onClick={() => setPage("workspace")}>Back</Button>
          </div>
          <div className="create-panel">
            <div className="create-field">
              <label className="create-label" htmlFor="loop-name">Loop name</label>
              <input
                id="loop-name"
                ref={createNameRef}
                className="create-input"
                type="text"
                value={newLoopName}
                onChange={(e) => setNewLoopName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateLoop()}
                placeholder="New loop name"
              />
            </div>
            <div className="create-field">
              <label className="create-label" htmlFor="loop-description">Initial goal</label>
              <textarea
                id="loop-description"
                className="create-textarea"
                value={newLoopDescription}
                onChange={(e) => setNewLoopDescription(e.target.value)}
                placeholder="Describe what this loop should accomplish"
                rows={5}
              />
            </div>
            <div className="create-actions">
              <Button onClick={handleCreateLoop}>Create Loop</Button>
            </div>
          </div>
        </div>
        {palette}
      </div>
    );
  }

  // No loops left — show the home screen instead of an empty workspace.
  if (!activeLoop) {
    return (
      <div className="home-shell" data-mode="dark">
        <div className="home-panel">
          <p className="eyebrow">Ralph Loop Junkie</p>
          <h1 className="home-h1">No loops yet</h1>
          <p className="home-copy">Create a loop workspace to get started.</p>
          <div className="home-actions">
            <Button onClick={() => setPage("create-loop")}>Create Loop</Button>
            <Button variant="ghost" onClick={() => setOpen(true)}>Command Palette</Button>
          </div>
        </div>
        {palette}
      </div>
    );
  }

  return (
    <>
    <div className="app" data-mode="dark">
      {/* Topbar */}
      <header className="topbar">
        <div className="brand">
          <LoopMark size={26} />
          <span className="brand-name">Ralph<span className="v">v0.4</span></span>
        </div>
        <nav className="crumbs">
          <span className="c-dim">Workspace</span>
          <span className="sep">/</span>
          <span className="c-cur">
            {activeLoop.name}
            <span className="path-tag">loops/{activeLoop.id}</span>
          </span>
        </nav>
        <div className="spacer" />
        <div className="work-stat">
          <span className="dot" />
          <b>{loops.length}</b>&nbsp;loops&nbsp;·&nbsp;<b>{runningCount}</b>&nbsp;running
          {reviewCount > 0 && (
            <>
              &nbsp;·&nbsp;<b className="review-count">{reviewCount}</b>&nbsp;
              <span className="review-count">need review</span>
            </>
          )}
        </div>
        {activeLoop.status === "needs-review" && (
          <button className="hbtn reviewed" onClick={handleMarkReviewed} title="Clear the needs-review flag">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M5 12l5 5 9-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Mark reviewed
          </button>
        )}
        {activeLoop.status === "running" ? (
          <button className="hbtn stop" onClick={handleStopLoop} title={`Stop loop (${isMac ? "⌘" : "Ctrl+"}R)`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            Stop
          </button>
        ) : (
          <button className="hbtn run" onClick={handleRunLoop} title={`Run loop (${isMac ? "⌘" : "Ctrl+"}R)`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4l14 8-14 8V4z" />
            </svg>
            Run
          </button>
        )}
        <button className="hbtn danger" onClick={() => setConfirmDelete(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Delete Loop
        </button>
        <button className="hbtn ghost" onClick={() => setPage("home")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
      </header>

      {/* Body */}
      <div className="body">
        {/* Loops panel */}
        <section
          className="panel-col loops"
          aria-label="Loops"
          tabIndex={0}
          ref={loopsPanelRef}
          onKeyDown={handleLoopListKeyDown}
        >
          <div className="panel-head">
            <div className="ph-l">
              <h2>Loops</h2>
              <span className="ph-sub">Workspace list</span>
            </div>
            <span className="count">{loops.length} loops</span>
          </div>
          <div className="loop-list">
            {loops.map((loop) => (
              <div
                key={loop.id}
                className={`loop ${activeLoopId === loop.id ? "sel" : ""}`}
                onClick={() => setActiveLoopId(loop.id)}
                role="button"
                tabIndex={-1}
                aria-current={activeLoopId === loop.id ? "true" : "false"}
              >
                <div className="loop-top">
                  <div>
                    {renamingLoopId === loop.id ? (
                      <input
                        className="loop-name-input"
                        autoFocus
                        value={loopRenameValue}
                        onChange={(e) => setLoopRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameLoop(loop.id);
                          if (e.key === "Escape") setRenamingLoopId(null);
                        }}
                        onBlur={() => handleRenameLoop(loop.id)}
                      />
                    ) : (
                      <div
                        className="loop-name"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingLoopId(loop.id);
                          setLoopRenameValue(loop.name);
                        }}
                        title="Double-click to rename"
                      >
                        {loop.name}
                      </div>
                    )}
                    <div className="loop-path">loops/{loop.id}</div>
                  </div>
                  <span className={`badge ${statusBadgeClass(loop.status)}`}>
                    <span className="bdot" />
                    {statusLabel(loop.status)}
                  </span>
                </div>
                <div className="loop-meta">
                  <HeartbeatBars active={loop.status === "running"} />
                  <span className="m">iter <b>{loop.iteration}</b></span>
                  {loop.lastRun
                    ? <span className="m">last run <b>{formatRelative(loop.lastRun)}</b></span>
                    : <span className="m">paused</span>
                  }
                </div>
              </div>
            ))}
            <button
              ref={newLoopBtnRef}
              className="new-loop"
              onClick={() => { setPage("create-loop"); setNewLoopName(""); setNewLoopDescription(""); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  e.stopPropagation();
                  loopsPanelRef.current?.focus();
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPage("create-loop");
                  setNewLoopName("");
                  setNewLoopDescription("");
                }
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              New loop
            </button>
          </div>
        </section>

        {/* Files panel */}
        <section
          className="panel-col files"
          aria-label="Workspace files"
          tabIndex={0}
          ref={fileTreeRef}
          onKeyDown={handleFileTreeKeyDown}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragOverDir) setDragOverDir("plans");
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverDir(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverDir(null);
            handleUploadFiles("plans", e.dataTransfer.files);
          }}
        >
          <div className="panel-head">
            <div className="ph-l">
              <h2>Files</h2>
              <span className="ph-sub">Loop source</span>
            </div>
            <div className="ph-r">
              <button
                className="fg-add"
                title="Refresh files from disk"
                onClick={() => refreshLoopFiles(activeLoop.id)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M20 11a8 8 0 1 0-.5 4M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="count">{activeLoop.files.length} files</span>
            </div>
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              handleUploadFiles(uploadDirRef.current, e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <div className="file-groups">
            {FOLDERS.map((folder) => {
              const filesInDir = activeLoop.files.filter((f) => f.dir === folder.dir);
              return (
                <div
                  className={`fg ${dragOverDir === folder.dir ? "drop-active" : ""}`}
                  key={folder.dir}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverDir(folder.dir);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverDir(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverDir(null);
                    handleUploadFiles(folder.dir, e.dataTransfer.files);
                  }}
                >
                  <div className="fg-label">
                    <span>{folder.label}</span>
                    <button
                      className="fg-add"
                      title={`Upload file to ${folder.label}`}
                      onClick={() => {
                        uploadDirRef.current = folder.dir;
                        uploadInputRef.current?.click();
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="M12 16V4M7 9l5-5 5 5M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      className="fg-add"
                      title={`Add file to ${folder.label}`}
                      onClick={() => {
                        setAddingTo(folder.dir);
                        setNewFileName("");
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  <div className="file-rows">
                    {filesInDir.map((file) =>
                      renamingFileId === file.id ? (
                        <div key={file.id} className="file file-new">
                          <FileIcon kind={kindFromName(fileRenameValue)} active />
                          <input
                            className="file-new-input"
                            autoFocus
                            value={fileRenameValue}
                            onChange={(e) => setFileRenameValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameFile(file.id);
                              if (e.key === "Escape") setRenamingFileId(null);
                            }}
                            onBlur={() => handleRenameFile(file.id)}
                          />
                        </div>
                      ) : (
                        <div
                          key={file.id}
                          className={`file ${activeFile?.id === file.id ? "sel" : ""}`}
                          onClick={() => setActiveFileId(file.id)}
                          onDoubleClick={() => {
                            setRenamingFileId(file.id);
                            setFileRenameValue(file.name);
                          }}
                          role="button"
                          tabIndex={-1}
                          aria-current={activeFile?.id === file.id ? "true" : "false"}
                          title="Double-click to rename"
                        >
                          <FileIcon kind={file.kind} active={activeFile?.id === file.id} />
                          <span className="fname">{file.name}</span>
                          <span className={`ftag ${file.kind}`}>{file.kind.toUpperCase()}</span>
                          <button
                            className="file-del"
                            title={`Delete ${file.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteFile(file.id);
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                              <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </div>
                      )
                    )}
                    {addingTo === folder.dir && (
                      <div className="file file-new">
                        <FileIcon kind={kindFromName(newFileName)} active />
                        <input
                          className="file-new-input"
                          autoFocus
                          value={newFileName}
                          placeholder="filename.md"
                          onChange={(e) => setNewFileName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleAddFile(folder.dir);
                            if (e.key === "Escape") {
                              setAddingTo(null);
                              setNewFileName("");
                            }
                          }}
                          onBlur={() => {
                            if (newFileName.trim()) handleAddFile(folder.dir);
                            else {
                              setAddingTo(null);
                              setNewFileName("");
                            }
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Editor panel */}
        <section className="panel-col editor" aria-label="Active file editor" ref={editorPanelRef}>
          <div className="ed-head">
            <div className="ed-title-wrap">
              <div className="ed-title">
                <h1>{activeFile?.name ?? "No file"}</h1>
              </div>
              <p className="ed-desc">{activeFile ? fileDescription(activeFile) : "Select or add a file."}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {isTasksFile && (
              <button className="hbtn run" onClick={handleAddTask} title="Append a task to tasks.json">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
                Add task
              </button>
            )}
            <button
              className={`hbtn ghost log-toggle ${logsOpen ? "log-toggle-active" : ""}`}
              onClick={() => setLogsOpen((v) => !v)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M4 6h16M4 10h10M4 14h12M4 18h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              Logs
              {logLines.filter((l) => l.loopId === activeLoop.id).length > 0 && (
                <span className="log-count">
                  {logLines.filter((l) => l.loopId === activeLoop.id).length}
                </span>
              )}
            </button>
            <span className="ed-kind">{activeFile?.kind ?? "text"}</span>
          </div>
          </div>
          <div className="ed-tabs">
            {activeLoop.files.map((file) => (
              <div
                key={file.id}
                className={`ed-tab ${activeFile?.id === file.id ? "active" : ""}`}
                onClick={() => setActiveFileId(file.id)}
              >
                {activeFile?.id === file.id && <span className="tdot" />}
                {file.name}
              </div>
            ))}
          </div>
          <div className="ed-window">
            <div className="ed-frame">
              <div className="win-bar">
                <div className="lights">
                  <i className="r" />
                  <i className="y" />
                  <i className="g" />
                </div>
                <span className="win-path">
                  <span className="dir">{fileDirPart}</span>
                  {activeFile?.name}
                </span>
              </div>
              {activeFile?.kind === "image" ? (
                <div className="image-view">
                  {activeFile.content.startsWith("data:") ? (
                    <img className="image-preview" src={activeFile.content} alt={activeFile.name} />
                  ) : (
                    <div className="image-empty">
                      Image data unavailable — re-upload this file to view it.
                    </div>
                  )}
                </div>
              ) : (
                <CodeMirror
                  className="script-editor"
                  value={editorValue}
                  height="100%"
                  theme={scriptTheme}
                  extensions={editorExtensions}
                  basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
                  onChange={handleEditorChange}
                />
              )}
              <div className="statusbar">
                <div className="sb-item acc">loops/{activeLoop.id}</div>
                <div className="sb-item">{editorLang}</div>
                <div className="sb-item">UTF-8</div>
                <div className="sb-right">
                  <div className="sb-item">iteration <b style={{ color: "var(--t-hi)" }}>&nbsp;{activeLoop.iteration}</b></div>
                  <div className="sb-item acc">● {statusLabel(activeLoop.status)}</div>
                </div>
              </div>
            </div>
          </div>
          <div className={`log-drawer ${logsOpen ? "open" : ""}`}>
            <div className="log-toolbar">
              <span className="log-toolbar-label">Output</span>
              <span className="log-tag">loops/{activeLoop.id}</span>
              <div className="spacer" />
              <button
                className="log-btn-sm"
                onClick={() =>
                  setLogLines((prev) => prev.filter((l) => l.loopId !== activeLoop.id))
                }
              >
                Clear
              </button>
              <button className="log-btn-sm" onClick={() => setLogsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="log-output">
              {logLines
                .filter((l) => l.loopId === activeLoop.id)
                .map((entry, i) => (
                  <div key={i} className={`log-line ${entry.stream}`}>
                    {entry.line}
                  </div>
                ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </section>
      </div>

      {palette}
    </div>

    <dialog
      ref={deleteDialogRef}
      className="confirm-dialog"
      onClose={() => setConfirmDelete(false)}
      onClick={(e) => {
        if (e.target === deleteDialogRef.current) setConfirmDelete(false);
      }}
    >
      <div className="modal-card">
        <div className="modal-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke="var(--danger)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="modal-title">Delete {activeLoop.name}?</h2>
        <p className="modal-body">
          This removes the loop workspace from the app. Files already written to disk are not affected.
        </p>
        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="modal-btn confirm" onClick={handleDeleteLoop}>
            Delete Loop
          </button>
        </div>
      </div>
    </dialog>

    <dialog
      ref={deleteFileDialogRef}
      className="confirm-dialog"
      onClose={() => setConfirmDeleteFile(null)}
      onClick={(e) => {
        if (e.target === deleteFileDialogRef.current) setConfirmDeleteFile(null);
      }}
    >
      <div className="modal-card">
        <div className="modal-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke="var(--danger)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="modal-title">
          Delete {activeLoop.files.find((f) => f.id === confirmDeleteFile)?.name ?? "file"}?
        </h2>
        <p className="modal-body">
          This permanently deletes the file from this loop and from disk. This can't be undone.
        </p>
        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={() => setConfirmDeleteFile(null)}>
            Cancel
          </button>
          <button
            className="modal-btn confirm"
            onClick={() => confirmDeleteFile && handleDeleteFile(confirmDeleteFile)}
          >
            Delete File
          </button>
        </div>
      </div>
    </dialog>
    </>
  );
}
