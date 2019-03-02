'use strict';

import * as Ajv from 'ajv';
import * as bytes from 'bytes';
import * as fs from 'fs-extra';
import { isEmpty, isNil } from 'lodash';
import * as pEvent from 'p-event';
import * as path from 'path';
import * as ssh from 'ssh2';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import * as consts from './constants';
import { Config, ConfigMap, Conn } from './interfaces';
import * as util from './sftpUtil';

interface FileInfo {
    name: string;
    type: vscode.FileType;
    user: string;
    size: number;
    readableSize: string;
    mtime: number;
    readableMtime: string;
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

export class SftpManager {
    private readonly _globalState: vscode.Memento;

    private async _promptUserAddConfigAndGetConn(): Promise<{ authority: string | undefined; conn: Conn | undefined }> {
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
        let conn: Conn | undefined;
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

                        const client: ssh.Client = new ssh.Client();
                        try {
                            client.connect(config);
                            await pEvent(client, 'ready');

                            const sftp: ssh.SFTPWrapper = await util.promisify<ssh.SFTPWrapper>(
                                client,
                                client.sftp.bind(client)
                            );

                            conn = { client, sftp };
                        } catch (e) {
                            client.end();
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

                        const configMap: ConfigMap = this.getConfigMap();
                        configMap[authority] = config;
                        await this.setConfigMap(configMap);
                    }

                    disposable.dispose();
                    resolve();
                }
            );
        });

        return { authority, conn };
    }

    private async _getConn(authority: string): Promise<Conn> {
        const configMap: ConfigMap = this.getConfigMap();
        const config: Config | undefined = configMap[authority];
        if (isNil(config)) {
            throw new Error(localize('error.config.notFound', "Configuration not found"));
        }

        const client: ssh.Client = new ssh.Client();
        try {
            client.connect(config);
            await pEvent(client, 'ready');

            const sftp: ssh.SFTPWrapper = await util.promisify<ssh.SFTPWrapper>(client, client.sftp.bind(client));

            return { client, sftp };
        } catch (e) {
            client.end();
            throw new Error(localize('error.config.connectFailed', "Connecting failed, {0}", e.toString()));
        }
    }

    private async _getSubFiles(conn: Conn, curFolder: string): Promise<FileInfo[]> {
        const channel: ssh.ClientChannel = await util.promisify<ssh.ClientChannel>(
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
        const output: string = await util.retrieveOutput(channel);
        if (isEmpty(output)) {
            return [];
        }

        const subFiles: FileInfo[] = [];
        for (const line of output.split('\n')) {
            const tokens: string[] = line.split(' ');
            let fileType: vscode.FileType = util.getFileType(tokens[0]);
            if (fileType !== vscode.FileType.Unknown && tokens[5] === 'symbolicLink') {
                fileType |= vscode.FileType.SymbolicLink;
            }
            subFiles.push({
                name: tokens[4],
                type: fileType,
                user: tokens[1],
                size: parseFloat(tokens[2]),
                readableSize: bytes(parseFloat(tokens[2]), { fixedDecimals: true }),
                mtime: parseFloat(tokens[3]),
                readableMtime: new Date(parseFloat(tokens[3]) * 1000).toLocaleString()
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
            await util.promisify(conn.client, conn.sftp.mkdir.bind(conn.sftp), path.posix.join(curFolder, folderName));
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

        let curFolder: string = await util.promisify<string>(conn.client, conn.sftp.realpath.bind(conn.sftp), '.');

        while (true) {
            let subFiles: FileInfo[] = await this._getSubFiles(conn, curFolder);
            subFiles = subFiles.filter((file: FileInfo) => file.type !== vscode.FileType.Unknown);
            if (isNil(option.canBeFile) || !option.canBeFile) {
                subFiles = subFiles.filter((file: FileInfo) => file.type & vscode.FileType.Directory);
            }

            const pickItem: { name: string; type: vscode.FileType } | undefined = await vscode.window.showQuickPick(
                [
                    ...extraPickItems,
                    ...subFiles.map((file: FileInfo) => ({
                        name: file.name,
                        type: file.type,
                        label: `${getFileIcon(file.type)} ${file.name}`,
                        description: `\t${file.user}\t${file.readableSize}\t${file.readableMtime}\t`
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
                        if ((pickItem.type & vscode.FileType.Directory) !== 0) {
                            curFolder = path.posix.join(curFolder, pickItem.name);
                        } else {
                            return path.posix.join(curFolder, pickItem.name);
                        }
                }
            }
        }
    }

    public constructor(globalState: vscode.Memento) {
        this._globalState = globalState;
    }

    public getConfigMap(): ConfigMap {
        return this._globalState.get<ConfigMap>(consts.configMapKey, {});
    }

    public async setConfigMap(configMap: ConfigMap): Promise<void> {
        await this._globalState.update(consts.configMapKey, configMap);
    }

    public async promptUserInputUri(
        option: { canBeFolder?: boolean; canBeFile?: boolean }
    ): Promise<vscode.Uri | undefined> {
        let authority: string | undefined = await vscode.window.showQuickPick([
            localize('option.addConfig', "Add New SFTP Configuration"),
            ...Object.keys(this.getConfigMap())
        ]);
        let conn: Conn | undefined;
        if (authority === localize('option.addConfig', "Add New SFTP Configuration")) {
            const temp: {
                authority: string | undefined;
                conn: Conn | undefined;
            } = await this._promptUserAddConfigAndGetConn();
            authority = temp.authority;
            conn = temp.conn;
        }
        if (isNil(authority)) {
            return undefined;
        }

        if (isNil(conn)) {
            conn = await this._getConn(authority);
        }

        try {
            const path: string | undefined = await this._promptUserSelectPath(conn, option);
            if (isNil(path)) {
                return undefined;
            }

            return vscode.Uri.parse(`${consts.scheme}://${authority}${path}`);
        } catch (e) {
            throw e;
        } finally {
            conn.client.end();
        }
    }

    public async promptUserRemoveConfig(): Promise<void> {
        const authority: string | undefined = await vscode.window.showQuickPick([
            localize('option.removeAllConfig', "Remove All SFTP Configurations"),
            ...Object.keys(this.getConfigMap())
        ]);
        if (isNil(authority)) {
            return;
        }

        let configMap: ConfigMap = this.getConfigMap();
        if (authority === localize('option.removeAllConfig', "Remove All SFTP Configurations")) {
            configMap = {};
        } else {
            //tslint:disable-next-line:no-dynamic-delete
            delete configMap[authority];
        }
        await this.setConfigMap(configMap);
    }

    public async showHelpDocument(context: vscode.ExtensionContext): Promise<void> {
        const path: string = context.asAbsolutePath(consts.helpDocument);

        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path));
    }
}
