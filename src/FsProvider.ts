'use strict';

import { isEmpty, isNil } from 'lodash';
import * as match from 'multimatch';
import * as path from 'path';
import * as ssh from 'ssh2';
import { Stats } from 'ssh2-streams';
import { Readable, Transform, Writable } from 'stream';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import { BufferStream } from './BufferStream';
import { ConnPool } from './ConnPool';
import * as consts from './constants';
import { Conn } from './interfaces';
import { SpeedSummary } from './SpeedSummary';
import * as utils from './utils';

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

function getFileChangeType(desc: string): vscode.FileChangeType {
    switch (desc) {
        case 'deleted':
            return vscode.FileChangeType.Deleted;
        case 'created':
            return vscode.FileChangeType.Created;
        case 'changed':
            return vscode.FileChangeType.Changed;
        default:
            throw new Error(localize('error.fileChangeType.unknown', "Unknown FileChangeType"));
    }
}

export class FsProvider implements vscode.FileSystemProvider {

    private readonly _connPool: ConnPool;
    private readonly _emitter: vscode.EventEmitter<vscode.FileChangeEvent[]>;
    private readonly _watchedFolders: string[];

    private async _watchInit(
        uri: vscode.Uri,
        recursive: boolean,
        errorHandler: (e: Error) => Promise<void>
    ): Promise<string> {
        return this._connPool.withConn<string>(
            uri.authority,
            async (conn: Conn): Promise<string> => {
                const tempDir: string = path.posix.join(consts.remoteTempFolder, uri.path.replace(/\//g, '\\\\'));
                const rOpt: string = recursive ? '' : '-maxdepth 1';

                const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
                    conn.client,
                    conn.client.exec.bind(conn.client),
                    `set -euo pipefail
                    date --rfc-3339=ns
                    mkdir -p ${tempDir}
                    cd ${tempDir}
                    rm -f *
                    cat > watch.sh << EOF
                    set -euo pipefail
                    timestamp=\\$(date --rfc-3339=ns)
                    echo \\$timestamp
                    > created
                    find -L ${uri.path} ${rOpt} -type d -newermt "\\$1" ! -newermt "\\$timestamp" |
                    while read dir; do
                        old=\\\${dir//\\\\//\\\\\\\\}
                        if [ -e \\$old ]; then
                            echo \\$dir changed
                            find -L \\$dir -maxdepth 1 -fprint new
                            sort \\$old new new | uniq -u |
                            while read deleted; do
                                echo \\$deleted deleted
                                rm "\\\${deleted//\\\\//\\\\\\\\}"* || true
                            done
                            sort \\$old \\$old new | uniq -u > created
                            mv new \\$old
                        fi
                    done
                    find -L ${uri.path} ${rOpt} ! -type d -newermt "\\$1" ! -newermt "\\$timestamp" > changed
                    sort created created changed | uniq -u |
                    while read file; do
                        dir=\\\${file%/*}
                        if [ -e \\\${dir//\\\\//\\\\\\\\} ]; then
                            echo \\$file changed
                        fi
                    done
                    cat created | sed 's/$/ created/'\nEOF\n`
                );

                return utils.retrieveOutput(channel);
            },
            errorHandler
        );
    }

    private async _watchInternal(
        uri: vscode.Uri,
        timestamp: string,
        excludes: string[],
        errorHandler: (e: Error) => Promise<void>
    ): Promise<string> {
        return this._connPool.withConn<string>(
            uri.authority,
            async (conn: Conn): Promise<string> => {
                const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
                    conn.client,
                    conn.client.exec.bind(conn.client),
                    `set -euo pipefail
                    cd ${path.posix.join(consts.remoteTempFolder, uri.path.replace(/\//g, '\\\\'))}
                    bash watch.sh '${timestamp}'`
                );
                const output: string = await utils.retrieveOutput(channel);

                let newTimestamp: string = '';
                let fileChangeEventList: vscode.FileChangeEvent[] = [];
                for (const line of output.split('\n')) {
                    if (isEmpty(newTimestamp)) {
                        newTimestamp = line;
                        continue;
                    }
                    const tokens: string[] = line.split(' ');
                    fileChangeEventList.push({
                        uri: vscode.Uri.parse(`${consts.scheme}://${uri.authority}${tokens[0]}`),
                        type: getFileChangeType(tokens[1])
                    });
                }

                if (!isEmpty(fileChangeEventList) && !isNil(excludes)) {
                    const changedFiles: string[] = fileChangeEventList.map(
                        (f: vscode.FileChangeEvent) => f.uri.path
                    );
                    const excludeFiles: string[] = match(changedFiles, excludes);
                    if (!isEmpty(excludeFiles)) {
                        fileChangeEventList = fileChangeEventList.filter(
                            (f: vscode.FileChangeEvent) => excludeFiles.indexOf(f.uri.path) < 0
                        );
                    }
                }

                if (!isEmpty(fileChangeEventList)) {
                    this._emitter.fire(fileChangeEventList);
                }

                return newTimestamp;
            },
            async (e: Error) => {
                if (!e.message.includes('No such file or directory') || !e.message.includes(uri.path)) {
                    void errorHandler(e);
                }
            }
        );
    }

