'use strict';

import * as Ajv from 'ajv';
import * as fs from 'fs-extra';
import { isEmpty, isNil } from 'lodash';
import * as os from 'os';
import * as pEvent from 'p-event';
import * as path from 'path';
import * as ssh from 'ssh2';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import * as consts from './constants';
import { Config, ConfigMap, Conn } from './interfaces';
import * as util from './sftpUtil';

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const ajv: Ajv.Ajv = new Ajv();
// tslint:disable-next-line:no-var-requires no-require-imports
const validator: Ajv.ValidateFunction = ajv.compile(require('../schemas/sftpConfig.schema.json'));

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
                            os.platform() === 'win32'
                                ? textEditor.document.fileName.toLowerCase() === tempFile.toLowerCase()
                                : textEditor.document.fileName === tempFile
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

    private async _getSubFolders(conn: Conn, curFolder: string): Promise<{ name: string; type: vscode.FileType }[]> {
        const channel: ssh.ClientChannel = await util.promisify<ssh.ClientChannel>(
            conn.client,
            conn.client.exec.bind(conn.client),
            `set -euo pipefail
            ls -AH1 ${curFolder} |
            while read file
            do
                if [ -d ${curFolder}/$file ]
                then
                    if [ -L ${curFolder}/$file ]
                    then
                        echo $file symbolicLink
                    else
                        echo $file
                    fi
                fi
            done`
        );
        const output: string = await util.retrieveOutput(channel);
        if (isEmpty(output)) {
            return [];
        }

        const subFolders: { name: string; type: vscode.FileType }[] = [];
        for (const line of output.split('\n')) {
            const tokens: string[] = line.split(' ');
            subFolders.push({
                name: tokens[0],
                type: vscode.FileType.Directory | (tokens.length === 1 ? 0 : vscode.FileType.SymbolicLink)
            });
        }

        return subFolders;
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

    private async _promptUserSelectFolder(conn: Conn): Promise<string | undefined> {
        let curFolder: string = await util.promisify<string>(conn.client, conn.sftp.realpath.bind(conn.sftp), '.');

        while (true) {
            const subFolders: { name: string; type: vscode.FileType }[] = await this._getSubFolders(conn, curFolder);
            const pickItem: { folder: string } | undefined = await vscode.window.showQuickPick(
                [
                    {
                        folder: '.',
                        label: '.',
                        description: localize('option.confirmCurrentFolder', "Confirm Current Folder")
                    },
                    { folder: '..', label: '..' },
                    {
                        folder: '',
                        label: '$(file-directory-create)',
                        description: localize('option.createNewFolder', "Create New Folder")
                    },
                    ...subFolders.map((folder: { name: string; type: vscode.FileType }) => ({
                        folder: folder.name,
                        label: `${
                            (folder.type & vscode.FileType.SymbolicLink) !== 0
                                ? '$(file-symlink-directory)'
                                : '$(file-directory)'
                            } ${folder.name}`
                    }))
                ],
                { placeHolder:  curFolder }
            );

            if (isNil(pickItem)) {
                return undefined;
            } else {
                switch (pickItem.folder) {
                    case '.':
                        return curFolder;
                    case '..':
                        curFolder = path.posix.dirname(curFolder);
                        break;
                    case '':
                        await this._promptUserCreateFolder(conn, curFolder);
                        break;
                    default:
                        curFolder = path.posix.join(curFolder, pickItem.folder);
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

    public async promptUserInputUri(): Promise<vscode.Uri | undefined> {
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
            const folderPath: string | undefined = await this._promptUserSelectFolder(conn);
            if (isNil(folderPath)) {
                return undefined;
            }

            return vscode.Uri.parse(`${consts.scheme}://${authority}${folderPath}`);
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
