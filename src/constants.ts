'use strict';

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

export const configMapKey: string = 'configMap';
export const maxConnCount: number = 4;
export const localTempFolder: string = path.join(os.tmpdir(), 'vscode-sftp');
const md5: string = crypto.createHash('md5').update(
    `${process.env.COMPUTERNAME}${process.env.VSCODE_PID}`
).digest('hex');
export const remoteTempFolder: string = path.posix.join('/tmp', 'vscode-sftp', md5);
export const configFileName: string = 'sftpConfig.json';
export const defaultPort: number = 22;
export const scheme: string = 'sftp';
export const helpDocument: string = 'README.md';
export const watchMinInterval: number = 500;
export const watchMaxInterval: number = 10000;
export const ok: number = 0;
