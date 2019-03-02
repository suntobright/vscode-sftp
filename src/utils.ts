'use strict';

import { isNil } from 'lodash';
import * as pEvent from 'p-event';
import * as ssh from 'ssh2';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import * as consts from './constants';
import { Config, Conn } from './interfaces';

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export function getFileType(fileTypeDesc: string): vscode.FileType {
    switch (fileTypeDesc.charAt(0)) {
        case 'd':
            return vscode.FileType.Directory;
        case '-':
            return vscode.FileType.File;
        case 'l':
            return vscode.FileType.SymbolicLink;
        default:
            return vscode.FileType.Unknown;
    }
}

export async function getConn(config: Config): Promise<Conn> {
    const client: ssh.Client = new ssh.Client();
    try {
        client.connect(config);
        await pEvent(client, 'ready');

        const sftp: ssh.SFTPWrapper = await promisify<ssh.SFTPWrapper>(client, client.sftp.bind(client));

        return { client, sftp };
    } catch (e) {
        client.end();
        throw new Error(localize('error.config.connectFailed', "Connecting failed, {0}", e.toString()));
    }
}

// tslint:disable-next-line:ban-types
export async function promisify<T>(client: ssh.Client, method: Function, ...args: string[]): Promise<T> {
    return new Promise<T>((resolve: (val: T) => void, reject: (e: Error) => void): void => {
        const shouldContinue: boolean = method(...args, async (e: Error, val: T) => {
            if (!shouldContinue) {
                await pEvent(client, 'continue');
            }
            isNil(e) ? resolve(val) : reject(e);
        });
    });
}

export async function retrieveOutput(channel: ssh.ClientChannel): Promise<string> {
    return new Promise<string>((resolve: (output: string) => void, reject: (e: Error) => void): void => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        channel.on('data', (chunk: Buffer) => { stdout.push(chunk); });
        channel.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
        channel.on('close', (status: number) => {
            if (status === consts.ok) {
                resolve(Buffer.concat(stdout).toString().slice(0, -1));
            } else {
                reject(new Error(Buffer.concat(stderr).toString()));
            }
        });

        channel.end();
    });
}
