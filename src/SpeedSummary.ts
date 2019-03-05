'use strict';

import * as bytes from 'bytes';
import { isEmpty } from 'lodash';
import { TransformOptions } from 'stream';
import * as vscode from 'vscode';

export class SpeedSummary implements TransformOptions {

    private readonly totalSize: number;

    private curBatchSize: number;
    private completeSize: number;

    private lastPercent: number;
    private lastSpeed: number;
    private lastSpeedUpdatedTime: number;
    private lastReportTime: number;

    private curFile: string;
    private curFileChanged: boolean;

    private readonly progress: vscode.Progress<{ increment?: number; message?: string }>;

    private shouldReport(): boolean {
        const now: number = Date.now();

        return (now - this.lastReportTime > 100)
            && (this.curFileChanged || this.getIncrement() > 0 || now - this.lastSpeedUpdatedTime > 1000);
    }

    private getIncrement(): number {
        return Math.floor((this.completeSize / this.totalSize) * 100) - this.lastPercent;
    }

    private getSpeed(): number {
        const now: number = Date.now();
        let speed: number = this.lastSpeed;
        if (speed === 0 || now - this.lastSpeedUpdatedTime > 1000) {
            speed = this.curBatchSize / (now - this.lastSpeedUpdatedTime) * 1000;
            this.curBatchSize = 0;
            this.lastSpeedUpdatedTime = now;

            this.lastSpeed = speed;
        }

        return speed;
    }

    public constructor(totalSize: number, progress: vscode.Progress<{ increment?: number; message?: string }>) {
        this.totalSize = totalSize;

        this.curBatchSize = 0;
        this.completeSize = 0;

        this.lastPercent = 0;
        this.lastSpeed = 0;
        this.lastSpeedUpdatedTime = Date.now();
        this.lastReportTime = 0;

        this.curFile = '';
        this.curFileChanged = false;

        this.progress = progress;

        this.transform = this.transform.bind(this);
    }

    public setCurFile(file: string): void {
        this.curFile = file;
        this.curFileChanged = true;
    }

    // tslint:disable-next-line:ban-types
    public transform(chunk: string | Buffer, _encoding: string, callback: Function): void {
        this.curBatchSize += chunk.length;
        this.completeSize += chunk.length;
        if (this.shouldReport()) {
            this.progress.report({
                increment: this.getIncrement(),
                message: isEmpty(this.curFile)
                    ? `${bytes(this.getSpeed(), { fixedDecimals: true })}/s`
                    : `${bytes(this.getSpeed(), { fixedDecimals: true })}/s ${this.curFile}`
            });
            this.lastPercent += this.getIncrement();
            this.lastReportTime = Date.now();
            this.curFileChanged = false;
        }

        //tslint:disable-next-line:no-null-keyword
        callback(null, chunk);
    }
}
