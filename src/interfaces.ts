'use strict';

import * as ssh from 'ssh2';

export interface Config {
    comment: string;
    host: string;
    port?: number;
    username: string;
    password?: string;
    passphrase?: string;
    privateKey?: Buffer;
    privateKeyFile?: string;
}

export interface ConfigMap {
    [authority: string]: Config | undefined;
}

export interface Conn {
    client: ssh.Client;
    sftp: ssh.SFTPWrapper;
}
