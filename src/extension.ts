'use strict';

import { isNil } from 'lodash';
import * as vscode from 'vscode';

const nlsConfig: { _languagePackSupport: boolean } = JSON.parse(
    isNil(process.env.VSCODE_NLS_CONFIG) ? '{}' : process.env.VSCODE_NLS_CONFIG
);
nlsConfig._languagePackSupport = false;
process.env.VSCODE_NLS_CONFIG = JSON.stringify(nlsConfig);

import * as nls from 'vscode-nls';

nls.config(JSON.parse(isNil(process.env.VSCODE_NLS_CONFIG) ? '{}' : process.env.VSCODE_NLS_CONFIG))();

import { Commands } from './Commands';
import { ConfigMap } from './ConfigMap';
import { ConnPool } from './ConnPool';
import * as consts from './constants';
import { FsProvider } from './FsProvider';

export function activate(context: vscode.ExtensionContext): void {

    const configMap: ConfigMap = new ConfigMap(context.globalState);

    const connPool: ConnPool = new ConnPool(configMap);
    context.subscriptions.push(connPool);

    const fsProvider: FsProvider = new FsProvider(connPool);
    const registeredFsProvider: vscode.Disposable = vscode.workspace.registerFileSystemProvider(
        consts.scheme,
        fsProvider,
        { isCaseSensitive: true }
    );
    context.subscriptions.push(registeredFsProvider);

    const commands: Commands = new Commands(configMap, connPool);
    let command: vscode.Disposable;

    command = vscode.commands.registerCommand(
        'sftp.openFolder',
        async (uri: vscode.Uri | undefined) => commands.openFolder(uri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.addFolder',
        async (uri: vscode.Uri | undefined) => commands.addFolder(uri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.openFile',
        async (uri: vscode.Uri | undefined) => commands.openFile(uri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.download',
        async (srcUri: vscode.Uri | undefined) => commands.download(srcUri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.upload',
        async (dstFolderUri: vscode.Uri | undefined) => commands.upload(vscode.FileType.Unknown, dstFolderUri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.uploadFolder',
        async (dstFolderUri: vscode.Uri | undefined) => commands.upload(vscode.FileType.Directory, dstFolderUri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand(
        'sftp.uploadFile',
        async (dstFolderUri: vscode.Uri | undefined) => commands.upload(vscode.FileType.File, dstFolderUri)
    );
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.removeConfig', async () => commands.removeConfig());
    context.subscriptions.push(command);

    command = vscode.commands.registerCommand('sftp.help', async () => commands.showHelpDocument(context));
    context.subscriptions.push(command);
}
