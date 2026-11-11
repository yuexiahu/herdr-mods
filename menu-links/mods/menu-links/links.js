// 终端文本里的链接：识别 URL、绝对路径、~/ 和相对路径。
// 规则取自 Ghostty 链接匹配的常用部分（herdr-app src/links.rs 用的同一套），
// 只做右键菜单需要的事：找出候选、去掉句末标点、去掉 :行号。

const SCHEME = /^(?:https?|ftp|file|ssh|git|mailto|tel|magnet|ipfs|ipns|gemini|gopher|news):/i;
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const WIN_PATH = /^[A-Za-z]:[\\/]/;

// 去掉包在链接外面的括号、引号、句末标点，以及 `VAR=路径` 的赋值前缀。
function clean(token) {
  let s = token.replace(/^[([{<>"'`]+/, "");
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
  s = s.replace(/^[([{<>"'`]+/, "");
  s = s.replace(/[)\]}>"'`,;!?。，；：！？、）】」』》]+$/, "");
  s = s.replace(/[.,]+$/, "");
  s = s.replace(/:$/, "");
  return s;
}

// `path:12`、`path:12:7`、`path:70-150` 的行号只在检查文件是否存在时去掉。
export function barePath(path) {
  return path.replace(/(?::\d+(?:-\d+)?){1,2}$/, "");
}

// 把 ~/ 和相对路径补成绝对路径（检查存在性和交给 wslpath 都用它）。
export function absolute(path, cwd, home) {
  let p = path;
  if (p.startsWith("~/") && home) p = `${home}/${p.slice(2)}`;
  if (!p.startsWith("/") && !WIN_PATH.test(p)) p = `${(cwd || "/").replace(/\/+$/, "")}/${p}`;
  return p;
}

// URL 里不能出现的字符：{host}{uri} 这类模板，以及 <> " ` | \ ^。
// IPv6 的 [::1] 保留。
const BAD_URL_CHARS = /[{}<>"`|\\^]/;
// https://$HOST/... 这种模板：协议后、路径前的 $ 不算主机名。
const DOLLAR_IN_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*\$/;

// 只接受真正能打开的 URL；https://{host}{uri}、https://<host>/x 之类丢掉。
export function validUrl(t) {
  if (BAD_URL_CHARS.test(t) || DOLLAR_IN_AUTHORITY.test(t)) return false;
  if (typeof URL === "function") {
    try {
      const u = new URL(t);
      if (!u.protocol) return false;
      // 带 // 的协议必须有主机：https:///x 这类不算。
      if (t.includes("://") && !u.hostname) return false;
      return true;
    } catch {
      return false;
    }
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/[^\s/?#]+(?:[/?#]\S*)?|\S+)$/.test(t);
}

// 一个词是不是链接；是的话返回它的种类。
export function classify(token) {
  const t = clean(token);
  if (!t || t.length > 1024) return null;
  // file:///home/x：按本机路径处理，交给 wslpath/资源管理器。
  if (/^file:\/\//i.test(t)) {
    let p = t.slice(7).replace(/^localhost/i, "");
    if (p.startsWith("/")) {
      try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
      return { kind: "path", path: p };
    }
  }
  if (SCHEME.test(t) || ANY_SCHEME.test(t)) return validUrl(t) ? { kind: "url", url: t } : null;
  if (t.startsWith("~/")) return { kind: "path", path: t };
  if (t.startsWith("/") && t.length > 2) return { kind: "path", path: t };
  if (WIN_PATH.test(t)) return { kind: "path", path: t };
  // 相对路径：带目录，且末尾像扩展名（可跟 :行号）。
  if (t.includes("/") && /[^/]\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/.test(t)) {
    return { kind: "path", path: t };
  }
  return null;
}

// 屏幕文本 → 链接。同一个路径/URL 只留最后一次出现，并从下到上排
// （最新输出在最下面，右键时通常想开那条）。
export function findLinks(text) {
  const byKey = new Map();
  String(text ?? "").split(/\r?\n/).forEach((line, row) => {
    // Markdown 的 [文字](目标)：先把目标抠出来。
    const plain = line.replace(/\]\(([^)\s]+)\)/g, " $1 ");
    for (const token of plain.split(/\s+/)) {
      const link = classify(token);
      if (!link) continue;
      const key = link.kind === "url" ? `u:${link.url}` : `p:${barePath(link.path)}`;
      byKey.set(key, { ...link, key, row });
    }
  });
  return [...byKey.values()].sort((a, b) => b.row - a.row);
}

// 菜单上怎么显示：文件名 + 所在目录；URL 只给地址，右侧用图标。
export function describe(link, real) {
  if (link.kind === "url") return { label: link.url, hint: "" };
  const cut = Math.max(real.lastIndexOf("/"), real.lastIndexOf("\\"));
  return {
    label: cut >= 0 ? real.slice(cut + 1) || real : real,
    hint: cut > 0 ? real.slice(0, cut) : "",
  };
}
