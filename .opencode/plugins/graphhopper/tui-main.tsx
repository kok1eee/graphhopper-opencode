/**
 * graphhopper の TUI 表示（opencode v2 CLI plugin）。
 *
 * 3面:
 *  - prompt.footer.status : 常時見える1行チップ（サイドバー非表示でも残る）
 *  - sidebar.content      : phase ラダー＋goal＋verifier/critic バッジ
 *  - session.panel        : `/gh` で開く詳細（history 末尾つき）
 *
 * データは `.graphhopper/*.json` を直接読む（src/tui-snapshot.ts）。読み取り専用。
 * fs.watch が使えない環境でも setup は失敗させず、静的な初期表示にフォールバックする。
 *
 * 注: @opentui/solid 0.6.6 は <span> に fg を型付けしていないため、色分けは
 * `<box flexDirection="row">` + `<text fg>` の並びで行う（span のネストは使わない）。
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { type FSWatcher, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { isTurnEndEvent } from "../../../src/events";
import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  type Phase,
  type Snapshot,
  formatAge,
  formatChip,
  shortModel,
  loadSnapshot,
  phaseLadder,
  truncate,
} from "../../../src/tui-snapshot";

const PANEL = "graphhopper.status";
const DEBOUNCE_MS = 150;
const WIDTH = 30;
const REASON_WIDTH = 80;

/* ---------- store ---------- */

let current: Snapshot | null = null;
let fingerprint = "";
const listeners = new Set<() => void>();

function publish(next: Snapshot | null): void {
  const fp = next ? JSON.stringify(next) : "";
  if (fp === fingerprint) return;
  fingerprint = fp;
  current = next;
  for (const notify of listeners) notify();
}

function useSnapshot() {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(current);
  const notify = () => setSnapshot(current);
  listeners.add(notify);
  onCleanup(() => listeners.delete(notify));
  return snapshot;
}

/* ---------- running subagents ---------- */

let runningAgents: string[] = [];
const runningListeners = new Set<() => void>();

function publishRunning(next: string[]): void {
  if (next.join(",") === runningAgents.join(",")) return;
  runningAgents = next;
  for (const notify of runningListeners) notify();
}

function useRunning() {
  const [value, setValue] = createSignal<string[]>(runningAgents);
  const notify = () => setValue(runningAgents);
  runningListeners.add(notify);
  onCleanup(() => runningListeners.delete(notify));
  return value;
}

function shortAgent(agent?: string): string {
  return (agent ?? "subagent").replace(/^graphhopper-/, "");
}

/** 子セッション（subagent）のうち running のものを agent 名で返す */
function computeRunning(context: Plugin.Context): string[] {
  const names: string[] = [];
  for (const info of context.data.session.list()) {
    if (!info.parentID) continue;
    try {
      if (context.data.session.status(info.id) === "running") names.push(shortAgent(info.agent));
    } catch {
      // 個別セッションの失敗は無視する
    }
  }
  return [...new Set(names)].slice(0, 3);
}

/* ---------- colors ---------- */

function useColors() {
  const context = usePlugin();
  return {
    base: context.theme.text.base,
    muted: context.theme.text.muted,
    faint: context.theme.text.faint,
    accent: context.theme.hue.accent[500],
    success: context.theme.text.feedback.success.base,
    warning: context.theme.text.feedback.warning.base,
    error: context.theme.text.feedback.error.base,
  };
}

function phaseColor(colors: ReturnType<typeof useColors>, status: "done" | "current" | "pending") {
  if (status === "current") return colors.accent;
  if (status === "done") return colors.success;
  return colors.faint;
}

function verdictMark(level: "clean" | "drift" | null): string {
  return level === "clean" ? "✓" : level === "drift" ? "!" : "·";
}

function verdictText(verdict: { level: "clean" | "drift"; reason: string; at: string | null } | null): string {
  if (!verdict) return "(none)";
  const age = formatAge(verdict.at);
  return `${verdict.level} — ${truncate(verdict.reason, REASON_WIDTH)}${age ? ` (${age})` : ""}`;
}

/* ---------- components ---------- */

