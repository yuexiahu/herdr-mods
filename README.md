# Herdr mods

我自己的 Herdr mods 集合。每个文件夹是一份可以放进 `~/.config/herdr-app` 的 mod，附一份 `RECIPE.md`：它是什么、怎么做的、假设了什么。

| Mod | |
| --- | --- |
| [Menu links](menu-links/) | 终端右键菜单里列出屏幕上的链接；本机 Windows 直接 `explorer.exe`，WSL 的路径经 `wslpath` 打开 |

## 用法

1. 把 `menu-links/mods/menu-links/` 复制到 `~/.config/herdr-app/mods/menu-links/`。
2. 在 `~/.config/herdr-app/layouts/<你的布局>.json` 的根节点加一行：

   ```json
   "terminal_menu": "menu-links"
   ```

3. 检查：

   ```sh
   herdr-app check ~/.config/herdr-app/mods/menu-links
   ```

不需要 `keys.json`。也没有 `layouts/` 文件夹：它只换终端的右键菜单，不改窗口布局。

## 分享

按 Herdr 的约定：一个文件夹一个 mod，带 `RECIPE.md` 和 `preview.png`。给仓库加 `herdr-mod` 主题后，它会出现在 [herdr.dev/mods](https://herdr.dev/mods)。
