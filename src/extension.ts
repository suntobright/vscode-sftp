'use strict';

import { isNil } from 'lodash';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

import * as consts from './constants';
import { SftpManager } from './SftpManager';
import { SftpProvider } from './SftpProvider';

export function activate(context: vscode.ExtensionContext): void {

    const sftpManager: SftpManager = new SftpManager(context.globalState);

    let command: vscode.Disposable;

    command = vscode.commands.registerCommand('sftp.openFolder', async () => {
        try {
            const uri: vscode.Uri | undefined = await sftpManager.promptUserInputUri({ canBeFolder: true });
            if (!isNil(uri)) {
                await vscode.commands.executeCommand('vscode.openFolder', uri);
            }
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    });
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.addFolder', async () => {
        try {
            const uri: vscode.Uri | undefined = await sftpManager.promptUserInputUri({ canBeFolder: true });
            if (!isNil(uri)) {
                vscode.workspace.updateWorkspaceFolders(0, 0, { uri });
            }
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    });
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.openFile', async () => {
        try {
            const uri: vscode.Uri | undefined = await sftpManager.promptUserInputUri({ canBeFile: true });
            if (!isNil(uri)) {
                await vscode.commands.executeCommand('vscode.open', uri);
            }
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    });
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.removeConfig', async () => {
        try {
            await sftpManager.promptUserRemoveConfig();
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    });
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.help', async () => {
        try {
            await sftpManager.showHelpDocument(context);
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    });
    context.subscriptions.push(command);

    const sftpProvider: SftpProvider = new SftpProvider(sftpManager);
    context.subscriptions.push(sftpProvider);

    const registeredSftpProvider: vscode.Disposable = vscode.workspace.registerFileSystemProvider(
        consts.scheme,
        sftpProvider,
        { isCaseSensitive: true }
    );
    context.subscriptions.push(registeredSftpProvider);
}
