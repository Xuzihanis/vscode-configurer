# 工作区配置助手 (vscode-configurer)

一键配置当前工作区的 `.vscode` 目录：选择编程语言 → 自动探测本机已安装的编译器 / 解释器 → 生成或**深度合并** `settings.json`、`launch.json`、`tasks.json`。

不再需要手抄 launch 配置或者猜自己机器的编译器路径。

## 功能

- **自动探测工具链**：跨平台查找本机已安装的编译器 / 解释器，并读取版本号。
  - Windows 用 `where`，Linux / macOS 用 `which`。
  - 自动跳过 Microsoft Store 的应用执行别名，以及 LibreOffice / Blender 自带的残缺解释器。
- **探测失败可手动指定**：输入框里填完整路径，并即时校验路径是否存在。
- **深度合并，绝不覆盖你的配置**：
  - 已有的键一律保留原值，生成内容只补充缺失的部分。
  - 数组按 `name` / `label` 去重追加，不会产生重复的调试配置。
  - 现有文件按 JSONC 解析，**注释和尾随逗号都能正常读取**。
  - 如果现有文件语法有误导致无法解析，该文件会被**跳过且不做任何修改**。
- **C/C++ 区分源文件类型**：C 文件用 `gcc`，C++ 文件用 `g++`，各生成一条构建任务（两者不可互换，详见下方说明）。

## 支持的语言

| 语言 | 探测顺序（取第一个命中） | 生成的调试类型 |
| --- | --- | --- |
| C/C++ | `gcc`、`g++`、`clang`、`clang++`、`cl.exe` | `cppdbg` |
| Python | `python3`、`python`、`py` | `debugpy` |
| Java | 先查 `JAVA_HOME`，再回退 PATH 上的 `java` | `java` |
| Go | `go`（并用 `go env GOROOT` 取根目录） | `go` |
| Node.js / TypeScript | `node`；另探测 `tsc` 决定是否生成 TS 调试配置 | `node` |

生成的文件需要对应的 VS Code 扩展才能实际调试：C/C++ 需要 [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)，Python 需要 [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python)，Java 需要 [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack)，Go 需要 [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go)。

## 安装

本扩展**不发布到 VS Code Marketplace**，请从 GitHub Releases 下载 `.vsix` 文件手动安装。

下载地址：<https://github.com/Xuzihanis/vscode-configurer/releases>

### 方式一：命令行

```bash
code --install-extension vscode-configurer-0.0.1.vsix
```

### 方式二：VS Code 界面

1. 打开扩展面板（`Ctrl+Shift+X` / `Cmd+Shift+X`）
2. 点击面板右上角的 `...` 菜单 → **Install from VSIX...**
3. 选择下载好的 `.vsix` 文件

安装完成后需要重载窗口：命令面板执行 `Developer: Reload Window`，或直接重启 VS Code。

### 升级

从 Releases 页面下载新版 `.vsix`，重复上述步骤即可覆盖安装（扩展 ID `xuzihan-dev.vscode-configurer` 不变，配置不会丢失）。

## 使用方法

1. 用 VS Code 打开你的项目文件夹。
2. 打开命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`），输入 `Configure .vscode`。
3. 选择 `Configurer: Configure .vscode`。
4. 在列表里选择编程语言。
5. 等待工具链探测完成 —— 未检测到时会弹出输入框，可手动填写编译器 / 解释器路径（留空则生成通用配置）。
6. 左下角提示「.vscode 配置完成」后，打开 `.vscode/` 目录查看结果。

### 生成的配置长什么样

**`settings.json`**（C/C++ 为例）

```jsonc
{
    "C_Cpp.default.compilerPath": "D:\\mingw64\\bin\\gcc.exe",
    "C_Cpp.default.cppStandard": "c++17",
    "C_Cpp.default.cStandard": "c17",
    "C_Cpp.default.includePath": ["${workspaceFolder}/**"]
}
```

**`tasks.json`** —— 按源文件类型分成两条

```jsonc
{
    "tasks": [
        { "label": "C/C++: build active C file",   "command": "D:/mingw64/bin/gcc.exe", ... },
        { "label": "C/C++: build active C++ file", "command": "D:/mingw64/bin/g++.exe", ... }
    ]
}
```

**`launch.json`** —— 调试时按当前文件类型选对应那条

```jsonc
{
    "configurations": [
        {
            "name": "C/C++: debug active C file",
            "type": "cppdbg",
            "program": "${fileDirname}/${fileBasenameNoExtension}.exe",
            "preLaunchTask": "C/C++: build active C file",
            /* ... */
        }
    ]
}
```

### 关于 C/C++ 的两条构建任务

`gcc` 不会链接 C++ 标准库，用它编译 `.cpp` 会在链接期报 `undefined reference to std::cout`；
而 `g++` 会把 `.c` 文件当 C++ 编译。两者不能互换，所以调试 `.c` 文件时请选 `debug active C file`，
调试 `.cpp` 文件时选 `debug active C++ file`。

（macOS 上 `/usr/bin/gcc` 与 `g++` 都是 clang 的符号链接，两条都能正常工作。）

## 截图

> 🖼️ 待补充。运行中的截图请放在 `docs/` 目录下，并替换下面的占位。

| 说明 | 图片 |
| --- | --- |
| 命令面板中执行 `Configure .vscode` | `docs/screenshot-command.png` |
| 语言选择列表 | `docs/screenshot-language-picker.png` |
| 未检测到工具链时的手动输入 | `docs/screenshot-manual-input.png` |
| 生成结果与完成提示 | `docs/screenshot-result.png` |

扩展图标位于 `images/icon.png`（128×128 PNG）。

## 开发与构建

```bash
npm install          # 安装依赖
npm run compile      # 编译（tsc -p ./）
npm run watch        # 监听编译
npm run package      # 打包成 .vsix（需要 @vscode/vsce）
```

调试：用 VS Code 打开本仓库，按 **F5**，在弹出的「扩展开发主机」窗口中运行命令。
详见 `.vscode/launch.json` 的「运行扩展」配置。

### 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/extension.ts` | 命令注册与流程串联：校验工作区 → 选语言 → 探测 → 手动输入兜底 → 生成 → 提示 |
| `src/languageSelector.ts` | 语言清单与 QuickPick 选择 |
| `src/toolchainDetector.ts` | 跨平台可执行文件查找、版本读取、各语言探测 |
| `src/configGenerator.ts` | JSONC 解析、深度合并、各语言配置片段生成、读改写回 `.vscode/*.json` |

### 打包注意事项

`.vscodeignore` 排除了 `src/`、`node_modules/`、`tsconfig.json` 等，**但没有排除 `out/`** ——
运行时依赖 `out/extension.js`，把它排除掉会导致安装后扩展完全不工作。

本扩展没有运行时依赖（`dependencies` 为空），因此可以安全地排除整个 `node_modules/`。
若将来引入运行时依赖，需要相应调整 `.vscodeignore`。

## 已知限制

- 同一目录下同名的 `foo.c` 与 `foo.cpp` 会共用产物路径、互相覆盖。
- 极简 Linux 环境（如 Alpine）可能没有 `which`，此时探测会失败，需手动填写路径。
- 当前命令一次只配置一门语言。

## 许可证

[MIT](LICENSE)
