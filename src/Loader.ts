'use strict';

import * as fs from 'fs-extra';
import { isEmpty } from 'lodash';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform, Writable } from 'stream';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import { Conn, ConnPool } from './ConnPool';
import { SpeedSummary } from './SpeedSummary';
import * as utils from './utils';

interface FileInfo {
    name: string;
    type: vscode.FileType;
    target: string;
}

export interface DstInfo {
    uri: vscode.Uri;
    type: vscode.FileType;
}

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export class Loader {

    private readonly _connPool: ConnPool;

    private async _downloadFile(
        conn: Conn,
        srcRootFolderOrSrcFile: string,
        srcSubFileOrEmpty: string,
        dstPath: string,
        speedSummary: SpeedSummary,
        token: vscode.CancellationToken
    ): Promise<void> {
        speedSummary.setCurFile(srcSubFileOrEmpty);

        const transform: Transform = new Transform(speedSummary);
        const srcStream: Readable = conn.sftp.createReadStream(
            path.posix.join(srcRootFolderOrSrcFile, srcSubFileOrEmpty)
        );
        const dstStream: fs.WriteStream = fs.createWriteStream(dstPath);

        const notifyStream: () => void = (): void => {
            srcStream.emit('error', new Error(localize('error.conn.closed', "Connection Closed")));
        };

        conn.client.once('close', notifyStream);
        await utils.transmit(srcStream, transform, dstStream, token);
        conn.client.removeListener('close', notifyStream);
    }

    private async _getDownloadSubFiles(conn: Conn, folder: string): Promise<FileInfo[]> {
        const output: string = await utils.exec(
            conn.client,
            `set -euo pipefail
            output=$(ls -AgHLo --time-style=+%s '${folder}') || true
            echo "$output" |
            while read -r type refCount size mtime file
            do
                if [ $type != total ]
                then
                    if [ -L "${folder}/$file" ]
                    then
                        echo $type '->' $file '->' $(readlink "${folder}/$file")
                    else
                        echo $type '->' $file
                    fi
                fi
            done`
        );
        if (isEmpty(output)) {
            return [];
        }

        const subFiles: FileInfo[] = [];
        for (const line of output.split('\n')) {
            const tokens: string[] = line.split(' -> ');
            let fileType: vscode.FileType = utils.getFileType(tokens[0]);
            if (fileType !== vscode.FileType.Unknown && tokens.length === 3) {
                fileType |= vscode.FileType.SymbolicLink;
            }
            subFiles.push({
                name: tokens[1],
                type: fileType,
                target: tokens[2]
            });
        }

        return subFiles;
    }

    private async _downloadFolder(
        conn: Conn,
        srcRootFolder: string,
        srcSubFolder: string,
        dstPath: string,
        speedSummary: SpeedSummary,
        token: vscode.CancellationToken
    ): Promise<void> {
        await fs.mkdir(dstPath);

        const srcFolder: string = path.posix.join(srcRootFolder, srcSubFolder);
        const subFileInfos: FileInfo[] = await this._getDownloadSubFiles(conn, srcFolder);
        for (const subFileInfo of subFileInfos) {
            if (token.isCancellationRequested) {
                return;
            }

            const srcSubPath: string = path.posix.join(srcSubFolder, subFileInfo.name);
            const dstSubPath: string = path.join(dstPath, subFileInfo.name);
            switch (subFileInfo.type) {
                case vscode.FileType.File:
                    await this._downloadFile(conn, srcRootFolder, srcSubPath, dstSubPath, speedSummary, token);
                    break;
                case vscode.FileType.Directory:
                    await this._downloadFolder(conn, srcRootFolder, srcSubPath, dstSubPath, speedSummary, token);
                    break;
                case vscode.FileType.File | vscode.FileType.SymbolicLink:
                case vscode.FileType.Directory | vscode.FileType.SymbolicLink:
                case vscode.FileType.Unknown | vscode.FileType.SymbolicLink:
                    const targetPath: string = path.posix.isAbsolute(subFileInfo.target)
                        ? path.posix.resolve(srcFolder, subFileInfo.target)
                        : subFileInfo.target;
                    if (os.platform() === 'win32'
                        && subFileInfo.type !== (vscode.FileType.Unknown | vscode.FileType.SymbolicLink)
                    ) {
                        await fs.symlink(
                            path.join(...targetPath.split(path.posix.sep)),
                            dstSubPath,
                            (subFileInfo.type & vscode.FileType.File) === vscode.FileType.File ? 'file' : 'dir'
                        );
                        break;
                    } else if (os.platform() !== 'win32') {
                        await fs.symlink(path.join(...targetPath.split(path.posix.sep)), dstSubPath);
                        break;
                    }
                // tslint:disable-next-line:no-switch-case-fall-through
                default:
                    void vscode.window.showWarningMessage(
                        localize(
                            'info.ignore.unknownFileType',
                            "Ignore {0} for unknown FileType.",
                            path.posix.join(srcRootFolder, srcSubPath)
                        )
                    );
            }
        }
    }

    private async _getUploadFolderSize(folder: string): Promise<number> {
        let size: number = 0;

        const subFiles: string[] = await fs.readdir(folder);
        for (const subFile of subFiles) {
            const subFilePath: string = path.join(folder, subFile);

            const stats: fs.Stats = await fs.lstat(subFilePath);
            if (stats.isFile()) {
                size += stats.size;
            } else if (stats.isDirectory()) {
                size += await this._getUploadFolderSize(subFilePath);
            }
        }

        return size;
    }

    private async _getUploadTypeAndSize(fsPath: string): Promise<{ type: vscode.FileType; size: number }> {
        const stats: fs.Stats = await fs.stat(fsPath);

        let type: vscode.FileType = vscode.FileType.Unknown;
        let size: number = 0;
        if (stats.isFile()) {
            type = vscode.FileType.File;
            size = stats.size;
        } else if (stats.isDirectory()) {
            type = vscode.FileType.Directory;
            size = await this._getUploadFolderSize(fsPath);
        } else {
            type = vscode.FileType.Unknown;
        }

        return { type, size };
    }

    private async _uploadFile(
        conn: Conn,
        srcRootFolderOrSrcFile: string,
        srcSubFileOrEmpty: string,
        dstPath: string,
        speedSummary: SpeedSummary,
        token: vscode.CancellationToken
    ): Promise<void> {
        speedSummary.setCurFile(srcSubFileOrEmpty);

        const transform: Transform = new Transform(speedSummary);
        const srcStream: fs.ReadStream = fs.createReadStream(path.join(srcRootFolderOrSrcFile, srcSubFileOrEmpty));
        const dstStream: Writable = conn.sftp.createWriteStream(dstPath);

        const notifyStream: () => void = (): void => {
            dstStream.emit('error', new Error(localize('error.conn.closed', "Connection Closed")));
        };

        conn.client.once('close', notifyStream);
        await utils.transmit(srcStream, transform, dstStream, token);
        conn.client.removeListener('close', notifyStream);
    }

    private async _uploadFolder(
        conn: Conn,
        srcRootFolder: string,
        srcSubFolder: string,
        dstPath: string,
        speedSummary: SpeedSummary,
        token: vscode.CancellationToken
    ): Promise<void> {
        await utils.promisify(conn.client, conn.sftp.mkdir.bind(conn.sftp), dstPath);

        const srcFolder: string = path.join(srcRootFolder, srcSubFolder);
        const srcSubFiles: string[] = await fs.readdir(srcFolder);
        for (const srcSubFile of srcSubFiles) {
            if (token.isCancellationRequested) {
                return;
            }

            const srcSubPath: string = path.join(srcSubFolder, srcSubFile);
            const dstSubPath: string = path.posix.join(dstPath, srcSubFile);

            const stats: fs.Stats = await fs.lstat(path.join(srcRootFolder, srcSubPath));
            if (stats.isFile()) {
                await this._uploadFile(conn, srcRootFolder, srcSubPath, dstSubPath, speedSummary, token);
            } else if (stats.isDirectory()) {
                await this._uploadFolder(conn, srcRootFolder, srcSubPath, dstSubPath, speedSummary, token);
            } else if (stats.isSymbolicLink()) {
                const target: string = await fs.readlink(path.join(srcRootFolder, srcSubPath));
                const targetPath: string = path.isAbsolute(target) ? path.resolve(srcFolder, target) : target;
                await utils.promisify(
                    conn.client,
                    conn.sftp.symlink.bind(conn.sftp),
                    path.posix.join(...targetPath.split(path.sep)),
                    dstSubPath
                );
            } else {
                void vscode.window.showWarningMessage(
                    localize(
                        'info.ignore.unknownFileType',
                        "Ignore {0} for unknown FileType.",
                        path.join(srcRootFolder, srcSubPath)
                    )
                );
            }
        }
    }

    public constructor(connPool: ConnPool) {
        this._connPool = connPool;
    }

    public async download(srcUri: vscode.Uri, dstFolderUri: vscode.Uri): Promise<DstInfo | undefined> {
        return vscode.window.withProgress<DstInfo | undefined>(
            {
                cancellable: true,
                location: vscode.ProgressLocation.Notification,
                title: localize(
                    'info.download',
                    "Downloading {0}:{1} into {2}",
                    srcUri.authority,
                    srcUri.path,
                    dstFolderUri.fsPath
                )
            },
            async (
                progress: vscode.Progress<{ increment: number; message: string }>,
                token: vscode.CancellationToken
            ): Promise<DstInfo | undefined> => {
                const basename: string = path.posix.basename(srcUri.path);
                const dstPath: string = path.join(dstFolderUri.fsPath, basename);
                if (await fs.pathExists(dstPath)) {
                    const choice: string | undefined = await vscode.window.showWarningMessage(
                        localize(
                            'info.download.alreadyExist',
                            "'{0}' already exists in '{1}'!",
                            basename,
                            dstFolderUri.fsPath
                        ),
                        { modal: true },
                        localize('action.overwrite', "Overwrite")
                    );
                    if (choice === localize('action.overwrite', "Overwrite")) {
                        await fs.remove(dstPath);
                    } else {
                        return undefined;
                    }
                }

                return this._connPool.withConn<DstInfo | undefined>(
                    srcUri.authority,
                    async (conn: Conn): Promise<DstInfo | undefined> => {
                        const output: string = await utils.exec(
                            conn.client,
                            `set -euo pipefail
                            stat -L --printf='%A ' '${srcUri.path}'
                            find -H '${srcUri.path}' -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum }'`
                        );

                        const tokens: string[] = output.split(' ');
                        const type: vscode.FileType = utils.getFileType(tokens[0]);
                        const size: number = parseFloat(tokens[1]);

                        const speedSummary: SpeedSummary = new SpeedSummary(size, progress);

                        if (type === vscode.FileType.Directory) {
                            await this._downloadFolder(conn, srcUri.path, '', dstPath, speedSummary, token);
                        } else if (type === vscode.FileType.File) {
                            await this._downloadFile(conn, srcUri.path, '', dstPath, speedSummary, token);
                        } else {
                            throw new Error(localize('error.fileType.unknown', "Unknown FileType"));
                        }

                        if (token.isCancellationRequested) {
                            await fs.remove(dstPath);

                            return undefined;
                        } else {
                            return { uri: vscode.Uri.file(dstPath), type };
                        }
                    },
                    undefined
                );
            }
        );
    }

    public async upload(srcUri: vscode.Uri, dstFolderUri: vscode.Uri): Promise<DstInfo | undefined> {
        return vscode.window.withProgress<DstInfo | undefined>(
            {
                cancellable: true,
                location: vscode.ProgressLocation.Notification,
                title: localize(
                    'info.upload',
                    "Uploading {0} into {1}:{2}",
                    srcUri.fsPath, dstFolderUri.authority, dstFolderUri.path)
            },
            async (
                progress: vscode.Progress<{ increment: number; message: string }>,
                token: vscode.CancellationToken
            ): Promise<DstInfo | undefined> => {
                const basename: string = path.basename(srcUri.fsPath);
                const dstPath: string = path.join(dstFolderUri.path, basename);

                return this._connPool.withConn<DstInfo | undefined>(
                    dstFolderUri.authority,
                    async (conn: Conn): Promise<DstInfo | undefined>  => {
                        const output: string = await utils.exec(
                            conn.client,
                            `if [ -e '${dstPath}' ]
                            then
                                echo exists
                            fi`
                        );
                        if (output === 'exists') {
                            const choice: string | undefined = await vscode.window.showWarningMessage(
                                localize(
                                    'info.upload.alreadyExist',
                                    "'{0}' already exists in '{1}:{2}'!",
                                    basename,
                                    dstFolderUri.authority,
                                    dstFolderUri.path
                                ),
                                { modal: true },
                                localize('action.overwrite', "Overwrite")
                            );
                            if (choice === localize('action.overwrite', "Overwrite")) {
                                await utils.exec(conn.client, `rm -fr '${dstPath}'`);
                            } else {
                                return undefined;
                            }
                        }

                        const { type, size }: {
                            type: vscode.FileType;
                            size: number;
                        } = await this._getUploadTypeAndSize(srcUri.fsPath);

                        const speedSummary: SpeedSummary = new SpeedSummary(size, progress);

                        if (type === vscode.FileType.Directory) {
                            await this._uploadFolder(conn, srcUri.fsPath, '', dstPath, speedSummary, token);
                        } else if (type === vscode.FileType.File) {
                            await this._uploadFile(conn, srcUri.fsPath, '', dstPath, speedSummary, token);
                        } else {
                            throw new Error(localize('error.fileType.unknown', "Unknown FileType"));
                        }

                        if (token.isCancellationRequested) {
                            await utils.exec(conn.client, `rm -fr '${dstPath}'`);

                            return undefined;
                        } else {
                            return { uri: dstFolderUri.with({ path: dstPath }), type };
                        }
                    },
                    undefined
                );
            }
        );
    }
}
