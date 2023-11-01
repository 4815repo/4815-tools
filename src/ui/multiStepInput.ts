import * as vscode from "vscode";

class InputFlowAction {
  static back = new InputFlowAction();
  static cancel = new InputFlowAction();
  static resume = new InputFlowAction();
}

export type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

export interface QuickPickParameters<T extends vscode.QuickPickItem> extends Partial<vscode.QuickPick<T>> {
  title: string;
  step: number;
  totalSteps: number;
  items: T[];
  activeItem?: T;
  buttons?: readonly vscode.QuickInputButton[];
  shouldResume: () => Thenable<boolean>;
}

export interface InputBoxParameters extends Partial<vscode.InputBox> {
  title: string;
  step: number;
  totalSteps: number;
  value: string;
  validate: (value: string, inputBox: vscode.InputBox) => Promise<string | undefined>;
  buttons?: readonly vscode.QuickInputButton[];
  shouldResume: () => Thenable<boolean>;
}

export class MultiStepInput {
  static async run(start: InputStep) {
    const input = new MultiStepInput();
    return input.stepThrough(start);
  }

  private current?: vscode.QuickInput;
  private steps: InputStep[] = [];

  private async stepThrough(start: InputStep) {
    let step: InputStep | void = start;
    while (step) {
      this.steps.push(step);
      if (this.current) {
        this.current.enabled = false;
        this.current.busy = true;
      }
      try {
        step = await step(this);
      } catch (err) {
        if (err === InputFlowAction.back) {
          this.steps.pop();
          step = this.steps.pop();
        } else if (err === InputFlowAction.resume) {
          step = this.steps.pop();
        } else if (err === InputFlowAction.cancel) {
          step = undefined;
        } else {
          this.current?.dispose();

          throw err;
        }
      }
    }
    this.current?.dispose();
  }

  dispose() {
    this.current?.dispose();
  }

  async showQuickPick<T extends vscode.QuickPickItem, P extends QuickPickParameters<T>>({
    activeItem,
    buttons,
    shouldResume,
    ...rest
  }: P) {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<readonly T[] | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
        const input = vscode.window.createQuickPick<T>();

        Object.assign(input, rest);
        if (activeItem) input.activeItems = [activeItem];
        input.buttons = [...(this.steps.length > 1 ? [vscode.QuickInputButtons.Back] : []), ...(buttons || [])];

        disposables.push(
          input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>item);
            }
          }),
          input.onDidHide(() => {
            (async () => {
              reject(shouldResume && (await shouldResume()) ? InputFlowAction.resume : InputFlowAction.cancel);
            })().catch(reject);
          })
        );

        if (rest.canSelectMany) {
          disposables.push(input.onDidAccept(() => resolve(input.selectedItems)));
        } else {
          disposables.push(input.onDidChangeSelection(items => resolve(items)));
        }

        if (this.current) this.current.dispose();
        this.current = input;
        this.current.show();

        if (rest.canSelectMany) {
          // Use selectedItems if available to preselect items
          input.selectedItems = rest.selectedItems ?? input.selectedItems;
        }
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  async showInputBox<P extends InputBoxParameters>({ validate, buttons, shouldResume, ...rest }: P) {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
        const input = vscode.window.createInputBox();

        Object.assign(input, rest);
        input.buttons = [...(this.steps.length > 1 ? [vscode.QuickInputButtons.Back] : []), ...(buttons || [])];

        let validating = validate("", input);
        disposables.push(
          input.onDidTriggerButton(item => {
            if (item === vscode.QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>item);
            }
          }),
          input.onDidAccept(async () => {
            const value = input.value;
            input.enabled = false;
            input.busy = true;
            if (!(await validate(value, input))) {
              resolve(value);
            }
            input.enabled = true;
            input.busy = false;
          }),
          input.onDidChangeValue(async text => {
            const current = validate(text, input);
            validating = current;
            const validationMessage = await current;
            if (current === validating) {
              input.validationMessage = validationMessage;
            }
          }),
          input.onDidHide(() => {
            (async () => {
              reject(shouldResume && (await shouldResume()) ? InputFlowAction.resume : InputFlowAction.cancel);
            })().catch(reject);
          })
        );
        if (this.current) this.current.dispose();
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }
}

