import { ExecException, ExecOptions, exec } from "child_process";
import { sep } from "path";
import * as vscode from "vscode";

// Some functions adapted from microsoft/vscode/extensions/git/src/util.ts under the MIT license.

export const isMacintosh = process.platform === "darwin";
export const isWindows = process.platform === "win32";

export function makeDir(path: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    vscode.workspace.fs.createDirectory(vscode.Uri.file(path)).then(
      () => resolve(true),
      () => resolve(false)
    );
  });
}

export function stat(path: string): Promise<vscode.FileStat | null> {
  return new Promise<vscode.FileStat | null>(resolve => {
    vscode.workspace.fs.stat(vscode.Uri.file(path)).then(
      stat => resolve(stat),
      () => resolve(null)
    );
  });
}

export async function runCommand(command: string, ...args: any[]): Promise<[boolean, unknown]> {
  return new Promise<[boolean, unknown]>(resolve => {
    vscode.commands.executeCommand(command, ...args).then(
      rtn => resolve([true, rtn]),
      rtn => resolve([false, rtn])
    );
  });
}

// export async function runProcessCommand(
//   command: string,
//   options: ExecOptions
// ): Promise<{ error: ExecException | null; stdout: string; stderr: string }> {
//   return new Promise(resolve => {
//     exec(command, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
//   });
// }

export async function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });
}

export function getDateString(date: Date) {
  return date.toLocaleString("zh-tw", {
    timeZone: "Asia/Hong_Kong",
    timeZoneName: "short",
    hourCycle: "h23"
  });
}

export function timeSince(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  let interval = seconds / 31536000;

  if (interval > 1) {
    return Math.floor(interval) + vscode.l10n.t(" years");
  }
  interval = seconds / 2592000;
  if (interval > 1) {
    return Math.floor(interval) + vscode.l10n.t(" months");
  }
  interval = seconds / 86400;
  if (interval > 1) {
    return Math.floor(interval) + vscode.l10n.t(" days");
  }
  interval = seconds / 3600;
  if (interval > 1) {
    return Math.floor(interval) + vscode.l10n.t(" hours");
  }
  interval = seconds / 60;
  if (interval > 1) {
    return Math.floor(interval) + vscode.l10n.t(" minutes");
  }
  return Math.floor(seconds) + vscode.l10n.t(" seconds");
}

export function getCompetitionSessionYearString(date: Date): string {
  const year = date.getFullYear();
  const months = date.getMonth() + 1; // 0-indexed

  const twoDigitsYearInString = year.toString().slice(-2);
  const twoDigitsYearInNumber = parseInt(twoDigitsYearInString);

  if (months >= 5) return `${twoDigitsYearInNumber}${twoDigitsYearInNumber + 1}`;
  else return `${twoDigitsYearInNumber - 1}${twoDigitsYearInNumber}`;
}

export function getTemplateNamePrefix(templateName: string) {
  // for example "v5-4815lib" -> "v5"
  return templateName.split("-")[0];
}

// export function getProjectSlugFromName(projectName: string) {
//   // remove all non-alphanumeric characters, and replace spaces with dashes, use lowercase
//   return projectName
//     .replace(/[^a-zA-Z0-9 ]/g, "")
//     .replace(/ /g, "-")
//     .toLowerCase();
// }

export function getProjectSlugFromName(projectName: string) {
  // See: https://confluence.atlassian.com/bbkb/what-is-a-repository-slug-1168845069.html
  /*
  Rules:
  1. Only allows ASCII alphanumeric characters, en dashes (-),replaces any consecutive characters in a repository name 
  that are not allowed in a repository slug with only one en dash 
  2. Replaces any consecutive en dashes with only one en dash
  3. Can not start or end with an en dash
  4. Limited to 62 characters.
  */
  return projectName
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/([a-z])([A-Z])/g, "$1-$2") // from camelCase to kebab-case
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toLowerCase()
    .slice(0, 62);
}

function normalizePath(path: string): string {
  // Windows & Mac are currently being handled
  // as case insensitive file systems in VS Code.
  if (isWindows || isMacintosh) {
    return path.toLowerCase();
  }

  return path;
}

export function isDescendant(parent: string, descendant: string): boolean {
  if (parent === descendant) {
    return true;
  }

  if (parent.charAt(parent.length - 1) !== sep) {
    parent += sep;
  }

  return normalizePath(descendant).startsWith(normalizePath(parent));
}

export function pathEquals(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

export function success(message: string): true {
  vscode.window.showInformationMessage(message);
  return true;
}

export function fail(message: string): false {
  vscode.window.showErrorMessage(message);
  return false;
}