    public constructor(connPool: ConnPool) {
        this._connPool = connPool;
        this._emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        this._watchedFolders = [];
    }

    public get onDidChangeFile(): vscode.Event<vscode.FileChangeEvent[]> {
        return this._emitter.event;
    }

    public async createDirectory(uri: vscode.Uri): Promise<void> {
        await this._connPool.withConn(
            uri.authority,
            async (conn: Conn) => utils.promisify(conn.client, conn.sftp.mkdir.bind(conn.sftp), uri.path),
            async (e: Error) => {
                void vscode.window.showErrorMessage(
                    localize(
                        'info.createDirectory.failed',
                        "Creating directory {0}:{1} failed, {2}",
                        uri.authority,
                        uri.path,
                        e.toString()
                    )
                );
            }
        );
    }

    public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        await this._connPool.withConn(
            uri.authority,
            async (conn: Conn) => {
                const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
                    conn.client,
                    conn.client.exec.bind(conn.client),
                    `rm -f${options.recursive ? 'r' : ''} ${uri.path}`
                );

                await utils.retrieveOutput(channel);
            },
            async (e: Error) => {
                void vscode.window.showErrorMessage(
                    localize(
                        'info.delete.failed',
                        "Deleting file {0}:{1} failed, {2}",
                        uri.authority,
                        uri.path,
                        e.toString()
                    )
                );
            }
        );
    }

    public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        return this._connPool.withConn<[string, vscode.FileType][]>(
            uri.authority,
            async (conn: Conn): Promise<[string, vscode.FileType][]> => {
                const extraCmd: string = this._watchedFolders.filter(
                    (folder: string) => uri.path.startsWith(folder)
                ).map(
                    (folder: string) =>
                        `cd ${path.posix.join(consts.remoteTempFolder, folder.replace(/\//g, '\\\\'))} &&
                        find -L ${uri.path} -maxdepth 1 -fprint ${uri.path.replace(/\//g, '\\\\')}`
                ).join('\n');

                const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
                    conn.client,
                    conn.client.exec.bind(conn.client),
                    `${extraCmd}
                    set -euo pipefail
                    ls -AHLo --time-style=+ ${uri.path} |
                    while read type refCount user size file
                    do
                        if [ $type != total ]
                        then
                            if [ -L ${uri.path}/$file ]
                            then
                                echo $type $file symbolicLink
                            else
                                echo $type $file
                            fi
                        fi
                    done`
                );
                const output: string = await utils.retrieveOutput(channel);
                if (isEmpty(output)) {
                    return [];
                }

                const results: [string, vscode.FileType][] = [];
                for (const line of output.split('\n')) {
                    const tokens: string[] = line.split(' ');
                    let fileType: vscode.FileType = utils.getFileType(tokens[0]);
                    if (fileType !== vscode.FileType.Unknown && tokens[2] === 'symbolicLink') {
                        fileType |= vscode.FileType.SymbolicLink;
                    }

                    results.push([tokens[1], fileType]);
                }

                return results;
            },
            async (e: Error) => {
                void vscode.window.showErrorMessage(
                    localize(
                        'info.readDirectory.failed',
                        "Reading directory {0}:{1} failed, {2}",
                        uri.authority,
                        uri.path,
                        e.toString()
                    )
                );
            }
        );
    }

    public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return this._connPool.withConn<Uint8Array>(
            uri.authority,
            async (conn: Conn): Promise<Uint8Array> => {
                return vscode.window.withProgress<Uint8Array>(
                    {
                        cancellable: true,
                        location: vscode.ProgressLocation.Notification,
                        title: localize('info.readFile', "Reading file {0}:{1} ...", uri.authority, uri.path)
                    },
                    async (
                        progress: vscode.Progress<{ increment: number; message: string }>,
                        token: vscode.CancellationToken
                    ): Promise<Uint8Array> => {
                        const stats: Stats = await utils.promisify<Stats>(
                            conn.client,
                            conn.sftp.stat.bind(conn.sftp),
                            uri.path
                        );

                        const speedSummary: SpeedSummary = new SpeedSummary(stats.size, progress);
                        const transform: Transform = new Transform(speedSummary);
                        const remote: Readable = conn.sftp.createReadStream(uri.path);

                        return new Promise<Uint8Array>(
                            (resolve: (content: Uint8Array) => void, reject: (e: Error) => void): void => {
                                let error: Error;
                                const data: Buffer[] = [];
                                const cancelHandler: vscode.Disposable = token.onCancellationRequested(() => {
                                    remote.destroy();
                                });
                                remote.once('error', (e: Error) => {
                                    error = e;
                                    transform.end();
                                });
                                transform.on('data', (chunk: Buffer) => {
                                    data.push(chunk);
                                });
                                transform.once('finish', () => {
                                    cancelHandler.dispose();
                                    isNil(error) ? resolve(Buffer.concat(data)) : reject(error);
                                });

                                remote.pipe(transform);
                            }
                        );
                    }
                );
            },
            async (e: Error) => {
                void vscode.window.showErrorMessage(
                    localize(
                        'info.readFile.failed',
                        "Reading file {0}:{1} failed, {2}",
                        uri.authority,
                        uri.path,
                        e.toString()
                    )
                );
            }
        );
    }

    public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        if (oldUri.path === newUri.path) {
            return;
        }

        try {
            if (oldUri.authority !== newUri.authority) {
                throw new Error(localize('error.authority.different', "Authorities different"));
            }

            await this._connPool.withConn(
                oldUri.authority,
                async (conn: Conn) => {
                    if (options.overwrite) {
                        await this.delete(newUri, { recursive: true });
                    }

                    await utils.promisify(conn.client, conn.sftp.rename.bind(conn.sftp), oldUri.path, newUri.path);
                },
                undefined
            );
        } catch (e) {
            void vscode.window.showErrorMessage(
                localize(
                    'info.rename.failed',
                    "Renaming file {0}:{1} to {2}:{3} failed, {4}",
                    oldUri.authority,
                    oldUri.path,
                    newUri.authority,
                    newUri.path,
                    e.toString()
                )
            );
            throw e;
        }
    }

    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return this._connPool.withConn<vscode.FileStat>(
            uri.authority,
            async (conn: Conn): Promise<vscode.FileStat> => {
                const channel: ssh.ClientChannel = await utils.promisify<ssh.ClientChannel>(
                    conn.client,
                    conn.client.exec.bind(conn.client),
                    `set -euo pipefail
                    stat -L --printf='%A %s %Y %Z ' ${uri.path}
                    if [ -L ${uri.path} ]
                    then
                        echo symbolicLink
                    fi`
                );
                const output: string = await utils.retrieveOutput(channel);

                const tokens: string[] = output.split(' ');
                let fileType: vscode.FileType = utils.getFileType(tokens[0]);
                if (fileType !== vscode.FileType.Unknown && tokens[4] === 'symbolicLink') {
                    fileType |= vscode.FileType.SymbolicLink;
                }

                return {
                    ctime: parseFloat(tokens[3]),
                    mtime: parseFloat(tokens[2]),
                    size: parseFloat(tokens[1]),
                    type: fileType
                };
            },
            async (e: Error) => {
                if (!e.message.includes('No such file')) {
                    void vscode.window.showErrorMessage(
                        localize(
                            'info.stat.failed',
                            "Stating {0}:{1} failed, {2}",
                            uri.authority,
                            uri.path,
                            e.toString()
                        )
                    );
                }
            }
        );
    }

    public watch(uri: vscode.Uri, options: { excludes: string[]; recursive: boolean }): vscode.Disposable {
        this._watchedFolders.push(uri.path);

        async function errorHandler(e: Error): Promise<void> {
            void vscode.window.showWarningMessage(
                localize('info.watch.warning', "Watching {0}:{1} failed, {2}", uri.authority, uri.path, e.toString())
            );
        }

        let needWatch: boolean = true;
        let timeoutId: NodeJS.Timer;
        let timestamp: string;
        let watchInterval: number = consts.watchMinInterval;
        const doWatch: () => void = async (): Promise<void> => {
            try {
                timestamp = isEmpty(timestamp)
                    ? await this._watchInit(uri, options.recursive, errorHandler)
                    : await this._watchInternal(uri, timestamp, options.excludes, errorHandler);
                watchInterval = consts.watchMinInterval;
            } catch (e) {
                watchInterval *= 2;
                if (watchInterval > consts.watchMaxInterval) {
                    watchInterval = consts.watchMaxInterval;
                }
                if (e.message.includes('No such file') && e.message.includes(consts.remoteTempFolder)) {
                    await this._watchInit(uri, options.recursive, errorHandler);
                    await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
                }
                throw e;
            } finally {
                if (needWatch) {
                    timeoutId = setTimeout(doWatch, watchInterval);
                }
            }
        };
        timeoutId = setTimeout(doWatch, 0);

        return new vscode.Disposable((): void => {
            clearTimeout(timeoutId);
            needWatch = false;
        });
    }

    public async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        await this._connPool.withConn(
            uri.authority,
            async (conn: Conn): Promise<void> => {
                await vscode.window.withProgress<void>(
                    {
                        cancellable: true,
                        location: vscode.ProgressLocation.Notification,
                        title: localize('info.writeFile', "Writing file {0}:{1} ...", uri.authority, uri.path)
                    },
                    async (
                        progress: vscode.Progress<{ increment: number; message: string }>,
                        token: vscode.CancellationToken
                    ): Promise<void> => {
                        let openFlags: string = 'w';
                        if (!options.create) {
                            openFlags = 'r+';
                        }
                        if (!options.overwrite) {
                            openFlags = 'wx';
                        }
                        const remote: Writable = conn.sftp.createWriteStream(uri.path, { flags: openFlags });
                        const local: BufferStream = new BufferStream(content);

                        const speedSummary: SpeedSummary = new SpeedSummary(content.length, progress);
                        const transform: Transform = new Transform(speedSummary);

                        await new Promise<void>(
                            (resolve: () => void, reject: (e: Error) => void): void => {
                                let error: Error;
                                const cancelHandler: vscode.Disposable = token.onCancellationRequested(() => {
                                    local.destroy();
                                });
                                remote.once('error', (e: Error) => {
                                    error = e;
                                    local.destroy();
                                });
                                transform.once('finish', () => {
                                    cancelHandler.dispose();
                                    isNil(error) ? resolve() : reject(error);
                                });

                                local.pipe(transform).pipe(remote);
                            }
                        );
                    }
                );
            },
            async (e: Error) => {
                void vscode.window.showErrorMessage(
                    localize(
                        'info.writeFile.failed',
                        "Writing file {0}:{1} failed, {2}",
                        uri.authority,
                        uri.path,
                        e.toString()
                    )
                );
            }
        );
    }
}
