import * as vscode from 'vscode';

/** 本扩展支持的编程语言标识。 */
export type LanguageId = 'cpp' | 'python' | 'java' | 'go' | 'node';

export interface LanguageDefinition {
  readonly id: LanguageId;
  readonly label: string;
  /** QuickPick 中展示的说明，告诉用户这门语言需要哪些工具链。 */
  readonly description: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  { id: 'cpp', label: 'C/C++', description: '需要 g++ 或 clang++（可选 gdb / lldb 用于调试）' },
  { id: 'python', label: 'Python', description: '需要 python3 或 python' },
  { id: 'java', label: 'Java', description: '需要 JDK（javac 与 java）' },
  { id: 'go', label: 'Go', description: '需要 go 工具链' },
  { id: 'node', label: 'Node.js / TypeScript', description: '需要 node（可选 tsc、npm）' },
];

/**
 * 弹出单选列表让用户挑选要配置的语言，返回选中的 LanguageId。
 * 用户取消（按 Esc 或点击外部）时返回 undefined。
 */
export async function selectLanguage(): Promise<LanguageId | undefined> {
  const items = SUPPORTED_LANGUAGES.map((language) => ({
    label: language.label,
    description: language.description,
    value: language.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: '配置工作区',
    placeHolder: '选择要配置的编程语言',
    ignoreFocusOut: true,
  });

  return picked?.value;
}

/**
 * 弹出多选列表让用户挑选要配置的语言。
 * 用户取消（按 Esc 或点击外部）或一个都没选时返回 undefined。
 */
export async function selectLanguages(): Promise<LanguageDefinition[] | undefined> {
  const items = SUPPORTED_LANGUAGES.map((language) => ({
    label: language.label,
    description: language.description,
    value: language,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: '配置工作区',
    placeHolder: '选择要配置的编程语言（可多选）',
    ignoreFocusOut: true,
  });

  if (!picked || picked.length === 0) {
    return undefined;
  }

  return picked.map((item) => item.value);
}
