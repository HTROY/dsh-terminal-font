# dsh-terminal-font

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）右侧边栏的终端设置字体，
修正 oh-my-posh / Powerline / Nerd Font 图标显示成方块（豆腐块）的问题。

A dsh plugin that sets the sidebar terminal font from Settings, so oh-my-posh, Powerline and
Nerd Font glyphs render correctly instead of as boxes.

- 设置位置：**设置 → 终端**（Settings → Terminal）
- 可设：启用开关、字体名（带常用 Nerd Font 建议）、字号、实时字形预览
- 已在 dsh `0.2.0-rc.2`（Windows 桌面版 + PowerShell 7 + oh-my-posh）上验证
- 依赖：`@deepseek-ai/dsh-client-ui-sidebar-terminal`（读取其内部接缝，见下）

---

## 问题是什么

`@deepseek-ai/dsh-client-ui-sidebar-terminal` 创建 xterm 实例时把字体写死，且没有暴露任何配置入口：

```js
new Terminal({
  minimumContrastRatio: 4.5,
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  scrollback: /* ... */ 0
});
```

Windows 上这套字体栈最终落到 Consolas，而 Consolas 没有 Nerd Font 的私用区（PUA）字形，
所以 oh-my-posh 的 `` / `` / `` 等图标就显示成方块。

## 安装

需要 dsh 具备 profile 管理能力（桌面版或 `dsh web`）。

**方式一：设置界面**

1. 打开 **设置 → 插件 → 添加插件**；
2. 填入 `github:HTROY/dsh-terminal-font`；
3. 确认安装（会有一项 dsh 兼容性检查），完成后插件立即生效。

**方式二：命令行**

```bash
dsh plugin add github:HTROY/dsh-terminal-font --profile desktop
```

**方式三：本地源码**

```bash
git clone https://github.com/HTROY/dsh-terminal-font.git
dsh plugin add /absolute/path/to/dsh-terminal-font --profile desktop
```

安装后可在 **设置 → 插件** 里看到 `dsh-terminal-font`（禁用/卸载同样在那里）。

## 使用

1. 打开 **设置 → 终端**。
2. **字体** 留空即使用推荐字体栈（依次尝试 `CaskaydiaCove Nerd Font Mono`、
   `JetBrainsMono Nerd Font Mono`、`CaskaydiaMono Nerd Font Mono`、`Hack Nerd Font Mono`、
   `MesloLGS NF`，最后回退到内置字体栈）——只要机器上装了其中任意一款，图标就会正常显示。
3. 也可以填任意已安装的字体名，输入框的下拉列表给出常见 Nerd Font 名称。
   填写的内容会作为 `"<字体名>", <内置字体栈>` 使用；若填写内容含逗号，则按完整的 CSS 字体列表使用。
4. **字号** 用 `−/+` 调整；选 `自动` 表示沿用终端内置字号。改字号后终端会自动重新适配列宽
   （xterm 网格与 PTY 一起更新）。
5. **预览** 会实时显示 Powerline 分隔符与常用图标；显示为方块说明该字体未安装或名字不对。

设置保存在浏览器 `localStorage`（键 `dsh-terminal-font.settings.v1`）——它描述的是"这台机器用什么字体
画终端"，属于浏览器侧偏好，而不是 Host 端配置。更改会立即作用于已打开的终端。

## 工作原理

终端插件把 xterm 实例存在 React 的 `useRef` 里：既没有全局单例，也不会在 DOM 上留下实例引用，
因此插件从三个受限但完整的接缝接入（全部在 `client.js`，可逆且透明）：

1. **`window.__ModuleLoader__.load`**
   包装懒加载块 `@deepseek-ai/dsh-client-ui-sidebar-terminal/client.terminal.js` 的 factory，
   使该 chunk 拿到的 `react` 模块是一个 Proxy —— 除 `useRef` 外所有导出原样透传。
2. **`useRef` 代理**
   `TerminalScreen` 通过 `terminal.current = xterm` / `fit.current = addon` 保存实例；
   代理在赋值瞬间拿到实例，写入 `xterm.options.fontFamily` / `xterm.options.fontSize`。
3. **`window.ResizeObserver`**
   终端自己的 `measure()` 回调会同时调整 xterm 网格与 PTY 尺寸；换字号后重放它即可正确重新适配，
   避免"显示变了但 shell 还以为旧列宽"的错位。

对于**插件加载前就已经打开的终端**，另有一条兜底路径：React 会在它渲染过的 DOM 节点上留下 fiber，
`TerminalScreen` 的 hook 链里就有 xterm 与 FitAddon 实例，组件 props 里还有终端 model，
因此插件可以照搬终端自己的 `fitScreen` 逻辑完成同步。

关闭开关或选择"自动"字号时，插件还原该终端**原本的**字体与字号（安装时记录，而非硬编码常量）。

## 已知限制

- 依赖 `@deepseek-ai/dsh-client-ui-sidebar-terminal` 的内部实现（chunk 名、`useRef` 用法、
  `ResizeObserver` 回调语义、React fiber 结构）。该包升级后若这些细节变化，字体可能不再生效；
  届时请按上文"工作原理"的 1–3 条重新核对，并欢迎提 issue。
- 字体必须安装在**运行浏览器的那台机器**上（桌面版即本机）。插件不打包字体文件。
- 只影响 Web 终端渲染；dsh 的 shell 工具输出（bash/pwsh 工具卡片）不受影响。
- Host 侧只有一行占位插件，不注册任何服务、不联网、不读写文件。

## 开发与测试

插件是纯 JavaScript，无需构建：

```
dsh-terminal-font/
├─ package.json          # dsh.bundle / dsh.client 清单
├─ cordis.patch.yml      # bundle 层：插入 terminal-font 插件行
├─ index.js              # Host 侧占位（apply 为空）
├─ client.js             # 全部逻辑：设置页 + 三个接缝 + fiber 兜底
├─ locale/{en,zh}.json   # 插件商店展示文案
├─ icon.svg
└─ test/verify.mjs       # 机制测试
```

测试用假的 module loader / React / ResizeObserver / xterm 实例驱动 `client.js`，覆盖：
包注册、chunk factory 包装、`useRef` 捕获、字体写入、换字号后重放 fit 回调、禁用还原、
以及"插件加载前已存在的终端"的 fiber 兜底（含通过 props 取回 model 完成 xterm + PTY 同步）：

```bash
node test/verify.mjs
```

> 说明：该测试验证的是插件与 dsh 内部接缝之间的机制，不代表浏览器里的最终视觉结果。

## License

[MIT](LICENSE)