function Ladder(props: { phase: Phase }) {
  const colors = useColors();
  return (
    <box flexDirection="row">
      <For each={phaseLadder(props.phase)}>
        {(step, index) => (
          <>
            <Show when={index() > 0}>
              <text fg={colors.faint}> › </text>
            </Show>
            <text fg={phaseColor(colors, step.status)}>
              {step.status === "current" ? <b>{step.phase}</b> : step.phase}
            </text>
          </>
        )}
      </For>
    </box>
  );
}

function Badges(props: { snapshot: Snapshot }) {
  const colors = useColors();
  const color = (level: "clean" | "drift" | null) =>
    level === "clean" ? colors.success : level === "drift" ? colors.warning : colors.faint;
  const critic = () => props.snapshot.critic;
  const verifier = () => props.snapshot.verifier;
  return (
    <box flexDirection="row">
      <text fg={colors.muted}>critic </text>
      <text fg={color(critic()?.level ?? null)}>{verdictMark(critic()?.level ?? null)}</text>
      <Show when={formatAge(critic()?.at ?? null)}>
        <text fg={colors.faint}> {formatAge(critic()?.at ?? null)}</text>
      </Show>
      <text fg={colors.muted}> · verify </text>
      <text fg={color(verifier()?.level ?? null)}>{verdictMark(verifier()?.level ?? null)}</text>
      <Show when={formatAge(verifier()?.at ?? null)}>
        <text fg={colors.faint}> {formatAge(verifier()?.at ?? null)}</text>
      </Show>
    </box>
  );
}

function Sidebar() {
  const snapshot = useSnapshot();
  const colors = useColors();
  return (
    <Show when={snapshot()}>
      {(value) => (
        <box flexDirection="column">
          <box flexDirection="row">
            <text fg={colors.muted}>
              <b>graphhopper</b>
            </text>
            <Show when={value().entryRoute}>
              <text fg={colors.accent}> {value().entryRoute}</text>
            </Show>
            <Show when={value().escalated}>
              <text fg={colors.warning}> ↑</text>
            </Show>
          </box>
          <Ladder phase={value().phase} />
          <Show when={value().title}>
            <text fg={colors.base}>{truncate(value().title, WIDTH)}</text>
          </Show>
          <Badges snapshot={value()} />
          <box flexDirection="row">
            <text fg={colors.muted}>Δ</text>
            <text
              fg={
                value().diff.lines === null
                  ? colors.faint
                  : value().diff.lines! > value().diff.threshold
                    ? colors.warning
                    : colors.muted
              }
            >
              {value().diff.lines ?? "–"}
            </text>
            <text fg={colors.faint}>/{value().diff.threshold}</text>
            <text fg={colors.muted}> · f{value().failStreak}</text>
            <Show when={value().cascade}>
              <text fg={value().cascade!.level === "escalated" ? colors.warning : colors.faint}>
                {" · "}
                {value().cascade!.level === "escalated" ? "↑" : ""}
                {shortModel(value().cascade!.model)}
              </text>
            </Show>
            <Show when={value().loop.blocked}>
              <text fg={colors.error}> loop!</text>
            </Show>
          </box>
        </box>
      )}
    </Show>
  );
}

function Chip() {
  const snapshot = useSnapshot();
  const running = useRunning();
  const colors = useColors();
  return (
    <Show when={snapshot()}>
      {(value) => (
        <box flexDirection="row">
          <text fg={value().phase === "done" ? colors.success : colors.accent}>{formatChip(value())}</text>
          <Show when={running().length > 0}>
            <text fg={colors.muted}>·⟳{running().length}</text>
          </Show>
        </box>
      )}
    </Show>
  );
}

function Row(props: { label: string; value: string }) {
  const colors = useColors();
  return (
    <Show when={props.value}>
      <box flexDirection="row">
        <text fg={colors.muted}>{props.label.padEnd(10)}</text>
        <text fg={colors.base}>{props.value}</text>
      </box>
    </Show>
  );
}

function HistoryEntry(props: { entry: Snapshot["history"][number] }) {
  const colors = useColors();
  return (
    <box flexDirection="row">
      <text fg={colors.faint}>{props.entry.ts.slice(11, 19)} </text>
      <text fg={colors.muted}>{props.entry.type}</text>
      <Show when={props.entry.detail}>
        <text fg={colors.faint}> {props.entry.detail}</text>
      </Show>
    </box>
  );
}

