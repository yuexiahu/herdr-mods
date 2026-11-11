// 终端右键菜单：Herdr 的原生项 + 终端文本里的链接。
// 克隆自 menu 0.1.15。本机 Windows 的路径直接交给 explorer.exe；
// WSL 的路径先在那边 wslpath -w，再交给 explorer.exe；URL 用 rundll32。
// ↑/↓ 移动，Enter 执行，Esc 关闭。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, hc, home as homeDir, notify, window } from "herdr";
import { absolute, barePath, classify, describe, findLinks } from "./links.js";

const MAX_LINKS = 6;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

// ---- 链接：读终端、在那边校验、打开 ----

// 选中的文本（Herdr 松开鼠标时已复制）如果整段就是一个链接，优先显示。
function selectedLink(cx) {
  let text = "";
  try { text = String(cx.read_from_clipboard?.() ?? "").trim(); } catch { /* 没有剪贴板 */ }
  if (!text || text.length > 512 || /[\r\n]/.test(text)) return null;
  // 整段当一条：路径里可以有空格，别按空白拆；Markdown 链接保留名字。
  const link = findLinks(text)[0] ?? classify(text);
  return link ? { ...link, selected: true } : null;
}

// 解析 sh/PowerShell 的输出：每条 `下标\t类型\t路径\0`。
function foundPaths(stdout, paths) {
  const out = new Map();
  for (const chunk of String(stdout ?? "").split("\0")) {
    if (!chunk) continue;
    const [i, type, ...rest] = chunk.split("\t");
    const real = rest.join("\t");
    if (real && paths[Number(i)]) out.set(paths[Number(i)], { real, dir: type === "d" });
  }
  return out;
}

// 本机之外的机器（WSL 等）：一次 sh 批量 test -e。
async function existingShell(machine, paths) {
  const script = `i=0
for p in "$@"; do
  if [ -e "$p" ]; then
    if [ -d "$p" ]; then t=d; else t=f; fi
    printf '%s\\t%s\\t%s\\0' "$i" "$t" "$p"
  fi
  i=$((i+1))
done`;
  const r = await exec("sh", ["-c", script, "links", ...paths], { on: machine });
  return foundPaths(r.stdout, paths);
}

// 本机 Windows：一次 PowerShell 批量 Test-Path。
async function existingWindows(paths) {
  const quote = (p) => `'${p.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$ps=@(${paths.map(quote).join(",")})`,
    "$i=0",
    "foreach ($p in $ps) {",
    "  $item = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue",
    "  if ($item) {",
    "    if ($item.PSIsContainer) { $d='d' } else { $d='f' }",
    "    [Console]::Out.Write(\"$i`t$d`t$($item.FullName)`0\")",
    "  }",
    "  $i++",
    "}",
  ].join("\n");
  const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return foundPaths(r.stdout, paths);
}

// 存在的绝对路径 → 路径 -> { real, dir }。
async function existing(machine, paths) {
  if (!paths.length) return new Map();
  if (machine || window()?.platform !== "windows") return existingShell(machine, paths);
  return existingWindows(paths);
}

