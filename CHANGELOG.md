# Changelog

本文件记录本扩展的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 已知限制

- **已经生成的 `.vscode` 配置不会被新版本更新**。深度合并按 `name` / `label` 去重，同名条目会被
  当作「用户已有配置」原样保留。因此升级本扩展后想套用新的生成逻辑，需要先删掉 `.vscode`
  目录再重新运行命令。合并只增不减是刻意设计（绝不覆盖用户手写内容）的代价。

### 计划中

- 恢复一次配置多门语言（`selectLanguages()` / `configureWorkspaceFolder()` 已在代码中保留，尚未接回命令流程）。
- 为 C/C++ 产物路径增加按源文件类型区分，避免同目录下 `foo.c` 与 `foo.cpp` 互相覆盖。
- 在极简 Linux 环境（无 `which`）下回退到 `command -v`。

## [0.0.3] - 2026-10-04

### 修复

- **按 F5 默认选中 C 配置，导致 `.cpp` 文件用 gcc 编译并链接失败。**
  最常见的用法是「先配置一个还没有源文件的项目目录，再动手写代码」，此时工作区里一个源文件
  都没有，无从判断语言，两条变体都会生成；而 C 变体排在前面，VS Code 的调试配置下拉框
  默认选中 `launch.json` 里的第一条，于是 `.cpp` 落到了 gcc 上。
  现把更可能正确的变体排到最前（空工作区、混合工作区都默认 C++），默认构建任务取同一条。
- **纯 C++ 工作区仍会生成 C 调试配置。** `Ctrl+Shift+B` 的默认任务在 0.0.2 已修正，但 F5
  的下拉框里依然同时存在 C 与 C++ 两条。现改为**只生成与工作区匹配的变体**：
  纯 C++ 工作区只留 C++ 那条，纯 C 工作区只留 C 那条，两类文件都有（或工作区为空）时才两条都生成。
- **`npm run package` 报 `'vsce' 不是内部或外部命令`。** `package.json` 里的
  `"package": "vsce package"` 引用了未安装的 vsce。现把 `@vscode/vsce` 加入 devDependencies，
  CI 也改走 `npm run package` 以锁定同一份版本。

## [0.0.2] - 2026-10-04

### 修复

- **默认构建任务会编译失败**：此前固定把 C 任务（`gcc`）设为 `isDefault`，在 `.cpp` 工作区按
  `Ctrl+Shift+B` 会用 gcc 编译 C++ 文件，链接期报 `undefined reference to std::cout` 等错误，
  同时导致 `debug active C file` 这条调试配置对 `.cpp` 文件完全不可用。
  现改为扫描工作区实际内容决定默认任务，详见下方"默认构建任务的判定规则"。
- **调试时无法输入**：两个 cppdbg 配置原先都是 `externalConsole: false`，程序运行在只读的
  Debug Console 中，`cin` / `scanf` 会报 "does not support stdin input"。现改为
  `externalConsole: true`。
  - 注：cppdbg **不支持** `console` 属性，写上会报 `Property console is not allowed`，
    因此不能用 `console: integratedTerminal` 来避免弹出独立窗口。
- **编译参数缺少语言标准**：`settings.json` 里的 `cppStandard` / `cStandard` 只作用于 IntelliSense，
  不影响真实编译，导致编辑器提示与实际构建可能脱节。现两个任务分别显式传入
  `-std=c17` 与 `-std=c++17`。

### 默认构建任务的判定规则

`Ctrl+Shift+B` 直接运行默认构建任务，因此默认任务必须与工作区的源文件类型匹配：

| 工作区构成 | 默认任务 |
| --- | --- |
| 只含 `.cpp` / `.cc` / `.cxx` | C++ 任务（`g++`） |
| 只含 `.c` | C 任务（`gcc`） |
| 两者都有 | C++ 任务（`g++` 更宽容，也能把 `.c` 当 C++ 编译） |
| 空工作区 | C++ 任务 |

扫描会跳过 `node_modules`、`build`、`dist`、`target`、`bin`、`obj` 与隐藏目录，并有上限
（100 个源文件 / 3000 个目录项），不会在大仓库里拖慢。

## [0.0.1] - 2026-10-03

首个版本。

### 新增

- 命令 `vscode-configurer.configureWorkspace`（命令面板中显示为 `Configure .vscode`）。
- 语言选择：C/C++、Python、Java、Go、Node.js / TypeScript。
- 跨平台工具链探测：Windows 用 `where`，Unix 用 `which`；支持版本读取。
  - 过滤 Microsoft Store 应用执行别名，避免生成无法执行的配置。
  - 软件捆绑的解释器（LibreOffice / Blender 自带 python、Oracle javapath 跳板）排到独立安装之后。
- 探测失败时可手动输入编译器 / 解释器路径，并校验路径是否存在。
- 生成并**深度合并** `.vscode/settings.json`、`launch.json`、`tasks.json`：
  - 用户已有配置一律优先，绝不被生成内容覆盖。
  - 数组按 `name` / `label` 去重追加。
  - 按 JSONC 解析现有文件（容忍注释与尾随逗号）。
  - 现有文件解析失败时跳过该文件、不做任何写入。
- C/C++ 按源文件类型生成两条构建任务：C 文件用 `gcc`，C++ 文件用 `g++`。
- 扩展打包信息：`icon`、`repository`、`keywords` 等。

[Unreleased]: https://github.com/Xuzihanis/vscode-configurer/compare/v0.0.3...HEAD
[0.0.3]: https://github.com/Xuzihanis/vscode-configurer/releases/tag/v0.0.3
[0.0.2]: https://github.com/Xuzihanis/vscode-configurer/releases/tag/v0.0.2
[0.0.1]: https://github.com/Xuzihanis/vscode-configurer/releases/tag/v0.0.1