function Panel(props: { panel: { close: () => void; toggleFullscreen: () => void } }) {
  const snapshot = useSnapshot();
  const running = useRunning();
  const colors = useColors();
  const context = usePlugin();

  // docs: layer は setup か component から呼べる。Solid の component body は mount 時に1回だけ走り、
  // この Panel は <Show when={panel.name === PANEL}> の中なので開閉で mount/unmount される。
  // よって layer も開閉1回ずつ生成/破棄され、signal 更新で再登録されることはない。
  // 将来 layer の中身をリアクティブに変えたくなったら、ここではなく createEffect 内で
  // keymap.layer(...) を再登録し、cleanup で破棄する形にすること。
  context.keymap.layer(() => ({
    mode: "global",
    priority: 20,
    commands: [
      { id: "graphhopper.panel.fullscreen", title: "Toggle fullscreen", bind: "f", run: props.panel.toggleFullscreen },
      { id: "graphhopper.panel.close", title: "Close panel", bind: "escape", run: props.panel.close },
    ],
    bindings: ["graphhopper.panel.fullscreen", "graphhopper.panel.close"],
  }));

  return (
    <Show when={snapshot()} fallback={<text fg={colors.muted}>no active goal</text>}>
      {(value) => (
        <box flexDirection="column" padding={1}>
          <box flexDirection="row">
            <text fg={colors.base}>
              <b>graphhopper</b>
            </text>
            <text fg={colors.muted}> · {value().repo} · {value().goalID}</text>
          </box>
          <text fg={colors.base}>{value().title}</text>
          <text> </text>
          <Ladder phase={value().phase} />
          <Row label="goal" value={value().goalStatus} />
          <Row
            label="route"
            value={`${value().entryRoute ?? "full (未判定)"}${value().escalated ? " (escalated)" : ""}`}
          />
          <Row label="session" value={value().sessionID ?? "unbound"} />
          <Row
            label="diff"
            value={`${value().diff.lines ?? "–"} / ${value().diff.threshold} lines → ${value().diff.route ?? "(not checked)"}${
              value().diff.checkedAt ? ` @ ${value().diff.checkedAt!.slice(11, 16)}` : ""
            }`}
          />
          <Row label="eval" value={value().evalCmd ?? "(なし: attempt自己申告)"} />
          <Row label="critic" value={verdictText(value().critic)} />
          <Row label="verifier" value={verdictText(value().verifier)} />
          <Row
            label="loop"
            value={`${value().loop.stopCount}/${value().loop.stopMax}${value().loop.blocked ? " blocked" : ""} · streak ${value().loop.streak}`}
          />
          <Row label="fail" value={String(value().failStreak)} />
          <Row
            label="cascade"
            value={
              value().cascade
                ? `${value().cascade!.level} · ${value().cascade!.model ?? "-"} · children ${value().cascade!.children}`
                : "(off)"
            }
          />
          <Row label="running" value={running().join(", ") || "(idle)"} />
          <Row label="notes" value={truncate(value().notes, REASON_WIDTH)} />
          <Row label="updated" value={value().updatedAt} />
          <Show when={value().history.length > 0}>
            <text> </text>
            <text fg={colors.muted}>history</text>
            <For each={value().history}>{(entry) => <HistoryEntry entry={entry} />}</For>
          </Show>
        </box>
      )}
    </Show>
  );
}

/* ---------- data ---------- */

const WATCH_FILES = new Set(["state.json", "goals.json", "config.json", "history.jsonl"]);

/**
 * `.graphhopper/` を監視する。ディレクトリが無い間は repo root を見張り、
 * 作成されたら本命に付け替える。返り値の dispose で timer と watcher を必ず畳む。
 */
function createWatch(root: string, refresh: () => void): () => void {
  const dir = join(root, ".graphhopper");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let watchingDir = existsSync(dir);
  let disposed = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, DEBOUNCE_MS);
  };

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    if (disposed) return;
    if (watchingDir) {
      // ファイル名が取れない環境（一部のプラットフォーム）では全部通す
      if (filename !== null && !WATCH_FILES.has(filename.toString())) return;
    } else if (existsSync(dir)) {
      watchingDir = true;
      arm(); // .graphhopper が作られたので本命に付け替える
    } else {
      return;
    }
    schedule();
  };

  const arm = () => {
    watcher?.close();
    watcher = undefined;
    try {
      watcher = watch(watchingDir ? dir : root, { persistent: false }, onEvent);
    } catch {
      watcher = undefined; // watch 不可の環境では初期表示のまま動かさない
    }
  };

  arm();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
  };
}

