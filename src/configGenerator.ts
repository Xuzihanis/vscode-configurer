import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageDefinition, LanguageId } from './languageSelector';
import { ToolchainInfo, findExecutable, isMacOS, isWindows } from './toolchainDetector';

/** 生成的配置片段，此时尚未与用户已有配置合并。 */
interface ConfigBundle {
  settings: Record<string, unknown>;
  launch: { version: string; configurations: LaunchConfig[] };
  tasks: { version: string; tasks: TaskDefinition[] };
}

interface LaunchConfig extends Record<string, unknown> {
  name: string;
  type: string;
  request: string;
}

interface TaskDefinition extends Record<string, unknown> {
  label: string;
  type: string;
}

/** C/C++ 的一条「源文件类型 → 编译器」映射，每个变体生成一组 task + launch。 */
interface CppVariant {
  /** 该变体处理哪类源文件，用于决定谁是默认构建任务。 */
  readonly kind: 'c' | 'cpp' | 'fallback';
  readonly taskLabel: string;
  readonly launchName: string;
  readonly compiler: string;
  /** 传给编译器的语言标准参数，如 `-std=c++17`。 */
  readonly stdFlag?: string;
  readonly detail: string;
}

export interface ConfigFileResult {
  readonly fileName: string;
  readonly status: 'created' | 'updated' | 'unchanged' | 'skipped';
  readonly detail?: string;
}

const EXE_SUFFIX = isWindows ? '.exe' : '';

const CONFIG_FILES: readonly { fileName: string; key: keyof ConfigBundle }[] = [
  { fileName: 'settings.json', key: 'settings' },
  { fileName: 'launch.json', key: 'launch' },
  { fileName: 'tasks.json', key: 'tasks' },
];

function emptyBundle(): ConfigBundle {
  return {
    settings: {},
    launch: { version: '0.2.0', configurations: [] },
    tasks: { version: '2.0.0', tasks: [] },
  };
}

// ---------------------------------------------------------------------------
// JSONC 解析
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 JSONC（带注释、尾随逗号的 JSON，即 VS Code 配置文件的实际格式）
 * 规整为可直接 JSON.parse 的文本。
 *
 * 逐字符扫描并跟踪字符串状态，因此字符串字面量里的 `//`、`,` 不会被误伤。
 */
