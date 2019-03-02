'use strict';

import * as Ajv from 'ajv';
import * as bytes from 'bytes';
import * as fs from 'fs-extra';
import { isEmpty, isNil } from 'lodash';
import * as path from 'path';
import * as ssh from 'ssh2';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import { ConfigMap } from './ConfigMap';
import { ConnPool } from './ConnPool';
import * as consts from './constants';
import { Config, Conn } from './interfaces';
import * as utils from './utils';

interface FileInfo {
    name: string;
    type: vscode.FileType;
    user: string;
    size: number;
    mtime: number;
}

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const ajv: Ajv.Ajv = new Ajv();
// tslint:disable-next-line:no-var-requires no-require-imports
const validator: Ajv.ValidateFunction = ajv.compile(require('../schemas/sftpConfig.schema.json'));

function getFileIcon(type: vscode.FileType): string {
    switch (type) {
        case vscode.FileType.File:
            return '$(file)';
        case vscode.FileType.Directory:
            return '$(file-directory)';
        case vscode.FileType.File | vscode.FileType.SymbolicLink:
            return '$(file-symlink-file)';
        case vscode.FileType.Directory | vscode.FileType.SymbolicLink:
            return '$(file-symlink-directory)';
        default:
            return '$(question)';
    }
}

export class Commands {
    private readonly _configMap: ConfigMap;
    private readonly _connPool: ConnPool;

    private async _promptUserAddConfig(): Promise<string | undefined> {
        const example: Config = {
            comment: localize(
                'desc.config.hintComment',
                "Please fill the following configuration, save it, then close the tab."
            ),
            host: localize('desc.config.host', "hostname_or_IP"),
            port: consts.defaultPort,
            username: localize('desc.config.username', "username"),
            password: localize('desc.config.password', "password")
        };
        const tempFile: string = path.join(consts.localTempFolder, consts.configFileName);
        await fs.ensureFile(tempFile);
        await fs.writeJson(tempFile, example, { spaces: 4 });
        await vscode.window.showTextDocument(vscode.Uri.file(tempFile), { preview: false });

        let authority: string | undefined;
        let isWaitingForChoice: boolean = false;
        await new Promise<void>((resolve: () => void): void => {
            const disposable: vscode.Disposable = vscode.window.onDidChangeVisibleTextEditors(
                async (visibleTextEditors: vscode.TextEditor[]) => {
                    if (visibleTextEditors.some(
                        (textEditor: vscode.TextEditor) =>
                            textEditor.document.uri.fsPath === vscode.Uri.file(tempFile).fsPath
                    )) {
                        return;
                    }

                    if (isWaitingForChoice) {
                        return;
                    }
                    isWaitingForChoice = true;
                    const choice: string | undefined = await vscode.window.showInformationMessage(
                        localize('info.config.addingConfirmation', "Are you sure to add this configuration?"),
                        localize('action.confirm', "Confirm"),
                        localize('action.cancel', "Cancel")
                    );
                    isWaitingForChoice = false;
                    if (choice === localize('action.confirm', "Confirm")) {
                        let config: Config;
                        try {
                            config = await fs.readJson(tempFile);
                        } catch (e) {
                            void vscode.window.showErrorMessage(
                                localize('info.config.parseFailed', "Parsing configuration failed, {0}", e.toString())
                            );
                            await vscode.window.showTextDocument(vscode.Uri.file(tempFile), { preview: false });

                            return;
                        }

                        const valid: boolean = await validator(config);
                        if (!valid) {
                            void vscode.window.showErrorMessage(
                                localize(
                                    'info.config.validateFailed',
                                    "Validating configuration failed, {0}",
                                    ajv.errorsText(validator.errors)
                                )
                            );
                            await vscode.window.showTextDocument(vscode.Uri.file(tempFile), { preview: false });

                            return;
                        }

                        if (!isNil(config.privateKeyFile)) {
                            try {
                                config.privateKey = await fs.readFile(config.privateKeyFile);
                            } catch (e) {
                                void vscode.window.showWarningMessage(
                                    localize(
                                        'info.config.privateKeyFile.readFailed',
                                        "Reading private key file {0} failed, {1}",
                                        config.privateKeyFile,
                                        e
                                    )
                                );
                            }
                        }

                        let conn: Conn;
                        try {
                            conn = await utils.getConn(config);
                        } catch (e) {
                            void vscode.window.showErrorMessage(
                                localize('info.config.connectFailed', "Connecting failed, {0}", e.toString())
                            );
                            await vscode.window.showTextDocument(vscode.Uri.file(tempFile), { preview: false });

                            return;
                        }

                        authority = `${config.username}@${config.host}`;
                        if (!isNil(config.port) && config.port !== consts.defaultPort) {
                            authority += `:${config.port}`;
                        }

                        this._connPool.pushConn(authority, conn);
                        await this._configMap.set(authority, config);
                    }

                    disposable.dispose();
                    resolve();
                }
            );
        });

        return authority;
    }

