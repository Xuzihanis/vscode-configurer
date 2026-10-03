import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LanguageDefinition, LanguageId } from './languageSelector';

/** 单条探测命令的超时时间，避免 PATH 中损坏的可执行文件把命令挂住。 */
const PROBE_TIMEOUT_MS = 5_000;

export const isWindows = os.platform() === 'win32';
export const isMacOS = os.platform() === 'darwin';

export interface ToolchainInfo {
  /** 可执行文件的完整路径。 */
  path: string;
  /** 版本输出的第一行；探测失败时为 undefined。 */
  version?: string;
  /** 归一化后的工具类型，例如 'gcc' / 'clang++' / 'msvc' / 'jdk'。 */
  compilerType?: string;
  /** 该工具链所属语言。 */
  language: LanguageId;
  /**
   * SDK / 运行时根目录（JAVA_HOME、`go env GOROOT`）。
   * 原规格的 ToolchainInfo 未包含此字段，但 detectJava / detectGo 需要产出根目录供
   * 配置生成使用，故作为可选字段补充——不影响规格中定义的形状。
   */
  sdkRoot?: string;
}

// ---------------------------------------------------------------------------
// 进程执行辅助
// ---------------------------------------------------------------------------

interface CaptureResult {
  stdout: string;
  stderr: string;
}

/**
 * 执行外部命令并捕获输出。
 * 不因非零退出码丢弃输出：部分工具（如 `java -version`）把版本写到 stderr。
 */