// 链接列表 → 菜单项；不存在的路径丢掉，最多 MAX_LINKS 条。
async function linkItems(text, machine, cwd, selected) {
  const found = findLinks(text);
  if (selected) found.push(selected);
  // 同一个链接只留一条；选中的那条优先。
  const byKey = new Map();
  for (const l of found) {
    const key = l.kind === "url" ? `u:${l.url}` : `p:${barePath(l.path)}`;
    if (byKey.get(key)?.selected && !l.selected) continue;
    byKey.set(key, l);
  }
  const list = [...byKey.values()].sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)) || (b.row ?? 0) - (a.row ?? 0));
  // 选中的和屏幕上的可能一个是被截断的前缀：只留更长的那个。
  const links = list.filter((l) => l.kind !== "url"
    || !list.some((o) => o !== l && o.kind === "url" && o.url.length > l.url.length && o.url.startsWith(l.url)));
  // ~ 与相对路径都在这里补齐：检查与打开只收到绝对路径。
  let home = "";
  if (links.some((l) => l.kind === "path")) {
    home = machine
      ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine })).stdout.trim()
      : homeDir();
  }
  const paths = [...new Set(links
    .filter((l) => l.kind === "path")
    .map((l) => absolute(barePath(l.path), cwd, home)))];
  const real = await existing(machine, paths);
  const out = [];
  for (const l of links) {
    if (l.kind === "url") {
      const { label, hint } = describe(l, l.url);
      out.push({ kind: "link", label: l.name ?? label, hint, hintIcon: "mods/menu-links/external-link.svg", icon: "mods/menu-links/link.svg", machine, open: { kind: "url", value: l.url } });
    } else {
      const at = real.get(absolute(barePath(l.path), cwd, home));
      if (!at) continue;
      const { label, hint } = describe(l, at.real);
      out.push({
        kind: "link", label: l.name ?? label, hint, machine,
        icon: `mods/files/${at.dir ? "folder" : "file"}.svg`,
        open: { kind: "path", value: at.real },
      });
    }
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// 在 WSL 上：路径先 wslpath -w，再交给 Windows 资源管理器（see() 的做法）；
// URL 用 rundll32（explorer.exe 会把 URL 里的 = 当自己的参数）。
// 其他远程机器退回 xdg-open。ssh 会话里没有 Windows 的 PATH，所以用绝对路径。
const OPEN_PATH = `W=/mnt/c/Windows
if command -v wslpath >/dev/null 2>&1; then
  w=$(wslpath -w "$1") || { echo "wslpath 无法转换 $1" >&2; exit 1; }
  [ -x "$W/explorer.exe" ] && { "$W/explorer.exe" "$w" >/dev/null 2>&1 || true; exit 0; }
  [ -x "$W/System32/rundll32.exe" ] && { "$W/System32/rundll32.exe" url.dll,FileProtocolHandler "$w" >/dev/null 2>&1 || true; exit 0; }
fi
exec xdg-open "$1"`;

const OPEN_URL = `W=/mnt/c/Windows
[ -x "$W/System32/rundll32.exe" ] && { "$W/System32/rundll32.exe" url.dll,FileProtocolHandler "$1" >/dev/null 2>&1 || true; exit 0; }
[ -x "$W/explorer.exe" ] && { "$W/explorer.exe" "$1" >/dev/null 2>&1 || true; exit 0; }
exec xdg-open "$1"`;

async function openLink(open, machine) {
  if (machine) {
    const script = open.kind === "url" ? OPEN_URL : OPEN_PATH;
    const r = await exec("sh", ["-c", script, "see", open.value], { on: machine });
    if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || `退出码 ${r.code}`);
    return;
  }
  const platform = window()?.platform;
  if (platform === "windows") {
    // 本机 Windows：explorer.exe 把 / 当命令行开关，路径必须全是反斜杠；
    // URL 用 rundll32，避开 = 参数。
    if (open.kind === "url") {
      await exec("rundll32.exe", ["url.dll,FileProtocolHandler", open.value]);
    } else {
      await exec("explorer.exe", [open.value.replace(/\//g, "\\")]);
    }
    // explorer.exe / rundll32 成功时也可能返回 1，不看退出码。
    return;
  }
  const opener = platform === "macos" ? "open" : "xdg-open";
  const r = await exec(opener, [open.value]);
  if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || `退出码 ${r.code}`);
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.entries = [];
    this.links = [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const selected = selectedLink(cx);
    // 只扫另一台机器上的终端：本机链接 Herdr 自己就能打开。
    const terminal = p?.tab === "pane" ? p.target?.terminal : null;
    if (terminal) this.scan(terminal, selected, cx);
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  // 读屏幕文本（不含回滚历史，和 Herdr 自己的链接检测一致），在终端所在机器上校验路径。
  scan(terminal, selected, cx) {
    const machine = terminal.includes("/") ? terminal.split("/")[0] : null;
    cx.spawn(async (cx) => {
      let links = [];
      try {
        // 终端 cwd 从 Herdr 的实时数据里取，少一次 hc 调用。
        const cwd = terminals().find((t) => t.address === terminal)?.cwd ?? "";
        const r = await hc(["read", terminal, "--json"]);
        if (!r.stdout) throw new Error(`read 返回为空 (code ${r.code}) ${r.stderr ?? ""}`);
        const read = JSON.parse(r.stdout);
        links = await linkItems(read.text ?? "", machine, cwd, selected);
      } catch {
        // 读不到就只显示 Herdr 自己的菜单项。
      }
      this.links = links;
      cx.notify();
    });
  }

  choose(i, cx) {
    const it = this.entries[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it.kind === "link") {
      openLink(it.open, it.machine).catch((e) =>
        notify({ title: "打不开这个链接", body: String(e?.message ?? e), level: "error" }),
      );
    } else if (it.command === "worktree") {
      openOverlay({
        mod: "worktree", kind: "dialog",
        ...(it.args.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }),
        props: it.args,
      });
    } else {
      run(it.command, it.args);
    }
  }

  render(cx) {
    const t = theme();
    const links = this.links ?? [];
    const base = items(props(), this.git)
      .filter((it) => it && it[1])
      .map(([label, command, args]) => ({ kind: "cmd", label, command, args }));
    const list = (this.entries = [...links, ...base]);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) => {
          const prev = list[i - 1];
          const sep = i > 0 && it.kind === "cmd" && (
            prev?.kind === "link" ||
            it.command.endsWith(".close") || it.command === "app.help" ||
            (it.command === "app.theme" && prev?.command !== "app.theme")
          );
          const hint = it.kind === "link" ? it.hint : shortcut(it.command, it.args);
          return v_flex()
            .when(sep, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
              .id(`mi-${i}`)
              .h(31)
              .px(8)
              .gap(9)
              .rounded(7)
              .items_center()
              .justify_between()
              .text_color(t.foreground)
              .when(i === this.at, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.choose(i, cx))
              .child(svg(it.kind === "link" ? it.icon : menuIcon(it.command)).size(14).flex_none().text_color(t.muted))
              .child(div().flex_1().min_w(0).truncate().child(it.label))
              .child(it.hintIcon
                ? svg(it.hintIcon).size(12).flex_none().text_color(t.dim)
                : div().flex_none().max_w(150).truncate().text_size(11).text_color(t.dim).child(hint ?? "")));
        }),
      );
  }
}