/* ---------- notifications ---------- */

type NotifySound = "default" | "question" | "permission" | "error" | "done" | "subagent_done";

const NOTIFY_DEDUPE_MS = 3000;

/**
 * 端末が blur のときだけ OS 通知＋音を出す（focus 中は無音）。
 * 対象: permission 要求 / 実行失敗 / 子セッション（verifier・oracle 等）の完了。
 * 同じセッションで連続発火するイベントは dedupe する。
 */
function setupNotifications(context: Plugin.Context): () => void {
  const recent = new Map<string, number>();

  const notify = (key: string, message: string, sound: NotifySound) => {
    const now = Date.now();
    if (now - (recent.get(key) ?? 0) < NOTIFY_DEDUPE_MS) return;
    recent.set(key, now);
    const goal = current ? truncate(current.title, 40) : "";
    try {
      void context.attention
        .notify({
          title: goal ? `graphhopper · ${goal}` : "graphhopper",
          message,
          notification: { when: "blurred" },
          sound: { name: sound, when: "blurred" },
        })
        .catch(() => {
          // 通知は best-effort（失敗してもセッションを壊さない）
        });
    } catch {
      // renderer 破棄済みなどは無視する
    }
  };

  let stop: (() => void) | undefined;
  try {
    stop = context.data.listen(({ details }) => {
      const event = details as { type?: string; data?: { sessionID?: string } };
      const sessionID = event.data?.sessionID;
      if (!sessionID) return;

      if (event.type === "permission.asked") {
        notify(`permission:${sessionID}`, "permission requested", "permission");
        return;
      }
      if (event.type === "session.execution.failed") {
        notify(`failed:${sessionID}`, "run failed", "error");
        return;
      }
      if (isTurnEndEvent(event.type)) {
        let isChild = false;
        try {
          isChild = context.data.session.root(sessionID) !== sessionID;
        } catch {
          isChild = false;
        }
        if (isChild) notify(`child:${sessionID}`, "subagent finished", "subagent_done");
      }
    });
  } catch {
    // イベント購読に失敗しても表示は動かす
  }
  return () => stop?.();
}

/**
 * 子セッション（subagent）の稼働状況を購読する。イベントのたびに再計算するが、
 * 300ms の debounce でまとめる。取れない環境では空のまま（表示は出ない）。
 */
function setupRunning(context: Plugin.Context): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        publishRunning(computeRunning(context));
      } catch {
        // 一覧取得に失敗しても表示は止めない
      }
    }, 300);
  };

  try {
    stop = context.data.listen(({ details }) => {
      const type = (details as { type?: string }).type;
      if (!type) return;
      if (
        type === "session.execution.started" ||
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted"
      ) {
        schedule();
      }
    });
  } catch {
    stop = undefined;
  }

  schedule();

  return () => {
    if (timer) clearTimeout(timer);
    stop?.();
  };
}

/* ---------- plugin ---------- */

export default Plugin.define({
  id: "graphhopper.tui",
  async setup(context) {
    const root = context.location?.directory ?? process.cwd();
    const refresh = () => publish(loadSnapshot(root));

    refresh();
    const stopWatch = createWatch(root, refresh);
    const offNotifications = setupNotifications(context);
    const stopRunning = setupRunning(context);

    const offFooter = context.ui.slot({ append: "prompt.footer.status", render: () => <Chip /> });
    const offSidebar = context.ui.slot({ append: "sidebar.content", render: () => <Sidebar /> });
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <Panel panel={panel} />
        </Show>
      ),
    });

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "graphhopper.panel.open",
          title: "graphhopper: status",
          group: "graphhopper",
          bind: "<leader>h",
          palette: true,
          slash: { name: "gh", aliases: ["graphhopper"] },
          run: () => {
            context.ui.panel.open(PANEL);
          },
        },
      ],
      bindings: ["graphhopper.panel.open"],
    }));

    return () => {
      stopWatch();
      offNotifications();
      stopRunning();
      offFooter();
      offSidebar();
      offPanel();
    };
  },
});