export function normalizeJsonc(text: string): string {
  let out = '';
  let pendingCommaIndex = -1;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let i = 0;

  // 只有遇到下一个「有效字符」时才决定逗号去留，这样 `,\n}` 能被正确识别。
  const flushComma = (nextSignificant: string): void => {
    if (pendingCommaIndex < 0) {
      return;
    }
    if (nextSignificant === '}' || nextSignificant === ']') {
      out = out.slice(0, pendingCommaIndex) + out.slice(pendingCommaIndex + 1);
    }
    pendingCommaIndex = -1;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      i += 1;
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      i += 1;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      flushComma(ch);
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === ',') {
      flushComma(ch);
      pendingCommaIndex = out.length;
      out += ch;
      i += 1;
      continue;
    }

    if (!/\s/.test(ch)) {
      flushComma(ch);
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(normalizeJsonc(text));
}

// ---------------------------------------------------------------------------
// 深度合并
// ---------------------------------------------------------------------------

/** 数组去重键：优先用 name/label，其次退化为结构化比较。 */
function arrayItemKey(item: unknown): string {
  if (isPlainObject(item)) {
    if (typeof item.name === 'string') {
      return `name:${item.name}`;
    }
    if (typeof item.label === 'string') {
      return `label:${item.label}`;
    }
  }
  return `value:${JSON.stringify(item) ?? 'undefined'}`;
}

/** 追加合并：保留 target 顺序，只追加 source 中尚不存在的项。 */
function mergeArrays(target: readonly unknown[], source: readonly unknown[]): unknown[] {
  const result = [...target];
  const seen = new Set(target.map(arrayItemKey));

  for (const item of source) {
    const key = arrayItemKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

function mergeInto(target: unknown, source: unknown): unknown {
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      result[key] = key in target ? mergeInto(target[key], source[key]) : source[key];
    }
    return result;
  }

  if (Array.isArray(target) && Array.isArray(source)) {
    return mergeArrays(target, source);
  }

  return target === undefined ? source : target;
}

/**
 * 深度合并对象，数组按追加方式合并、已存在的唯一项不会被重复加入。
 *
 * 注意方向：**target 优先**——与常见「source 覆盖 target」的 deepMerge 约定相反。
 * 这里 target 是用户已有配置，source 是本次生成的内容，因此必须保证
 * 用户已有配置不被生成结果覆盖。
 */
export function deepMerge(target: any, source: any): any {
  return mergeInto(target, source);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 各语言的配置片段
// ---------------------------------------------------------------------------

/** 扫描时跳过的目录，避免在依赖与构建产物里白跑。 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'out',
  'build',
  'dist',
  'target',
  'bin',
  'obj',
  'venv',
  '__pycache__',
]);

/**
 * 有上限地统计工作区中某几类源文件的数量，用于推断工作区以 C 还是 C++ 为主。
 * 目录不可读（权限等）时跳过该目录，不影响其余分支；达到上限即提前返回。
 */
async function countSourceFiles(
  root: vscode.Uri,
  extensions: ReadonlySet<string>,
  limit = 100
): Promise<number> {
  const queue: vscode.Uri[] = [root];
  let files = 0;
  let visited = 0;

  while (queue.length > 0 && files < limit && visited < 3000) {
    const dir = queue.shift();
    if (!dir) {
      break;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      visited += 1;
      if (type === vscode.FileType.Directory) {
        if (!SKIPPED_DIRS.has(name) && !name.startsWith('.')) {
          queue.push(vscode.Uri.joinPath(dir, name));
        }
      } else if (extensions.has(path.extname(name).toLowerCase())) {
        files += 1;
      }
    }
  }

  return files;
}

const C_SOURCE_EXTS: ReadonlySet<string> = new Set(['.c']);
const CPP_SOURCE_EXTS: ReadonlySet<string> = new Set(['.cpp', '.cxx', '.cc', '.c++']);

async function addCpp(
  bundle: ConfigBundle,
  toolchain: ToolchainInfo | undefined,
  workspaceRoot: vscode.Uri
): Promise<void> {
  const debuggerPath = await findExecutable(isMacOS ? 'lldb' : 'gdb');
  // 产物与源文件同目录，与 launch.json 的 program 保持一致。
  const outputPath = `\${fileDirname}/\${fileBasenameNoExtension}${EXE_SUFFIX}`;

  if (toolchain) {
    // IntelliSense 只需要一个编译器；cpptools 会按文件类型自行传 -x c / -x c++。
    bundle.settings['C_Cpp.default.compilerPath'] = toolchain.path;
  }
  bundle.settings['C_Cpp.default.cppStandard'] = 'c++17';
  bundle.settings['C_Cpp.default.cStandard'] = 'c17';
  bundle.settings['C_Cpp.default.includePath'] = ['${workspaceFolder}/**'];

  // C 和 C++ 必须用不同的编译器驱动：gcc 不会链 libstdc++（编译 .cpp 会在链接期报
  // undefined reference to std::...），而 g++ 会把 .c 文件当 C++ 编译。
  // macOS 上 /usr/bin/gcc、g++ 是 clang 的 shim，走同一路径同样正确。
  const cCompiler = (await findExecutable('gcc')) ?? (await findExecutable('clang'));
  const cppCompiler = (await findExecutable('g++')) ?? (await findExecutable('clang++'));

  // 先看工作区里到底有什么源文件 —— 这同时决定「生成哪些变体」和「谁是默认任务」。
  const cCount = cCompiler ? await countSourceFiles(workspaceRoot, C_SOURCE_EXTS) : 0;
  const cppCount = cppCompiler ? await countSourceFiles(workspaceRoot, CPP_SOURCE_EXTS) : 0;
  const isEmptyWorkspace = cCount === 0 && cppCount === 0;

  // 只生成与工作区匹配的变体。纯 C++ 工作区里再摆一条 C 调试配置只会让人选错——
  // F5 的下拉框会记住上次选择，落到 gcc 那条就链接失败。两种情况仍生成两条：
  //   - 两类源文件都存在 → 此时选择无法避免
  //   - 工作区为空       → 无从判断，不武断地砍掉一种
  const emitC = Boolean(cCompiler) && (cCount > 0 || isEmptyWorkspace);
  const emitCpp = Boolean(cppCompiler) && (cppCount > 0 || isEmptyWorkspace);

  const variants: CppVariant[] = [];
  if (cCompiler && emitC) {
    variants.push({
      kind: 'c',
      taskLabel: 'C/C++: build active C file',
      launchName: 'C/C++: debug active C file',
      compiler: cCompiler,
      stdFlag: '-std=c17',
      detail: `使用 ${isMacOS ? 'gcc (clang shim)' : 'gcc'} 编译当前 C 文件`,
    });
  }
  if (cppCompiler && emitCpp) {
    variants.push({
      kind: 'cpp',
      taskLabel: 'C/C++: build active C++ file',
      launchName: 'C/C++: debug active C++ file',
      compiler: cppCompiler,
      stdFlag: '-std=c++17',
      detail: `使用 ${isMacOS ? 'g++ (clang shim)' : 'g++'} 编译当前 C++ 文件`,
    });
  }
  // 一个变体都没生成（没探测到编译器，或工作区内容与已装编译器对不上）：
  // 退化成一条通用任务，配置仍可用，只是需要用户自行确认编译器。
  if (variants.length === 0) {
    variants.push({
      kind: 'fallback',
      taskLabel: 'C/C++: build active file',
      launchName: 'C/C++: debug active file',
      compiler: toolchain?.path ?? 'g++',
      detail: '未探测到匹配的 gcc / g++，使用通用编译器命令',
    });
  }

  // 默认构建任务同样要与工作区匹配：Ctrl+Shift+B 跑的就是默认任务，
  // 给 .cpp 工作区默认 gcc 会链接失败，给纯 C 工作区默认 g++ 又会把 .c 当 C++ 编译。
  // 只有「有 C 文件且完全没有 C++ 文件」时才默认 C 任务，其余情况默认 C++（g++ 更宽容）。
  const wantedKind = cCount > 0 && cppCount === 0 ? 'c' : 'cpp';
  const defaultIndex = Math.max(
    variants.findIndex((variant) => variant.kind === wantedKind),
    0
  );

  variants.forEach((variant, index) => {
    bundle.tasks.tasks.push({
      label: variant.taskLabel,
      type: 'shell',
      command: variant.compiler,
      args: [
        '-fdiagnostics-color=always',
        '-g',
        // 显式指定语言标准，避免 IntelliSense（settings.json 里的 cppStandard/cStandard）
        // 与实际编译参数脱节。GCC 默认是 gnu++17，想保留 GNU 扩展可改成 gnu++17。
        ...(variant.stdFlag ? [variant.stdFlag] : []),
        '${file}',
        '-o',
        outputPath,
      ],
      options: { cwd: '${fileDirname}' },
      problemMatcher: ['$gcc'],
      // 只有一条作为默认构建任务，避免多条同时抢占 Ctrl+Shift+B。
      group: { kind: 'build', isDefault: index === defaultIndex },
      detail: variant.detail,
    });

    bundle.launch.configurations.push({
      name: variant.launchName,
      type: 'cppdbg',
      request: 'launch',
      program: outputPath,
      args: [],
      stopAtEntry: false,
      cwd: '${fileDirname}',
      environment: [],
      // cppdbg 不支持 console 属性（写上会报 "Property console is not allowed"），
      // 只能靠 externalConsole 让 cin/scanf 拿到输入——false 时程序跑在 Debug Console 里，
      // 那里不接受 stdin，读输入会直接报错。
      externalConsole: true,
      MIMode: isMacOS ? 'lldb' : 'gdb',
      ...(debuggerPath ? { miDebuggerPath: debuggerPath } : {}),
      setupCommands: [
        {
          description: 'Enable pretty-printing for gdb',
          text: '-enable-pretty-printing',
          ignoreFailures: true,
        },
      ],
      preLaunchTask: variant.taskLabel,
    });
  });
}

function addPython(bundle: ConfigBundle, toolchain: ToolchainInfo | undefined): void {
  const pythonPath = toolchain?.path ?? 'python3';

  bundle.settings['python.defaultInterpreterPath'] = pythonPath;
  bundle.settings['python.analysis.typeCheckingMode'] = 'basic';

  bundle.tasks.tasks.push({
    label: 'Python: run active file',
    type: 'shell',
    command: pythonPath,
    args: ['${file}'],
    options: { cwd: '${workspaceFolder}' },
    problemMatcher: [],
    group: { kind: 'build', isDefault: true },
    detail: `使用 ${toolchain?.compilerType ?? 'python3'} 运行当前文件`,
  });

  bundle.launch.configurations.push({
    name: 'Python: debug active file',
    type: 'debugpy',
    request: 'launch',
    program: '${file}',
    python: pythonPath,
    console: 'integratedTerminal',
    cwd: '${workspaceFolder}',
    justMyCode: true,
  });
}

/** 从 "javac 17.0.9" / "openjdk version \"1.8.0_382\"" 中解析主版本号。 */
function parseJavaMajor(version: string | undefined): number | undefined {
  const numbers = version?.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return undefined;
  }

  const first = Number(numbers[0]);
  // 1.8.0_382 之类的旧式版本号，主版本是第二段。
  if (first === 1 && numbers.length > 1) {
    return Number(numbers[1]);
  }

  return first;
}

function javaReleaseName(major: number): string {
  return major <= 8 ? 'JavaSE-1.8' : `JavaSE-${major}`;
}

/** 由 <home>/bin/java 反推 JDK 根目录。 */
function javaHomeFromExecutable(execPath: string): string | undefined {
  const binDir = path.dirname(execPath);
  if (path.basename(binDir).toLowerCase() !== 'bin') {
    return undefined;
  }
  return path.dirname(binDir);
}

async function addJava(bundle: ConfigBundle, toolchain: ToolchainInfo | undefined): Promise<void> {
  // JAVA_HOME 直接给出根目录；由 PATH 上的 java 反推时，只有当它位于 <home>/bin 下才成立。
  const javaHome = toolchain?.sdkRoot ?? (toolchain ? javaHomeFromExecutable(toolchain.path) : undefined);
  const major = parseJavaMajor(toolchain?.version);

  if (javaHome && major !== undefined) {
    bundle.settings['java.configuration.runtimes'] = [
      { name: javaReleaseName(major), path: javaHome, default: true },
    ];
  }
  bundle.settings['java.debug.settings.hotCodeReplace'] = 'auto';

  // 探测到的 java 不保证同目录下有 javac（JRE 就没有），所以优先取已验证存在的 javac。
  const javacPath =
    (await findExecutable('javac')) ??
    (javaHome ? path.join(javaHome, 'bin', isWindows ? 'javac.exe' : 'javac') : 'javac');

  bundle.tasks.tasks.push({
    label: 'Java: compile active file',
    type: 'shell',
    command: javacPath,
    args: ['-g', '-d', '${workspaceFolder}', '${file}'],
    options: { cwd: '${workspaceFolder}' },
    problemMatcher: ['$javac'],
    group: { kind: 'build', isDefault: true },
    detail: '编译当前 Java 文件，class 文件输出到工作区根目录',
  });

  bundle.launch.configurations.push({
    name: 'Java: debug active file',
    type: 'java',
    request: 'launch',
    mainClass: '${file}',
    cwd: '${workspaceFolder}',
  });
}

function addGo(bundle: ConfigBundle, toolchain: ToolchainInfo | undefined): void {
  bundle.settings['go.useLanguageServer'] = true;
  bundle.settings['go.toolsManagement.autoUpdate'] = true;

  if (toolchain?.sdkRoot) {
    bundle.settings['go.goroot'] = toolchain.sdkRoot;
  }

  bundle.tasks.tasks.push({
    label: 'Go: build workspace',
    type: 'shell',
    command: toolchain?.path ?? 'go',
    args: ['build', './...'],
    options: { cwd: '${workspaceFolder}' },
    problemMatcher: ['$go'],
    group: { kind: 'build', isDefault: true },
    detail: '构建工作区中的所有 Go 包',
  });

  bundle.launch.configurations.push({
    name: 'Go: debug active package',
    type: 'go',
    request: 'launch',
    mode: 'auto',
    program: '${fileDirname}',
    cwd: '${workspaceFolder}',
  });
}

async function addNode(bundle: ConfigBundle, toolchain: ToolchainInfo | undefined): Promise<void> {
  const nodePath = toolchain?.path ?? 'node';

  bundle.settings['typescript.updateImportsOnFileMove.enabled'] = 'always';
  bundle.settings['javascript.updateImportsOnFileMove.enabled'] = 'always';

  bundle.tasks.tasks.push({
    label: 'Node: run active file',
    type: 'shell',
    command: nodePath,
    args: ['${file}'],
    options: { cwd: '${workspaceFolder}' },
    problemMatcher: [],
    group: { kind: 'build', isDefault: true },
    detail: `使用 ${toolchain?.compilerType ?? 'node'} 运行当前文件`,
  });

  bundle.launch.configurations.push({
    name: 'Node: debug active file',
    type: 'node',
    request: 'launch',
    program: '${file}',
    runtimeExecutable: nodePath,
    cwd: '${workspaceFolder}',
    console: 'integratedTerminal',
    skipFiles: ['<node_internals>/**'],
  });

  // 只有装好 tsc 才生成 TS 调试配置，否则 out/ 不会存在，配置一跑就报错。
  const tscPath = await findExecutable('tsc');
  if (tscPath) {
    bundle.tasks.tasks.push({
      label: 'TypeScript: compile workspace',
      type: 'shell',
      command: tscPath,
      args: ['-p', '.'],
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: ['$tsc'],
      group: 'build',
      detail: '按工作区 tsconfig.json 编译',
    });

    bundle.launch.configurations.push({
      name: 'TypeScript: debug active file',
      type: 'node',
      request: 'launch',
      program: '${workspaceFolder}/out/${fileBasenameNoExtension}.js',
      preLaunchTask: 'TypeScript: compile workspace',
      cwd: '${workspaceFolder}',
      outFiles: ['${workspaceFolder}/out/**/*.js'],
      console: 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
    });
  }
}

/** 汇总单门语言的配置片段。 */
async function buildBundle(
  workspaceRoot: vscode.Uri,
  language: LanguageId,
  toolchain: ToolchainInfo | undefined
): Promise<ConfigBundle> {
  const bundle = emptyBundle();

  switch (language) {
    case 'cpp':
      await addCpp(bundle, toolchain, workspaceRoot);
      break;
    case 'python':
      addPython(bundle, toolchain);
      break;
    case 'java':
      await addJava(bundle, toolchain);
      break;
    case 'go':
      addGo(bundle, toolchain);
      break;
    case 'node':
      await addNode(bundle, toolchain);
      break;
  }

  return bundle;
}

/** 把多门语言的片段合成一个 bundle，最终每个文件只写一次。 */
async function buildCombinedBundle(
  workspaceRoot: vscode.Uri,
  languages: readonly LanguageDefinition[],
  toolchains: ReadonlyMap<LanguageId, ToolchainInfo | undefined>
): Promise<ConfigBundle> {
  const combined = emptyBundle();

  for (const language of languages) {
    const bundle = await buildBundle(workspaceRoot, language.id, toolchains.get(language.id));
    combined.settings = mergeInto(combined.settings, bundle.settings) as Record<string, unknown>;
    combined.launch.configurations.push(...bundle.launch.configurations);
    combined.tasks.tasks.push(...bundle.tasks.tasks);
  }

  return combined;
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/** 返回 <workspaceRoot>/.vscode 的 Uri，目录不存在时创建。 */
export async function ensureVSCodeDir(workspaceRoot: vscode.Uri): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
  // createDirectory 幂等：目录已存在时不会报错。
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

type ReadResult =
  | { kind: 'missing' }
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'malformed'; error: string };

/**
 * 读取并解析配置文件。相比 readJsonFile，这里额外区分「文件不存在」和
 * 「存在但解析失败」——后者绝不能被当成空对象合并写回，否则用户手写的
 * 文件（带注释、语法有误）会被生成内容直接覆盖。
 */
async function readJsonFileDetailed(uri: vscode.Uri): Promise<ReadResult> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return { kind: 'missing' };
    }
    throw error;
  }

  const rawText = new TextDecoder('utf-8').decode(bytes);
  if (rawText.trim().length === 0) {
    return { kind: 'object', value: {} };
  }

  try {
    const parsed = parseJsonc(rawText);
    if (!isPlainObject(parsed)) {
      return { kind: 'malformed', error: '文件顶层不是 JSON 对象' };
    }
    return { kind: 'object', value: parsed };
  } catch (error) {
    return { kind: 'malformed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** 读取并解析 JSON；文件不存在或解析失败时返回空对象。 */
export async function readJsonFile(uri: vscode.Uri): Promise<any> {
  const result = await readJsonFileDetailed(uri);
  return result.kind === 'object' ? result.value : {};
}

async function writeOneConfig(
  uri: vscode.Uri,
  fileName: string,
  generated: unknown,
  channel?: vscode.OutputChannel
): Promise<ConfigFileResult> {
  const existing = await readJsonFileDetailed(uri);

  // 解析失败时绝不写回：宁可不动，也不能毁掉用户带注释 / 有语法错误的配置文件。
  if (existing.kind === 'malformed') {
    const detail = `现有文件无法解析（${existing.error}），未做修改`;
    channel?.appendLine(`  [跳过] ${fileName}：${detail}`);
    return { fileName, status: 'skipped', detail };
  }

  const before = existing.kind === 'object' ? existing.value : {};
  const merged = deepMerge(before, generated);

  if (existing.kind === 'object' && deepEqual(before, merged)) {
    channel?.appendLine(`  [无变化] ${fileName}`);
    return { fileName, status: 'unchanged' };
  }

  const text = `${JSON.stringify(merged, null, 4)}\n`;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));

  const status = existing.kind === 'object' ? 'updated' : 'created';
  channel?.appendLine(`  [${status === 'created' ? '新建' : '合并'}] ${fileName}`);
  return { fileName, status };
}

