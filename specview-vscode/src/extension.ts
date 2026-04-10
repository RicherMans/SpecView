import * as vscode from 'vscode';
import { SpecViewEditorProvider } from './SpecViewEditorProvider';

const AUDIO_EXT = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus'];

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
          'Audio & Archives': ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma', 'aiff', 'opus', 'tar', 'tar.gz', 'tgz'],
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
        // Ensure the right-clicked URI is included (it may not be in the selection)
        if (selectedUri && !allUris.some(u => u.fsPath === selectedUri.fsPath)) {
          files = [selectedUri, ...allUris];
        }
      } else if (selectedUri) {
        files = [selectedUri];
      } else {
        return;
      }

      await SpecViewEditorProvider.openPanel(context, files);
    })
  );

  // Explorer right-click on folder → scan top-level for audio files
  context.subscriptions.push(
    vscode.commands.registerCommand('specview.openFolder', async (...args: unknown[]) => {
      const folderUri = args[0] as vscode.Uri | undefined;
      if (!folderUri) return;

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(folderUri);
      } catch (e) {
        vscode.window.showErrorMessage('Cannot read folder: ' + (e as Error).message);
        return;
      }

      const audioUris = entries
        .filter(([name, type]) => type === vscode.FileType.File)
        .filter(([name]) => {
          const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
          return AUDIO_EXT.includes(ext);
        })
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
        .map(([name]) => vscode.Uri.joinPath(folderUri, name));

      if (audioUris.length === 0) {
        vscode.window.showInformationMessage('No audio files found in folder');
        return;
      }

      await SpecViewEditorProvider.openPanel(context, audioUris);
    })
  );
}

export function deactivate() {}
