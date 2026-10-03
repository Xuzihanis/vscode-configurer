# Changelog

本文件记录本扩展的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 恢复一次配置多门语言（`selectLanguages()` / `configureWorkspaceFolder()` 已在代码中保留，尚未接回命令流程）。
- 为 C/C++ 产物路径增加按源文件类型区分，避免同目录下 `foo.c` 与 `foo.cpp` 互相覆盖。
- 在极简 Linux 环境（无 `which`）下回退到 `command -v`。

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

[Unreleased]: https://github.com/Xuzihanis/vscode-configurer/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/Xuzihanis/vscode-configurer/releases/tag/v0.0.1
