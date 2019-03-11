'use strict';

import { isEmpty } from 'lodash';
import { Readable, Writable } from 'stream';

export class BufferReadableStream extends Readable {

    private _content: Uint8Array;

    public constructor(content: Uint8Array) {
        super();

        this._content = content;
    }

    public _read(size: number): void {
        if (isEmpty(this._content)) {
            // tslint:disable-next-line:no-null-keyword
            this.push(null);

            return;
        }

        let chunk: Uint8Array;
        do {
            chunk = this._content.slice(0, size);
            this._content = this._content.slice(size);
        } while (this.push(chunk) && !isEmpty(this._content));
    }
}

export class BufferWritableStream extends Writable {

    private readonly _content: Buffer[];

    public constructor() {
        super();

        this._content = [];
    }

    // tslint:disable-next-line:ban-types
    public _write(chunk: Buffer, _encoding: string, callback: Function): void {
        this._content.push(chunk);

        callback();
    }

    // tslint:disable-next-line:ban-types
    public _final(callback: Function): void {
        this.destroy();
        callback();
    }

    public getData(): Uint8Array {
        return Buffer.concat(this._content);
    }
}
