import * as vscode from 'vscode';
import { ConfigFileResult, generateConfigs } from './configGenerator';
import { LanguageId, SUPPORTED_LANGUAGES, selectLanguage } from './languageSelector';
import { ToolchainInfo, detectToolchain, isWindows } from './toolchainDetector';

const COMMAND_ID = 'vscode-configurer.configureWorkspace';
const OUTPUT_CHANNEL_NAME = 'Workspace Configurer';

/** 手动输入时的路径示例，帮助用户照着填。 */
const PATH_PLACEHOLDER: Record<LanguageId, string> = {
  cpp: isWindows ? 'D:\\mingw64\\bin\\g++.exe' : '/usr/bin/g++',
  python: isWindows ? 'C:\\Python312\\python.exe' : '/usr/bin/python3',
  java: isWindows ? 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe' : '/usr/lib/jvm/jdk-21/bin/java',
  go: isWindows ? 'C:\\Go\\bin\\go.exe' : '/usr/local/go/bin/go',
  node: isWindows ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
};

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      // 命令回调里的异常不会自动冒泡到界面上，必须自己兜住，
      // 否则读写失败（权限、只读文件等）时用户看不到任何反馈。
      try {
        await configureWorkspace(channel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[错误] ${message}`);
        if (error instanceof Error && error.stack) {
          channel.appendLine(error.stack);
        }

        const action = await vscode.window.showErrorMessage(`配置工作区失败：${message}`, '查看日志');
        if (action === '查看日志') {
          channel.show();
        }
      }
    })
  );
}

export function deactivate(): void {
  // 命令与输出通道都已登记在 context.subscriptions 中，由 VS Code 统一释放。
}

function languageLabel(id: LanguageId): string {
  return SUPPORTED_LANGUAGES.find((language) => language.id === id)?.label ?? id;
}

async function configureWorkspace(channel: vscode.OutputChannel): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    return;
  }

  const language = await selectLanguage();
  if (!language) {
    channel.appendLine('未选择语言，操作已取消。');
    return;
  }

  const label = languageLabel(language);
  channel.appendLine(`[${new Date().toLocaleString()}] 配置工作区：${folder.uri.fsPath}（${label}）`);

  let toolchain = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在探测 ${label} 工具链…` },
    () => detectToolchain(language)
  );

  // 探测不到就退回手动输入。
  if (!toolchain) {
    const prompt = await promptForToolchainPath(language, label);
    if (prompt.kind === 'cancelled') {
      channel.appendLine('未提供工具链路径，操作已取消。');
      return;
    }
    toolchain = prompt.toolchain;
  }

  channel.appendLine(toolchain ? `使用工具链：${toolchain.path}` : '未指定工具链，生成通用配置。');

  const results = await generateConfigs(folder.uri, language, toolchain);
  channel.appendLine('配置写入完成。');

  await vscode.window.showInformationMessage(`.vscode 配置完成（${label}）。`);
  await warnAboutStaleEntries(results, channel);
}

/**
 * 合并只增不减，旧版本生成的条目会原样留存 —— 结果就是升级扩展后修复不生效，而且完全静默。
 * 这里只做检测与提示，**不修改任何文件**。
 *
 * 措辞上不能断言"这些是旧版本生成的"：内容不一致同样可能是用户自己改过。
 */
async function warnAboutStaleEntries(
  results: readonly ConfigFileResult[],
  channel: vscode.OutputChannel
): Promise<void> {
  const stale = results.flatMap((result) =>
    (result.stale ?? []).map((name) => `${result.fileName} 里的「${name}」`)
  );

  if (stale.length === 0) {
    return;
  }

  channel.appendLine(`检测到 ${stale.length} 条与本版本生成规则不一致的配置：`);
  for (const item of stale) {
    channel.appendLine(`  ${item}`);
  }

  await vscode.window.showWarningMessage(
    `检测到 ${stale.length} 条配置与当前版本的生成规则不一致：${stale.join('、')}。` +
      `它们可能是旧版本生成的，也可能是你手动改过的 —— 本扩展不会覆盖已有配置，所以这些条目会一直保持原样。` +
      `若要套用新版本的生成规则，请先删除 .vscode 目录再重新运行本命令；注意这也会一并丢弃你对这些条目做过的修改。`
  );
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    await vscode.window.showErrorMessage('请先打开一个文件夹或工作区，再运行此命令。');
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  // 多根工作区：规格未涉及，这里让用户明确选一个，避免默默配置错文件夹。
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { title: '选择要配置的工作区文件夹', ignoreFocusOut: true }
  );

  return picked?.folder;
}

type ToolchainPromptResult =
  | { kind: 'cancelled' }
  | { kind: 'use'; toolchain: ToolchainInfo | undefined };

/** 探测失败时让用户手动填写路径；留空表示接受通用配置。 */
async function promptForToolchainPath(
  language: LanguageId,
  label: string
): Promise<ToolchainPromptResult> {
  const entered = await vscode.window.showInputBox({
    title: `未检测到 ${label} 工具链`,
    prompt: '请输入编译器 / 解释器的完整路径；留空则生成通用配置',
    placeHolder: PATH_PLACEHOLDER[language],
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return undefined;
      }
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(trimmed));
        return undefined;
      } catch {
        return '该路径不存在';
      }
    },
  });

  if (entered === undefined) {
    return { kind: 'cancelled' };
  }

  const trimmed = entered.trim();
  return { kind: 'use', toolchain: trimmed.length > 0 ? { path: trimmed, language } : undefined };
}
