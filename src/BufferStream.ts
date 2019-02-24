'use strict';

import { isEmpty } from 'lodash';
import { Readable } from 'stream';

export class BufferStream extends Readable {

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