    private async _getSubFiles(conn: Conn, curFolder: string): Promise<FileInfo[]> {
        const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
            conn.client,
            conn.client.exec.bind(conn.client),
            `set -euo pipefail
            ls -AHLo --time-style=+%s --group-directories-first ${curFolder} |
            while read type refCount user size time file
            do
                if [ $type != total ]
                then
                    if [ -L ${curFolder}/$file ]
                    then
                        echo $type $user $size $time $file symbolicLink
                    else
                        echo $type $user $size $time $file
                    fi
                fi
            done`
        );
        const output: string = await utils.retrieveOutput(channel);
        if (isEmpty(output)) {
            return [];
        }

        const subFiles: FileInfo[] = [];
        for (const line of output.split('\n')) {
            const tokens: string[] = line.split(' ');
            let fileType: vscode.FileType = utils.getFileType(tokens[0]);
            if (fileType !== vscode.FileType.Unknown && tokens[5] === 'symbolicLink') {
                fileType |= vscode.FileType.SymbolicLink;
            }
            subFiles.push({
                name: tokens[4],
                type: fileType,
                user: tokens[1],
                size: parseFloat(tokens[2]),
                mtime: parseFloat(tokens[3])
            });
        }

        return subFiles;
    }

    private async _promptUserCreateFolder(conn: Conn, curFolder: string): Promise<void> {
        const folderName: string | undefined = await vscode.window.showInputBox(
            {
                prompt: localize('prompt.inputFolderName', "Please input the folder name."),
                value: 'NewFolder'
            }
        );

        if (!isNil(folderName)) {
            await utils.promisify(conn.client, conn.sftp.mkdir.bind(conn.sftp), path.posix.join(curFolder, folderName));
        }
    }

    private async _promptUserSelectPath(
        conn: Conn,
        option: { canBeFolder?: boolean; canBeFile?: boolean }
    ): Promise<string | undefined> {
        const extraPickItems: (vscode.QuickPickItem & { name: string; type: vscode.FileType })[] = [];
        if (!isNil(option.canBeFolder) && option.canBeFolder) {
            extraPickItems.push({
                name: '.',
                type: vscode.FileType.Unknown,
                label: '.',
                description: localize('option.confirmCurrentFolder', "Confirm Current Folder")
            });
        }
        extraPickItems.push({ name: '..', type: vscode.FileType.Unknown, label: '..' });
        if (!isNil(option.canBeFolder) && option.canBeFolder) {
            extraPickItems.push({
                name: '',
                type: vscode.FileType.Unknown,
                label: '$(file-directory-create)',
                description: localize('option.createNewFolder', "Create New Folder")
            });
        }

        let curFolder: string = await utils.promisify<string>(conn.client, conn.sftp.realpath.bind(conn.sftp), '.');

        while (true) {
            let subFiles: FileInfo[] = await this._getSubFiles(conn, curFolder);
            subFiles = subFiles.filter((file: FileInfo) => file.type !== vscode.FileType.Unknown);
            if (isNil(option.canBeFile) || !option.canBeFile) {
                subFiles = subFiles.filter(
                    (file: FileInfo) => (file.type & vscode.FileType.Directory) === vscode.FileType.Directory
                );
            }

            const pickItem: { name: string; type: vscode.FileType } | undefined = await vscode.window.showQuickPick(
                [
                    ...extraPickItems,
                    ...subFiles.map((file: FileInfo) => ({
                        name: file.name,
                        type: file.type,
                        label: `${getFileIcon(file.type)} ${file.name}`,
                        description: [
                            '',
                            file.user,
                            (file.type & vscode.FileType.Directory) === vscode.FileType.Directory
                                ? ''
                                : bytes(file.size, { fixedDecimals: true }),
                            new Date(file.mtime * 1000).toLocaleString(),
                            ''
                        ].join('\t')
                    }))
                ],
                { placeHolder:  curFolder }
            );

            if (isNil(pickItem)) {
                return undefined;
            } else {
                switch (pickItem.name) {
                    case '.':
                        return curFolder;
                    case '..':
                        curFolder = path.posix.dirname(curFolder);
                        break;
                    case '':
                        await this._promptUserCreateFolder(conn, curFolder);
                        break;
                    default:
                        if ((pickItem.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
                            curFolder = path.posix.join(curFolder, pickItem.name);
                        } else {
                            return path.posix.join(curFolder, pickItem.name);
                        }
                }
            }
        }
    }

    private async _promptUserInputUri(
        option: { canBeFolder?: boolean; canBeFile?: boolean }
    ): Promise<vscode.Uri | undefined> {
        let authority: string | undefined = await vscode.window.showQuickPick([
            localize('option.addConfig', "Add New SFTP Configuration"),
            ...this._configMap.getAuthorities()
        ]);
        if (authority === localize('option.addConfig', "Add New SFTP Configuration")) {
            authority = await this._promptUserAddConfig();
        }
        if (isNil(authority)) {
            return undefined;
        }

        return this._connPool.withConn<vscode.Uri | undefined>(
            authority,
            async (conn: Conn): Promise<vscode.Uri | undefined> => {
                const path: string | undefined = await this._promptUserSelectPath(conn, option);
                if (isNil(path)) {
                    return undefined;
                }

                return vscode.Uri.parse(`${consts.scheme}://${authority}${path}`);
            },
            undefined
        );
    }

    private async _promptUserRemoveConfig(): Promise<void> {
        const authority: string | undefined = await vscode.window.showQuickPick([
            localize('option.removeAllConfig', "Remove All SFTP Configurations"),
            ...this._configMap.getAuthorities()
        ]);
        if (isNil(authority)) {
            return;
        }

        if (authority === localize('option.removeAllConfig', "Remove All SFTP Configurations")) {
            await this._configMap.clear();
        } else {
            await this._configMap.remove(authority);
        }
    }

    private async _withErrorHandled<T>(callback: () => Promise<T>): Promise<T | undefined> {
        try {
            const value: T = await callback();

            return value;
        } catch (e) {
            void vscode.window.showErrorMessage(e.toString());
        }
    }

    public constructor(configMap: ConfigMap, connPool: ConnPool) {
        this._configMap = configMap;
        this._connPool = connPool;
    }

    public async openFolder(): Promise<void> {
        await this._withErrorHandled(async () => {
            const uri: vscode.Uri | undefined = await this._promptUserInputUri({ canBeFolder: true });
            if (!isNil(uri)) {
                await vscode.commands.executeCommand('vscode.openFolder', uri);
            }
        });
    }

    public async addFolder(): Promise<void> {
        await this._withErrorHandled(async () => {
            const uri: vscode.Uri | undefined = await this._promptUserInputUri({ canBeFolder: true });
            if (!isNil(uri)) {
                vscode.workspace.updateWorkspaceFolders(0, 0, { uri });
            }
        });
    }

    public async openFile(): Promise<void> {
        await this._withErrorHandled(async () => {
            const uri: vscode.Uri | undefined = await this._promptUserInputUri({ canBeFile: true });
            if (!isNil(uri)) {
                await vscode.commands.executeCommand('vscode.open', uri);
            }
        });
    }

    public async removeConfig(): Promise<void> {
        await this._withErrorHandled(async () => this._promptUserRemoveConfig());
    }

    public async showHelpDocument(context: vscode.ExtensionContext): Promise<void> {
        await this._withErrorHandled(async () => {
            const path: string = context.asAbsolutePath(consts.helpDocument);

            await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path));
        });
    }
}