import * as vscode from "vscode";
import { fail } from "../utils";

(Symbol as any).dispose ??= Symbol("dispose");

// Progress Cancel Error
export class ProgressCancelError extends Error {
  constructor() {
    super("Progress canceled");
  }
}

export class Progress implements Disposable {
  private _progressNumber: number = 0;
  private _progress!: vscode.Progress<{ message?: string; increment?: number }>;
  private _token!: vscode.CancellationToken;
  private _resolve!: () => void;
  private _state: "constructed" | "initializing" | "running" | "resolved" = "constructed";
  public nextReportCallback: (() => void) | undefined;

  constructor(
    readonly title: string,
    readonly cancellable: boolean = true
  ) {}

  async init() {
    if (this._state !== "constructed") {
      throw new Error("Progress.init() called more than once.");
    }

    this._state = "initializing";

    return new Promise<void>(initResolve => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: this.title,
          cancellable: this.cancellable
        },
        (progress, token) => {
          this._progress = progress;
          this._token = token;
          return new Promise<void>(resolve => {
            this._resolve = resolve;
            this._state = "running";
            token.onCancellationRequested(() => {
              this.nextReportCallback?.();
              this.nextReportCallback = undefined;
            });
            initResolve();
          });
        }
      );
    });
  }


  set(percent?: number, message?: string, nextReportCallback?: () => void) {
    if (this.state === "running") {
      this.assertContinue();
      this.nextReportCallback?.();
      percent = percent ?? this._progressNumber;
      this._progress.report({ increment: percent - this._progressNumber, message });
      this._progressNumber = percent;
      this.nextReportCallback = nextReportCallback;
    }
  }

  resolve() {
    if (this._state === "running") {
      this.nextReportCallback?.();
      this.nextReportCallback = undefined;
      this._resolve();
      this._state = "resolved";
    }
  }

  assertContinue() {
    if (this.isCanceled || this._state !== "running") {
      fail(vscode.l10n.t("Operation cancelled by user"));
      throw new ProgressCancelError();
    }
  }

  get state() {
    return this._state;
  }

  get isCanceled(): boolean {
    return this._token.isCancellationRequested;
  }

  [Symbol.dispose]() {
    this.resolve();
  }
}
