'use strict';

import * as vscode from 'vscode';

import * as consts from './constants';
import { Config } from './interfaces';

interface Configs {
    [authority: string]: Config;
}

export class ConfigMap {

    private readonly _globalState: vscode.Memento;

    private _getConfigs(): Configs {
        return this._globalState.get<Configs>(consts.configMapKey, {});
    }

    private async _setConfigs(configs: Configs): Promise<void> {
        await this._globalState.update(consts.configMapKey, configs);
    }

    public constructor(globalState: vscode.Memento) {
        this._globalState = globalState;
    }

    public async clear(): Promise<void> {
        await this._setConfigs({});
    }

    public get(authority: string): Config | undefined {
        const configs: Configs = this._getConfigs();

        return configs[authority];
    }

    public getAuthorities(): string[] {
        return Object.keys(this._getConfigs());
    }

    public async remove(authority: string): Promise<void> {
        const configs: Configs = this._getConfigs();
        // tslint:disable-next-line:no-dynamic-delete
        delete configs[authority];

        await this._setConfigs(configs);
    }

    public async set(authority: string, config: Config): Promise<void> {
        const configs: Configs = this._getConfigs();
        configs[authority] = config;

        await this._setConfigs(configs);
    }
}
