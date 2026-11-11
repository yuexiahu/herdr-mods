// 终端文本里的链接：识别 URL、绝对路径、~/ 和相对路径。
// 规则取自 Ghostty 链接匹配的常用部分（herdr-app src/links.rs 用的同一套），
// 只做右键菜单需要的事：找出候选、去掉句末标点、去掉 :行号。

const SCHEME = /^(?:https?|ftp|file|ssh|git|mailto|tel|magnet|ipfs|ipns|gemini|gopher|news):/i;
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const WIN_PATH = /^[A-Za-z]:[\\/]/;
// \\server\share\...（Windows 的 UNC 路径）
const UNC_PATH = /^\\\\[^\\]+\\/;

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

// 把 ~/、~\ 与相对路径补成绝对路径（检查存在性和打开都用它）。
export function absolute(path, cwd, home) {
  let p = path;
  if ((p.startsWith("~/") || p.startsWith("~\\")) && home) p = `${home}/${p.slice(2)}`;
  if (!p.startsWith("/") && !WIN_PATH.test(p) && !UNC_PATH.test(p)) {
    p = `${(cwd || "/").replace(/[\\/]+$/, "")}/${p}`;
  }
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

// 中日韩字符和全角标点：紧贴中文的 URL 到这些字符为止。
const WIDE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const ANY_URL_SCHEME = /(?:https?|ftp|file|ssh|git|mailto|tel|magnet|ipfs|ipns|gemini|gopher|news):/i;

// “已推送：https://...” / “（https://...）” 这种紧贴文字的 URL：从 scheme 开始抠出来。
function embeddedUrl(token) {
  const m = ANY_URL_SCHEME.exec(token);
  if (!m) return null;
  // 前面是字母/数字说明它不是一个独立 URL（foohttps://...）。
  if (m.index > 0 && /[A-Za-z0-9]/.test(token[m.index - 1])) return null;
  let s = token.slice(m.index);
  const cut = s.search(WIDE);
  if (cut >= 0) s = s.slice(0, cut);
  return clean(s);
}

// 一个词是不是链接；是的话返回它的种类。
export function classify(token) {
  const t = clean(token);
  if (!t || t.length > 1024) return null;
  // 先找 URL（可能在中文标点后面），file:// 再按本机路径处理。
  const url = embeddedUrl(t) ?? ((SCHEME.test(t) || ANY_SCHEME.test(t)) ? t : null);
  if (url) {
    if (/^file:\/\//i.test(url)) {
      let p = url.slice(7).replace(/^localhost/i, "");
      try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
      // file:///C:/Users/... 在 Windows 上就是 C:/Users/...
      if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
      if (p.startsWith("/") || WIN_PATH.test(p) || UNC_PATH.test(p)) return { kind: "path", path: p };
    }
    return validUrl(url) ? { kind: "url", url } : null;
  }
  if (t.startsWith("~/") || t.startsWith("~\\")) return { kind: "path", path: t };
  if (t.startsWith("/") && t.length > 2) return { kind: "path", path: t };
  if (WIN_PATH.test(t) || UNC_PATH.test(t)) return { kind: "path", path: t };
  // 相对路径：带目录，且末尾像扩展名（可跟 :行号）；/ 和 \ 都算。
  if (/[\\/]/.test(t) && /[^\\/]\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/.test(t)) {
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
  const all = [...byKey.values()];
  // 被截断的 URL（是另一个更长 URL 的前缀）不要。
  for (const a of all) {
    if (a.kind !== "url") continue;
    if (all.some((b) => b !== a && b.kind === "url" && b.url.length > a.url.length && b.url.startsWith(a.url))) {
      byKey.delete(a.key);
    }
  }
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