function runCapture(file: string, args: readonly string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (_error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

/** 取输出中第一行非空内容作为版本号。 */
async function readVersion(execPath: string, args: readonly string[] = ['--version']): Promise<string | undefined> {
  const { stdout, stderr } = await runCapture(execPath, args);
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// findExecutable
// ---------------------------------------------------------------------------

/**
 * Windows 的 `where` 会命中 Microsoft Store 的应用执行别名
 * （...\WindowsApps\python.exe）。这类占位程序无法真正执行，
 * 用它生成的配置是坏的，必须直接丢弃。
 */
function isAppExecutionAlias(filePath: string): boolean {
  return isWindows && /[\\/]WindowsApps[\\/]/i.test(filePath);
}

/**
 * 已知的「捆绑解释器 / 跳板程序」路径特征：某些软件自带 python、java 并写进 PATH，
 * 它们缺少完整发行版的能力（如 LibreOffice 的 python 没有 pip/venv，Oracle 的
 * javapath 只是注册表跳板而非 JDK）。这类候选仍然保留，但排在独立安装之后。
 */
const DEPRIORITIZED_PATH_PATTERNS: readonly RegExp[] = [
  /[\\/]LibreOffice[\\/]/i,
  /[\\/]Blender[\\/]/i,
  /[\\/]Common Files[\\/]Oracle[\\/]Java[\\/]/i,
];

function isDeprioritized(filePath: string): boolean {
  return DEPRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function parsePathLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((line) => line.length > 0);
}

/**
 * 从 `where` / `which` 的多行输出中挑出可用路径。
 * 优先返回第一行；仅当第一行是无法执行的占位程序、或存在已知的捆绑解释器时，
 * 才顺延到下一个候选——直接采信字面第一行会生成无法运行的配置。
 */
function selectCandidate(candidates: readonly string[]): string | undefined {
  const usable = candidates.filter((candidate) => !isAppExecutionAlias(candidate));
  const ordered = usable
    .map((filePath, index) => ({ filePath, index }))
    .sort(
      (a, b) =>
        Number(isDeprioritized(a.filePath)) - Number(isDeprioritized(b.filePath)) || a.index - b.index
    )
    .map((entry) => entry.filePath);

  return ordered[0];
}

/**
 * 跨平台查找可执行文件：Windows 用 `where`，其他平台用 `which`。
 * 返回输出中的可用路径；命令不存在、超时或出错时返回 undefined。
 */
export function findExecutable(command: string): Promise<string | undefined> {
  const locator = os.platform() === 'win32' ? 'where' : 'which';

  return new Promise((resolve) => {
    // command 始终来自本模块内的固定候选列表，不含用户输入，故无注入面。
    exec(`${locator} ${command}`, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(selectCandidate(parsePathLines(stdout ?? '')));
    });
  });
}

// ---------------------------------------------------------------------------
// 各语言探测
// ---------------------------------------------------------------------------

const CPP_COMPILERS: readonly { command: string; type: string }[] = [
  { command: 'gcc', type: 'gcc' },
  { command: 'g++', type: 'g++' },
  { command: 'clang', type: 'clang' },
  { command: 'clang++', type: 'clang++' },
  { command: 'cl.exe', type: 'msvc' },
];

/** 依次尝试 gcc、g++、clang、clang++、cl.exe，返回第一个找到的编译器。 */
export async function detectCppToolchain(): Promise<ToolchainInfo | undefined> {
  for (const { command, type } of CPP_COMPILERS) {
    const execPath = await findExecutable(command);
    if (!execPath) {
      continue;
    }

    return {
      path: execPath,
      version: await readVersion(execPath, ['--version']),
      compilerType: type,
      language: 'cpp',
    };
  }

  return undefined;
}

const PYTHON_COMMANDS: readonly string[] = ['python3', 'python', 'py'];

/** 依次尝试 python3、python、py，返回第一个找到的解释器。 */
export async function detectPython(): Promise<ToolchainInfo | undefined> {
  for (const command of PYTHON_COMMANDS) {
    const execPath = await findExecutable(command);
    if (!execPath) {
      continue;
    }

    return {
      path: execPath,
      version: await readVersion(execPath, ['--version']),
      compilerType: command,
      language: 'python',
    };
  }

  return undefined;
}

/** JAVA_HOME 在 Windows 上可能带引号或结尾反斜杠，需先归一化。 */
function normalizeJavaHome(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  return trimmed ? trimmed : undefined;
}

/** 优先检查 JAVA_HOME，其次回退到 PATH 上的 java。 */
export async function detectJava(): Promise<ToolchainInfo | undefined> {
  const javaHome = normalizeJavaHome(process.env.JAVA_HOME);

  if (javaHome) {
    const javaBin = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
    if (await isFile(javaBin)) {
      return {
        path: javaBin,
        version: await readVersion(javaBin, ['-version']),
        compilerType: 'jdk',
        language: 'java',
        sdkRoot: javaHome,
      };
    }
  }

  const execPath = await findExecutable('java');
  if (!execPath) {
    return undefined;
  }

  return {
    path: execPath,
    version: await readVersion(execPath, ['-version']),
    compilerType: 'java',
    language: 'java',
  };
}

/** 尝试 go，并用 `go env GOROOT` 取得 SDK 根目录。 */
export async function detectGo(): Promise<ToolchainInfo | undefined> {
  const execPath = await findExecutable('go');
  if (!execPath) {
    return undefined;
  }

  const goroot = (await runCapture(execPath, ['env', 'GOROOT'])).stdout.trim();

  return {
    path: execPath,
    version: await readVersion(execPath, ['version']),
    compilerType: 'go',
    language: 'go',
    ...(goroot ? { sdkRoot: goroot } : {}),
  };
}

/** 尝试 node。 */
export async function detectNode(): Promise<ToolchainInfo | undefined> {
  const execPath = await findExecutable('node');
  if (!execPath) {
    return undefined;
  }

  return {
    path: execPath,
    version: await readVersion(execPath, ['--version']),
    compilerType: 'node',
    language: 'node',
  };
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/** 按语言分派到对应的探测函数；任何异常都吞掉并返回 undefined。 */
export async function detectToolchain(language: LanguageId): Promise<ToolchainInfo | undefined> {
  try {
    switch (language) {
      case 'cpp':
        return await detectCppToolchain();
      case 'python':
        return await detectPython();
      case 'java':
        return await detectJava();
      case 'go':
        return await detectGo();
      case 'node':
        return await detectNode();
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** 并行探测多门语言，key 为语言标识，未找到的语言值为 undefined。 */
export async function detectToolchains(
  languages: readonly LanguageDefinition[]
): Promise<Map<LanguageId, ToolchainInfo | undefined>> {
  const entries = await Promise.all(
    languages.map(async (language) => [language.id, await detectToolchain(language.id)] as const)
  );

  return new Map(entries);
}
