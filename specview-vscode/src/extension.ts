import * as vscode from 'vscode';
import { SpecViewEditorProvider } from './SpecViewEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new SpecViewEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      SpecViewEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Command palette: pick files via dialog → open in one panel
  context.subscriptions.push(
    vscode.commands.registerCommand('specview.openFile', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        defaultUri: SpecViewEditorProvider.getLastOpenDir(),
        filters: {
          Audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus'],
        },
      });
      if (files && files.length > 0) {
        await SpecViewEditorProvider.openPanel(context, files);
      }
    })
  );

  // Explorer right-click: selected files → open in one panel
  context.subscriptions.push(
    vscode.commands.registerCommand('specview.openMultiple', async (...args: unknown[]) => {
      // args[0] is the clicked URI, args[1] is the array of all selected URIs
      const selectedUri = args[0] as vscode.Uri | undefined;
      const allUris = args[1] as vscode.Uri[] | undefined;

      let files: vscode.Uri[];
      if (allUris && allUris.length > 0) {
        files = allUris;
      } else if (selectedUri) {
        files = [selectedUri];
      } else {
        return;
      }

      await SpecViewEditorProvider.openPanel(context, files);
    })
  );
}

export function deactivate() {}