async function writeBundle(
  vscodeDir: vscode.Uri,
  bundle: ConfigBundle,
  channel?: vscode.OutputChannel
): Promise<ConfigFileResult[]> {
  const results: ConfigFileResult[] = [];

  for (const { fileName, key } of CONFIG_FILES) {
    const uri = vscode.Uri.joinPath(vscodeDir, fileName);
    results.push(await writeOneConfig(uri, fileName, bundle[key], channel));
  }

  return results;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 为单门语言生成或合并 .vscode 下的三个配置文件。
 * 每个文件都会先读取现有内容再做深度合并，用户已有配置优先。
 */
export async function generateConfigs(
  workspaceRoot: vscode.Uri,
  language: LanguageId,
  toolchain: ToolchainInfo | undefined
): Promise<void> {
  const vscodeDir = await ensureVSCodeDir(workspaceRoot);
  await writeBundle(vscodeDir, await buildBundle(workspaceRoot, language, toolchain));
}

/**
 * 多语言入口：把所有选中语言的片段合成后，每个文件只读一次、写一次。
 * 返回每个文件的处理结果，供调用方汇总提示。
 */
export async function configureWorkspaceFolder(
  folder: vscode.WorkspaceFolder,
  languages: readonly LanguageDefinition[],
  toolchains: ReadonlyMap<LanguageId, ToolchainInfo | undefined>,
  channel: vscode.OutputChannel
): Promise<ConfigFileResult[]> {
  const vscodeDir = await ensureVSCodeDir(folder.uri);
  const bundle = await buildCombinedBundle(folder.uri, languages, toolchains);
  return writeBundle(vscodeDir, bundle, channel);
}
