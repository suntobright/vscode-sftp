'use strict';

import { isNil } from 'lodash';
import * as ssh from 'ssh2';
import * as nls from 'vscode-nls';

import { Config, ConfigMap } from './ConfigMap';
import * as consts from './constants';
import * as utils from './utils';

export interface Conn {
    client: ssh.Client;
    sftp: ssh.SFTPWrapper;
}

interface ConnQueue {
    conns: Conn[];
    count: number;
}

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

async function sleep(delay: number): Promise<void> {
    await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, delay);
    });
}

export class ConnPool {

    private readonly _configMap: ConfigMap;
    private readonly _connPool: { [authority: string]: ConnQueue };

    private async _getConn(authority: string): Promise<Conn> {
        let connQueue: ConnQueue = this._connPool[authority];
        if (isNil(connQueue)) {
            this._connPool[authority] = connQueue = { conns: [], count: 0 };
        }
        let conn: Conn | undefined = connQueue.conns.pop();

        while (isNil(conn)) {
            if (connQueue.count < consts.maxConnCount) {
                const config: Config | undefined = this._configMap.get(authority);
                if (isNil(config)) {
                    throw new Error(localize('error.config.notFound', "Configuration not found"));
                }

                connQueue.count ++;
                try {
                    conn = await utils.getConn(config);
                } catch (e) {
                    connQueue.count --;
                    throw e;
                }
            } else {
                await sleep(0);
                conn = connQueue.conns.pop();
            }
        }

        return conn;
    }

    public constructor(configMap: ConfigMap) {
        this._configMap = configMap;
        this._connPool = {};
    }

    public async withConn<T>(
        authority: string,
        callback: (conn: Conn) => Promise<T>,
        errorHandler: ((e: Error) => Promise<void>) | undefined
    ): Promise<T> {
        try {
            const conn: Conn = await this._getConn(authority);
            let isClosed: boolean = false;
            conn.client.once('close', () => { isClosed = true; });

            try {
                const value: T = await callback(conn);

                return value;
            } catch (e) {
                if (e.message.includes('Not connected')) {
                    isClosed = true;
                }
                throw e;
            } finally {
                if (!isClosed) {
                    conn.client.removeAllListeners();
                    this._connPool[authority].conns.push(conn);
                } else {
                    this._connPool[authority].count --;
                }
            }
        } catch (e) {
            if (!isNil(errorHandler)) {
                await errorHandler(e);
            }
            throw e;
        }
    }

    public pushConn(authority: string, conn: Conn): void {
        const connQueue: ConnQueue = this._connPool[authority];
        if (isNil(connQueue)) {
            this._connPool[authority] = { conns: [conn], count: 1 };
        } else {
            connQueue.count ++;
            connQueue.conns.push(conn);
        }
    }

    public async dispose(): Promise<void> {
        Object.keys(this._connPool).forEach(async (authority: string) => {
            try {
                await this.withConn(
                    authority,
                    async (conn: Conn) => utils.exec(conn.client, `rm -fr '${consts.remoteTempFolder}'`),
                    undefined
                );
            } catch (e) {
                // pass
            }

            this._connPool[authority].conns.forEach((conn: Conn) => conn.client.end());
        });
    }
}
